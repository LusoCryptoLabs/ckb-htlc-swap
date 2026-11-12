// One swap between CKB (testnet, htlc-lock) and USDC (Train on Base Sepolia, or a local fork of it).
//
//   node swap.mjs usdc-first   Alice holds USDC and picks the secret. She locks USDC first (longer
//                              timeout), Bob locks CKB (shorter), Alice claims the CKB with the
//                              secret, Bob's watcher reads it from CKB and redeems the USDC.
//   node swap.mjs ckb-first    Bob holds CKB and picks the secret. He locks CKB first (longer),
//                              Alice locks USDC (shorter), Bob redeems the USDC with the secret,
//                              Alice's watcher reads it from the EVM event and claims the CKB.
//   node swap.mjs refund       Both lock, nobody reveals. Bob takes the CKB back after its
//                              timeout, Alice takes the USDC back after its timelock. Before each
//                              refund, the same refund is tried too early and must be refused.
//
// Alice: USDC on EVM, wants CKB. Bob: CKB, wants USDC. Each side checks the other's lock on chain
// before it locks or reveals anything.
import { ccc } from "@ckb-ccc/core";
import { ethers } from "ethers";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HERE, client, ckbSigner, sha256, deployment, htlcScript, cellDep, waitTx, medianTimeSec, MAX_FEE, SINCE_TS } from "./common.mjs";
import { FORK, EVM_RPC, CHAIN, SYMBOL, TRAIN, USDC, wallet, train, usdc, forkFund, forkWarp, evmNow, STATUS, fmtUsdc } from "./evm.mjs";

