// One swap between CKB (testnet, htlc-lock) and BTC (testnet3, a P2WSH script per swap).
// Alice holds CKB and wants BTC. Bob holds BTC and wants CKB.
//
//   node swap-btc.mjs fund        sends test sats from the funder key to Bob's Bitcoin address
//   node swap-btc.mjs btc-first   Bob picks the secret and locks BTC first (longer timeout),
//                                 Alice locks CKB (shorter), Bob claims the CKB with the secret,
//                                 Alice reads it from the CKB witness and claims the BTC.
//   node swap-btc.mjs ckb-first   Alice picks the secret and locks CKB first (longer), Bob locks
//                                 BTC (shorter), Alice claims the BTC with the secret, Bob reads it
//                                 from the Bitcoin witness and claims the CKB.
//   node swap-btc.mjs refund      Both lock, nobody reveals, and both take their coins back after
//                                 the timeouts. Controls on the Bitcoin script on the way: a wrong
//                                 secret, the right secret signed by the wrong key, a 33-byte
//                                 preimage (with and without the size check), a refund too early,
//                                 and a refund whose nLockTime is one below the script's.
//
// Each side checks the other's lock on its own chain before it locks or reveals anything. The
// timeouts are compared on each chain's own clock (median times), never on this machine's.
import { ccc } from "@ckb-ccc/core";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HERE, client, ckbSigner, sha256, deployment, htlcScript, medianTimeSec } from "./common.mjs";
import { btcKey, htlcPayment, btcMedianTime, waitConfirmations, broadcast, fundOutputs, spendHtlc, findHtlcOutput, secretFromBtc, api, BTC_CONF, BTC_API } from "./btc.mjs";
import { ckbLock, checkCkbCell, ckbClaim, secretFromCkb, refundTx, poolAccept } from "./ckbleg.mjs";