const MODE = process.argv[2] ?? "usdc-first";
const CKB_AMOUNT = ccc.fixedPointFrom(process.env.CKB_AMOUNT ?? "500");
const USDC_AMOUNT = BigInt(process.env.USDC_AMOUNT ?? "10000000"); // 10 USDC, 6 decimals
const LONG = Number(process.env.LONG_SEC ?? 7200);
const SHORT = Number(process.env.SHORT_SEC ?? 3600);
const MARGIN = 1200; // the side that learns the secret last keeps at least 20 min to use it
const d = deployment();
const log = { mode: MODE, evm: FORK ? `local fork of ${CHAIN}` : `${CHAIN} (${EVM_RPC})`, ckb: "testnet", started: new Date().toISOString(), steps: [] };
const step = (name, extra) => { log.steps.push({ name, ...extra }); console.log(`- ${name}`, extra ? JSON.stringify(extra, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : ""); };

const alice = { ckb: ckbSigner("alice"), evm: wallet("alice") };
const bob = { ckb: ckbSigner("bob"), evm: wallet("bob") };
const aliceLock = (await alice.ckb.getRecommendedAddressObj()).script;
const bobLock = (await bob.ckb.getRecommendedAddressObj()).script;

async function balances(label) {
  const [ac, bc, au, bu] = await Promise.all([
    alice.ckb.getBalance(), bob.ckb.getBalance(), usdc(alice.evm).balanceOf(alice.evm.address), usdc(bob.evm).balanceOf(bob.evm.address),
  ]);
  const b = { aliceCKB: ccc.fixedPointToString(ac), bobCKB: ccc.fixedPointToString(bc), [`alice${SYMBOL}`]: fmtUsdc(au), [`bob${SYMBOL}`]: fmtUsdc(bu) };
  step(`balances ${label}`, b);
  return b;
}

// ---------- EVM leg ----------
async function evmLock(hashlock, delta) {
  const t = train(alice.evm);
  const a = await (await usdc(alice.evm).approve(TRAIN, USDC_AMOUNT)).wait();
  const params = {
    hashlock: ethers.hexlify(hashlock), amount: USDC_AMOUNT, rewardAmount: 0n, timelockDelta: delta, rewardTimelockDelta: 0,
    quoteExpiry: (await evmNow()) + 600, recipient: bob.evm.address, refundTo: alice.evm.address, token: USDC,
    payoutCurve: ethers.ZeroAddress, payoutCurveData: "0x", rewardToken: "", rewardRecipient: "", srcChain: CHAIN,
  };
  const dst = { dstChain: "ckb-testnet", dstAddress: aliceLock.hash(), dstAmount: CKB_AMOUNT, dstToken: "CKB" };
  const r = await (await t.userLock(params, dst, "0x", "0x")).wait();
  step(`EVM: Alice locks ${SYMBOL} in Train for Bob`, { approve: a.hash, lock: r.hash, amount: fmtUsdc(USDC_AMOUNT) });
}

/** Bob's (or anyone's) check of the EVM lock before relying on it. Returns its timelock. */
async function checkEvmLock(hashlock) {
  const l = await train(bob.evm).getUserLock(ethers.hexlify(hashlock));
  const ok = STATUS[Number(l.status)] === "Pending" && l.token.toLowerCase() === USDC.toLowerCase() && l.amount === USDC_AMOUNT
    && l.recipient === bob.evm.address && l.payoutCurve === ethers.ZeroAddress;
  if (!ok) throw new Error(`EVM lock does not match the terms: ${l}`);
  step(`check: Train lock is Pending, ${SYMBOL}, amount, recipient Bob, no payout curve`, { timelock: Number(l.timelock) });
  return Number(l.timelock);
}

async function evmRedeem(hashlock, secret) {
  const r = await (await train(bob.evm).redeemUser(ethers.hexlify(hashlock), BigInt(ethers.hexlify(secret)))).wait();
  step(`EVM: Bob redeems the ${SYMBOL} with the secret`, { tx: r.hash });
  return r;
}

/** Alice's watcher: the secret from the UserRedeemed event of this hashlock. */
async function secretFromEvm(hashlock, fromBlock) {
  const t = train(alice.evm);
  for (let i = 0; i < 120; i++) {
    const ev = await t.queryFilter(t.filters.UserRedeemed(ethers.hexlify(hashlock)), fromBlock);
    if (ev.length) {
      const s = Buffer.from(ethers.toBeHex(ev[0].args.secret, 32).slice(2), "hex");
      if (!sha256(s).equals(Buffer.from(hashlock))) throw new Error("event secret does not hash to H");
      step("watcher: secret read from the Train UserRedeemed event", { evmTx: ev[0].transactionHash });
      return s;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("no UserRedeemed event");
}

// ---------- CKB leg ----------
async function ckbLock(hashlock, timeoutSec) {
  const lock = htlcScript(d, { hashlock, recipientLock: aliceLock, senderLock: bobLock, timeoutSec });
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: CKB_AMOUNT }], outputsData: ["0x"] });
  await tx.completeInputsByCapacity(bob.ckb);
  await tx.completeFeeBy(bob.ckb, 1000);
  const hash = await bob.ckb.sendTransaction(tx);
  await waitTx(hash, "htlc cell");
  const outPoint = { txHash: hash, index: 0 };
  step("CKB: Bob locks CKB in an htlc-lock cell for Alice", { outPoint: `${hash}:0`, ckb: ccc.fixedPointToString(CKB_AMOUNT), timeoutSec });
  return { lock, outPoint };
}

/** Alice's check of the CKB cell before she relies on it: exact lock, amount, no type, no data. */
async function checkCkbCell(htlc, hashlock, timeoutSec) {
  const cell = await client.getCellLive(htlc.outPoint, true);
  const want = htlcScript(d, { hashlock, recipientLock: aliceLock, senderLock: bobLock, timeoutSec });
  if (!cell || !cell.cellOutput.lock.eq(want) || cell.cellOutput.capacity !== CKB_AMOUNT || cell.cellOutput.type || cell.outputData !== "0x") {
    throw new Error("CKB cell does not match the terms");
  }
  step("check: CKB cell is live, exact lock args, amount, no type, no data");
}

const feeFor = (tx) => { const f = tx.estimateFee(1000n) * 3n; return f < 10000n ? 10000n : f; };

async function ckbClaim(htlc, secret) {
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: htlc.outPoint, since: 0 }],
    outputs: [{ lock: aliceLock, capacity: CKB_AMOUNT }],
    outputsData: ["0x"],
    cellDeps: [cellDep(d)],
  });
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: ccc.hexFrom(secret) }));
  const fee = feeFor(tx);
  if (fee > MAX_FEE) throw new Error("fee above max fee");
  tx.outputs[0].capacity = CKB_AMOUNT - fee;
  const hash = await client.sendTransaction(tx); // no signature: the secret is the key
  await waitTx(hash, "claim");
  step("CKB: Alice claims the CKB by revealing the secret (no signature)", { tx: hash, fee: fee.toString() });
  return hash;
}

/** Bob's watcher: find the transaction that spent the HTLC cell and read the secret from it. */
async function secretFromCkb(htlc, hashlock) {
  for (let i = 0; i < 120; i++) {
    const res = await fetch("https://testnet.ckb.dev/rpc", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_transactions", params: [{ script: { code_hash: htlc.lock.codeHash, hash_type: htlc.lock.hashType, args: htlc.lock.args },
        script_type: "lock", script_search_mode: "exact" }, "asc", "0x64"] }),
    }).then((r) => r.json());
    const spent = (res.result?.objects ?? []).find((o) => o.io_type === "input");
    if (spent) {
      const t = await client.getTransaction(spent.tx_hash);
      const idx = Number(spent.io_index);
      const w = ccc.WitnessArgs.fromBytes(t.transaction.witnesses[idx]);
      const s = Buffer.from(ccc.bytesFrom(w.lock ?? "0x"));
      if (s.length !== 32 || !sha256(s).equals(Buffer.from(hashlock))) throw new Error("spent without the secret (refund?)");
      step("watcher: secret read from the CKB claim witness", { ckbTx: spent.tx_hash });
      return s;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("HTLC cell not spent");
}

function refundTx(htlc, timeoutSec, sinceSec) {
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: htlc.outPoint, since: SINCE_TS | BigInt(sinceSec) }],
    outputs: [{ lock: bobLock, capacity: CKB_AMOUNT }],
    outputsData: ["0x"],
    cellDeps: [cellDep(d)],
  });
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({}));
  tx.outputs[0].capacity = CKB_AMOUNT - feeFor(tx);
  return tx;
}

/** The node's full verifier, nothing sent: test_tx_pool_accept through CCC. */
async function poolAccept(tx) {
  try {
    await client.sendTransactionDry(tx, "passthrough");
    return { accepted: true };
  } catch (e) {
    return { refused: String(e.message ?? e).slice(0, 220) };
  }
}

// ---------- runs ----------
const secret = crypto.randomBytes(32);
const H = sha256(secret);
step("terms", { hashlock: "0x" + H.toString("hex"), ckb: ccc.fixedPointToString(CKB_AMOUNT), evmChain: CHAIN, token: SYMBOL, amount: fmtUsdc(USDC_AMOUNT), htlcCode: d.dataHash, train: TRAIN });

if (FORK) {
  await forkFund(alice.evm.address, USDC_AMOUNT);
  await forkFund(bob.evm.address, 0n);
  step("fork: Alice gets 10 test USDC and gas ETH, Bob gets gas ETH");
}
const before = await balances("before");