const MODE = process.argv[2] ?? "btc-first";
const CKB_AMOUNT = ccc.fixedPointFrom(process.env.CKB_AMOUNT ?? "300");
const SATS = Number(process.env.SATS ?? 10_000);
const LONG = Number(process.env.LONG_SEC ?? 24 * 3600);
const SHORT = Number(process.env.SHORT_SEC ?? 12 * 3600);
// The side that learns the secret last needs time to see it and to get a Bitcoin transaction
// confirmed. Three hours, also above the two hours a Bitcoin block's time may run ahead.
const MARGIN = Number(process.env.MARGIN_SEC ?? 3 * 3600);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = { mode: MODE, btc: BTC_API, ckb: "testnet", started: new Date().toISOString(), steps: [] };
const step = (name, extra) => { log.steps.push({ name, ...extra }); console.log(`- ${name}`, extra ? JSON.stringify(extra, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : ""); };

const alice = { ckb: ckbSigner("alice"), btc: btcKey("alice") };
const bob = { ckb: ckbSigner("bob"), btc: btcKey("bob") };
const aliceLock = (await alice.ckb.getRecommendedAddressObj()).script;
const bobLock = (await bob.ckb.getRecommendedAddressObj()).script;

async function btcBalance(k) {
  const a = await api(`/address/${k.address}`);
  return a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum + a.mempool_stats.funded_txo_sum - a.mempool_stats.spent_txo_sum;
}
async function balances(label) {
  const [ac, bc, ab, bb] = await Promise.all([alice.ckb.getBalance(), bob.ckb.getBalance(), btcBalance(alice.btc), btcBalance(bob.btc)]);
  const b = { aliceCKB: ccc.fixedPointToString(ac), bobCKB: ccc.fixedPointToString(bc), aliceSats: ab, bobSats: bb };
  step(`balances ${label}`, b);
  return b;
}

function save() {
  log.finished = new Date().toISOString();
  fs.mkdirSync(path.join(HERE, "..", "runs"), { recursive: true });
  const file = path.join(HERE, "..", "runs", `btc-testnet3-${MODE}-${log.started.replace(/[:.]/g, "")}.json`);
  fs.writeFileSync(file, JSON.stringify(log, (_, v) => (typeof v === "bigint" ? v.toString() : (Buffer.isBuffer(v) ? v.toString("hex") : v)), 2));
  console.log("run log:", file);
}

if (MODE === "fund") {
  const funder = btcKey(process.env.BTC_FUNDER_KEY ?? "./keys/btc-funder.key");
  const sats = Number(process.env.FUND_SATS ?? 40_000);
  const tx = await fundOutputs(funder, [{ script: bob.btc.output, value: sats }]);
  const r = await broadcast(tx);
  if (!r.txid) throw new Error(r.refused);
  step("fund: test sats to Bob's Bitcoin address", { sats, to: bob.btc.address, tx: r.txid });
  await waitConfirmations(r.txid, 1, "fund");
  process.exit(0);
}

const d = deployment();
const secret = crypto.randomBytes(32);
const H = sha256(secret);
step("terms", { hashlock: "0x" + H.toString("hex"), ckb: ccc.fixedPointToString(CKB_AMOUNT), sats: SATS, htlcCode: d.dataHash, btcConfirmations: BTC_CONF });
const before = await balances("before");

/** Bob locks BTC for Alice. Returns what both sides need to check and spend it. */
async function btcLock(hashlock, locktime, extra = []) {
  const pay = htlcPayment({ hashlock, recipientPub: alice.btc.pubkey, senderPub: bob.btc.pubkey, locktime });
  const tx = await fundOutputs(bob.btc, [{ script: pay.output, value: SATS }, ...extra.map((e) => ({ script: e.pay.output, value: e.value }))]);
  const r = await broadcast(tx);
  if (!r.txid) throw new Error(`BTC lock refused: ${r.refused}`);
  step("BTC: Bob locks sats in the swap script for Alice", { tx: r.txid, address: pay.address, sats: SATS, locktime });
  return { pay, txid: r.txid, locktime };
}

/** Alice's check of Bob's BTC lock: the exact script for these terms, the amount, confirmations. */
async function checkBtcLock(lockInfo, hashlock) {
  const pay = htlcPayment({ hashlock, recipientPub: alice.btc.pubkey, senderPub: bob.btc.pubkey, locktime: lockInfo.locktime });
  await waitConfirmations(lockInfo.txid, BTC_CONF, "BTC lock");
  const outpoint = await findHtlcOutput(lockInfo.txid, pay, SATS);
  step(`check: Bitcoin output pays the agreed script and amount, ${BTC_CONF} confirmation(s)`, { outpoint: `${outpoint.txid}:${outpoint.vout}` });
  return { pay, outpoint };
}

async function remaining() {
  const [b, c] = await Promise.all([btcMedianTime(), medianTimeSec()]);
  return { btcNow: b, ckbNow: c };
}

if (MODE === "btc-first") {
  // Bob knows the secret, so he locks first and with the longer timeout.
  const { btcNow } = await remaining();
  const lk = await btcLock(H, btcNow + LONG);
  const { pay, outpoint } = await checkBtcLock(lk, H);
  const { btcNow: b2, ckbNow } = await remaining();
  const ckbTimeout = ckbNow + SHORT;
  const margin = (lk.locktime - b2) - (ckbTimeout - ckbNow);
  if (margin < MARGIN) throw new Error(`unsafe: the BTC lock outlasts the CKB lock by ${margin} s only`);
  step("check: the BTC lock outlasts the CKB lock, each on its own chain's clock", { marginSec: margin });
  const terms = { hashlock: H, recipientLock: bobLock, senderLock: aliceLock, timeoutSec: ckbTimeout };
  const htlc = await ckbLock(d, alice.ckb, { ...terms, amount: CKB_AMOUNT });
  step("CKB: Alice locks CKB in an htlc-lock cell for Bob", { outPoint: `${htlc.outPoint.txHash}:0`, timeoutSec: ckbTimeout });
  await checkCkbCell(d, htlc.outPoint, terms, CKB_AMOUNT);
  step("check: CKB cell is live, exact lock args, amount, no type, no data");
  const claim = await ckbClaim(d, htlc.outPoint, CKB_AMOUNT, secret, bobLock);
  step("CKB: Bob claims the CKB by revealing the secret (no signature)", { tx: claim });
  const seen = await secretFromCkb(htlc.lock, H);
  step("watcher: Alice reads the secret from the CKB claim witness", { ckbTx: seen.txHash });
  const tx = spendHtlc({ outpoint, value: SATS, pay, path: { secret: seen.secret }, signer: alice.btc.signer, to: alice.btc.output });
  const r = await broadcast(tx);
  if (!r.txid) throw new Error(`BTC claim refused: ${r.refused}`);
  step("BTC: Alice claims the sats with the secret and her signature", { tx: r.txid, vsize: tx.virtualSize() });
  await waitConfirmations(r.txid, 1, "BTC claim");
} else if (MODE === "ckb-first") {
  // Alice knows the secret, so she locks first and with the longer timeout.
  const { ckbNow } = await remaining();
  const ckbTimeout = ckbNow + LONG;
  const terms = { hashlock: H, recipientLock: bobLock, senderLock: aliceLock, timeoutSec: ckbTimeout };
  const htlc = await ckbLock(d, alice.ckb, { ...terms, amount: CKB_AMOUNT });
  step("CKB: Alice locks CKB in an htlc-lock cell for Bob", { outPoint: `${htlc.outPoint.txHash}:0`, timeoutSec: ckbTimeout });
  await checkCkbCell(d, htlc.outPoint, terms, CKB_AMOUNT);
  step("check: CKB cell is live, exact lock args, amount, no type, no data");
  const { btcNow, ckbNow: c2 } = await remaining();
  const locktime = btcNow + SHORT;
  const margin = (ckbTimeout - c2) - (locktime - btcNow);
  if (margin < MARGIN) throw new Error(`unsafe: the CKB lock outlasts the BTC lock by ${margin} s only`);
  step("check: the CKB lock outlasts the BTC lock, each on its own chain's clock", { marginSec: margin });
  const lk = await btcLock(H, locktime);
  const { pay, outpoint } = await checkBtcLock(lk, H);
  const tx = spendHtlc({ outpoint, value: SATS, pay, path: { secret }, signer: alice.btc.signer, to: alice.btc.output });
  const r = await broadcast(tx);
  if (!r.txid) throw new Error(`BTC claim refused: ${r.refused}`);
  step("BTC: Alice claims the sats with the secret and her signature", { tx: r.txid, vsize: tx.virtualSize() });
  const seen = await secretFromBtc(outpoint, H, sha256);
  step("watcher: Bob reads the secret from the Bitcoin claim witness (mempool)", { btcTx: seen.txid });
  const claim = await ckbClaim(d, htlc.outPoint, CKB_AMOUNT, seen.secret, bobLock);
  step("CKB: Bob claims the CKB with the secret (no signature)", { tx: claim });
  await waitConfirmations(r.txid, 1, "BTC claim");
} else if (MODE === "refund") {
  const CTRL = 2_000;
  const { btcNow, ckbNow } = await remaining();
  const locktime = btcNow + Number(process.env.BTC_WAIT ?? 600);
  // Size-rule controls: H33 is the hash of a 33-byte preimage. One script checks the size, one
  // (control only) does not; everything else is the same.
  const pre33 = crypto.randomBytes(33);
  const H33 = sha256(pre33);
  const guarded = htlcPayment({ hashlock: H33, recipientPub: alice.btc.pubkey, senderPub: bob.btc.pubkey, locktime });
  const unguarded = htlcPayment({ hashlock: H33, recipientPub: alice.btc.pubkey, senderPub: bob.btc.pubkey, locktime, sizeCheck: false });
  const lk = await btcLock(H, locktime, [{ pay: guarded, value: CTRL }, { pay: unguarded, value: CTRL }]);
  const outpoint = await findHtlcOutput(lk.txid, lk.pay, SATS);
  const pay = lk.pay;
  const gOut = await findHtlcOutput(lk.txid, guarded, CTRL);
  const uOut = await findHtlcOutput(lk.txid, unguarded, CTRL);

  // A control counts only when the node refuses it for the reason it tests: a network error or
  // another rule must not pass as a refusal.
  const tryBtc = async (name, tx, expect) => {
    const r = await broadcast(tx);
    const ok = expect instanceof RegExp ? Boolean(r.refused) && /RPC error/.test(r.refused) && expect.test(r.refused) : Boolean(r.txid);
    step(`control: ${name}`, { expect: String(expect), ...(r.txid ? { accepted: r.txid } : { refused: r.refused.slice(0, 220) }) });
    if (!ok) throw new Error(`control failed: ${name}`);
    return r;
  };
  const SIG = /Signature must be zero|false\/empty top stack|CHECKSIG/i;
  // The early refund first, spending the lock while it is still in the mempool, so the median
  // time cannot have passed the locktime yet.
  if ((await btcMedianTime()) >= locktime) throw new Error("median time already at the locktime: the early refund control is not possible");
  await tryBtc("refund before the median time passes the locktime", spendHtlc({ outpoint, value: SATS, pay, path: { refund: true }, signer: bob.btc.signer, to: bob.btc.output, locktime }), /non-final/);
  await tryBtc("claim with a wrong 32-byte secret", spendHtlc({ outpoint, value: SATS, pay, path: { secret: crypto.randomBytes(32) }, signer: alice.btc.signer, to: alice.btc.output }), /EQUALVERIFY/);
  await tryBtc("claim with the right secret signed by Bob, not the recipient", spendHtlc({ outpoint, value: SATS, pay, path: { secret }, signer: bob.btc.signer, to: bob.btc.output }), SIG);
  await tryBtc("claim the size-checked script with a 33-byte preimage of its hash", spendHtlc({ outpoint: gOut, value: CTRL, pay: guarded, path: { secret: pre33 }, signer: alice.btc.signer, to: alice.btc.output }), /EQUALVERIFY/);
  await tryBtc("same claim on the copy without the size check (control of the control)", spendHtlc({ outpoint: uOut, value: CTRL, pay: unguarded, path: { secret: pre33 }, signer: alice.btc.signer, to: alice.btc.output }), "accepted");
  await checkBtcLock(lk, H);

  // CKB: Alice locks, the early refund is refused, the refund after the timeout goes through.
  const ckbTimeout = (await medianTimeSec()) + Number(process.env.CKB_WAIT ?? 120);
  const terms = { hashlock: H, recipientLock: bobLock, senderLock: aliceLock, timeoutSec: ckbTimeout };
  const htlc = await ckbLock(d, alice.ckb, { ...terms, amount: CKB_AMOUNT });
  step("CKB: Alice locks CKB in an htlc-lock cell for Bob", { outPoint: `${htlc.outPoint.txHash}:0`, timeoutSec: ckbTimeout });
  const early = await poolAccept(refundTx(d, htlc.outPoint, CKB_AMOUNT, ckbTimeout, aliceLock));
  step("control: CKB refund before the median time reaches the timeout", early);
  if (early.accepted) throw new Error("early CKB refund was accepted");
  while ((await medianTimeSec()) < ckbTimeout) await sleep(10000);
  const ckbRefund = await client.sendTransaction(refundTx(d, htlc.outPoint, CKB_AMOUNT, ckbTimeout, aliceLock));
  await client.waitTransaction(ckbRefund, 0, 240_000);
  step("CKB: Alice takes the CKB back after the timeout (no signature)", { tx: ckbRefund });

  // BTC: wait until the median time is past the locktime (a time locktime is final once below it).
  const t0 = Date.now();
  while ((await btcMedianTime()) <= locktime) {
    if (Date.now() - t0 > 6 * 3600_000) throw new Error("median time did not pass the locktime in 6 h");
    await sleep(30000);
  }
  step("BTC: the median time is past the locktime", { waitedMin: ((Date.now() - t0) / 60000).toFixed(1) });
  await tryBtc("refund with nLockTime one below the script's locktime", spendHtlc({ outpoint, value: SATS, pay, path: { refund: true }, signer: bob.btc.signer, to: bob.btc.output, locktime: locktime - 1 }), /Locktime requirement not satisfied/);
  await tryBtc("refund signed by Alice, not the sender", spendHtlc({ outpoint, value: SATS, pay, path: { refund: true }, signer: alice.btc.signer, to: alice.btc.output, locktime }), SIG);
  const r = await tryBtc("refund by Bob after the locktime", spendHtlc({ outpoint, value: SATS, pay, path: { refund: true }, signer: bob.btc.signer, to: bob.btc.output, locktime }), "accepted");
  const g = await tryBtc("refund of the size-checked control output", spendHtlc({ outpoint: gOut, value: CTRL, pay: guarded, path: { refund: true }, signer: bob.btc.signer, to: bob.btc.output, locktime }), "accepted");
  await waitConfirmations(r.txid, 1, "BTC refund");
  await waitConfirmations(g.txid, 1, "BTC control refund");
} else {
  throw new Error(`unknown mode ${MODE}`);
}

log.before = before;
log.after = await balances("after");
save();
process.exit(0);