if (MODE === "usdc-first") {
  // Alice knows the secret, so she locks first and with the longer timeout.
  await evmLock(H, LONG);
  const evmTimelock = await checkEvmLock(H);
  const ckbTimeout = Math.floor(Date.now() / 1000) + SHORT;
  if (evmTimelock - ckbTimeout < MARGIN) throw new Error("unsafe: EVM timelock does not outlast the CKB timeout");
  step("check: EVM timelock outlasts the CKB timeout", { marginSec: evmTimelock - ckbTimeout });
  const htlc = await ckbLock(H, ckbTimeout);
  await checkCkbCell(htlc, H, ckbTimeout);
  await ckbClaim(htlc, secret);
  const s = await secretFromCkb(htlc, H);
  await evmRedeem(H, s);
} else if (MODE === "ckb-first") {
  // Bob knows the secret, so he locks first and with the longer timeout.
  const ckbTimeout = Math.floor(Date.now() / 1000) + LONG;
  const htlc = await ckbLock(H, ckbTimeout);
  await checkCkbCell(htlc, H, ckbTimeout);
  const fromBlock = await alice.evm.provider.getBlockNumber();
  await evmLock(H, SHORT);
  const evmTimelock = await checkEvmLock(H);
  if (ckbTimeout - evmTimelock < MARGIN) throw new Error("unsafe: CKB timeout does not outlast the EVM timelock");
  step("check: CKB timeout outlasts the EVM timelock", { marginSec: ckbTimeout - evmTimelock });
  await evmRedeem(H, secret);
  const s = await secretFromEvm(H, fromBlock);
  await ckbClaim(htlc, s);
} else if (MODE === "refund") {
  const evmDelta = Number(process.env.EVM_DELTA ?? 1800);
  await evmLock(H, evmDelta);
  const evmTimelock = await checkEvmLock(H);
  const ckbTimeout = (await medianTimeSec()) + Number(process.env.CKB_WAIT ?? 120);
  const htlc = await ckbLock(H, ckbTimeout);
  // Too early: since at the timeout while the chain's median time is still below it.
  const early = await poolAccept(refundTx(htlc, ckbTimeout, ckbTimeout));
  step("control: CKB refund before the median time reaches the timeout", early);
  if (early.accepted) throw new Error("early refund was accepted");
  const tooLow = await poolAccept(refundTx(htlc, ckbTimeout, ckbTimeout - 1));
  step("control: same refund with since one second below the timeout (the node refuses it first; the lock's own check is in attacks.mjs)", tooLow);
  if (tooLow.accepted) throw new Error("since below timeout was accepted");
  while ((await medianTimeSec()) < ckbTimeout) await new Promise((r) => setTimeout(r, 10000));
  const ok = refundTx(htlc, ckbTimeout, ckbTimeout);
  const hash = await client.sendTransaction(ok);
  await waitTx(hash, "refund");
  step("CKB: Bob takes the CKB back after the timeout (no signature)", { tx: hash });
  // EVM side: refund before the timelock must revert; after it, anyone can refund to Alice.
  try {
    await train(alice.evm).refundUser.staticCall(ethers.hexlify(H));
    throw new Error("early EVM refund was accepted");
  } catch (e) {
    if (String(e.message).includes("was accepted")) throw e;
    const name = e.revert?.name ?? e.shortMessage ?? e.message.slice(0, 120);
    if (name !== "RefundNotAllowed") throw new Error(`early EVM refund failed for another reason: ${name}`);
    step("control: Train refund before the timelock reverts", { reason: name });
  }
  if (FORK) { await forkWarp(evmTimelock - (await evmNow()) + 1); step("fork: clock moved past the Train timelock"); }
  else while ((await evmNow()) <= evmTimelock) await new Promise((r) => setTimeout(r, 15000));
  const r = await (await train(alice.evm).refundUser(ethers.hexlify(H))).wait();
  step(`EVM: Alice takes the ${SYMBOL} back after the timelock`, { tx: r.hash });
} else {
  throw new Error(`unknown mode ${MODE}`);
}

const after = await balances("after");
log.finished = new Date().toISOString();
log.before = before;
log.after = after;
fs.mkdirSync(path.join(HERE, "..", "runs"), { recursive: true });
const file = path.join(HERE, "..", "runs", `${CHAIN}${FORK ? "-fork" : ""}-${MODE}-${log.started.replace(/[:.]/g, "")}.json`);
fs.writeFileSync(file, JSON.stringify(log, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log("run log:", file);
process.exit(0);
