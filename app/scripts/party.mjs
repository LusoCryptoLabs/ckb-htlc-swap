// A scripted participant of the order book, for end-to-end tests without a browser.
//
//   node scripts/party.mjs maker CKB 300 3 --key bob      publish "I give 300 CKB for 3 USDC", then act
//   node scripts/party.mjs maker BTC 300 0.00003 --key bob --asset BTC   "I give 0.00003 BTC for 300 CKB"
//   node scripts/party.mjs maker CKB 300 0.0001 --key bob --asset ETH   "I give 300 CKB for 0.0001 ETH" (Base Sepolia)
//        --min <ckb>      the smallest piece a taker may take (default: the whole offer)
//        --window <sec>   the response window (one of the book's windows; default the first)
//        --delay <sec>    wait this long after a taker locks before locking (a maker who comes back late)
//        --fills <n>      stop after locking for n fills (default: until nothing is left)
//        --no-wait        exit without waiting for the fills to end (the book's watcher ends them)
//        --lock-for <sec> lock for at most this long (not the whole window): the taker has less time to
//                         wait and see the price before revealing; one who does not, gets a refund
//        TOKEN_DIR        also keeps each fill it locked for (fills/<id>.json), for a parent that
//                         claims the taker's side itself when the secret is out (market-maker.mjs)
//        TOKEN_DIR        keep the offer's token there while it runs (<id>.json), for a parent to
//                         cancel it if this process dies
//        SIGTERM, or "stop" from a parent: cancel the offer as soon as no fill is under way, then exit
//   node scripts/party.mjs taker <offerId> --key alice    take that offer, then act
//        --ckb <amount>   take this piece (default: all that is left)
//        --reveal no      never reveal (a refund test); --reveal chain: claim on chain, revealing the
//                         secret there, but never tell the book (as when the book is down)
//
// Each side checks the other side's lock on chain before it locks or reveals, like the page does.
// Keys are testnet only (KEYS_DIR, default ./keys). BOOK is the book's URL.
import { ccc } from "@ckb-ccc/core";
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  NET, T, CONF, legs, ckbClient, evmProvider, train, usdc, htlcScript, checkTrainLock, checkHtlcCell, htlcSpendTx,
  trainLockParams, makerTimeout, sha256hex, fmtCkb, fmtUsdc, setTimings, setWindows, timingsFor,
  assetOf, fmtOther, windowsFor, tokenOf, amountKey,
} from "../shared/swaplib.mjs";
import { BTC, keySigner, p2wpkhOf, btcCoins, buildFunding, buildHtlcSpend, btcBroadcast, fundingVout, txidOf, btcLockState, btcMedianTime } from "../shared/btclib.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const BOOK = process.env.BOOK ?? "http://127.0.0.1:8787";
const KEYS_DIR = process.env.KEYS_DIR ?? "./keys";
const keyName = opt("key", "bob");
const key = fs.readFileSync(path.join(KEYS_DIR, `${keyName}.key`), "utf8").trim();
const client = ckbClient();
const provider = evmProvider();
const ckbSigner = new ccc.SignerCkbPrivateKey(client, key);
const evm = new ethers.NonceManager(new ethers.Wallet(key, provider));
// The same test key signs the Bitcoin side (p2wpkh on testnet3).
const btcSigner = keySigner(key);
const btcAddress = p2wpkhOf(btcSigner.pub).address;
const me = { evm: await evm.getAddress(), ckbAddress: await ckbSigner.getRecommendedAddress(), btcPub: btcSigner.pub };
const myLock = (await ckbSigner.getRecommendedAddressObj()).script;
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(`[${keyName} ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function api(method, url, body) {
  const r = await fetch(BOOK + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error ?? r.status); e.status = r.status; throw e; }
  return j;
}
const cfg = await api("GET", "/api/config");
setTimings({ ...cfg.timings, maxFee: undefined });
setWindows(cfg.windows);

async function postUntilOk(url, body, tries = 12) {
  for (let i = 0; ; i++) {
    try { return await api("POST", url, body); }
    catch (e) { if (e.status !== 409 || i >= tries) throw e; say("book says not yet:", e.message); await sleep(10000); }
  }
}

async function lockCkb({ hashlock, recipientLockHash, timeoutSec, amount }) {
  const lock = htlcScript({ hashlock, recipientLockHash, senderLockHash: myLock.hash(), timeoutSec });
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: BigInt(amount) }], outputsData: ["0x"] });
  await tx.completeInputsByCapacity(ckbSigner);
  await tx.completeFeeBy(ckbSigner, 1000);
  const h = await ckbSigner.sendTransaction(tx);
  await client.waitTransaction(h, 0, 240000);
  say("CKB locked", h);
  return { txHash: h, index: 0 };
}

/** Locks this side's USDC (approved first) or ETH (sent as the call's value) in Train. */
async function lockUsdc({ hashlock, recipient, timelockDelta, amount, dstAmount, token = NET.usdc }) {
  const eth = token === ethers.ZeroAddress;
  const t = usdc(evm);
  if (!eth && (await t.allowance(me.evm, NET.train)) < BigInt(amount)) { const a = await (await t.approve(NET.train, BigInt(amount))).wait(); say("USDC approved", a.hash); }
  const r = await (await train(evm).solverLock(...trainLockParams({ token, hashlock, amount, recipient, refundTo: me.evm, timelockDelta, dstAddress: me.ckbAddress, dstAmount }), ...(eth ? [{ value: BigInt(amount) }] : []))).wait();
  say(`${eth ? "ETH" : "USDC"} locked`, r.hash);
  return r.hash;
}

/**
 * Puts `sats` in a swap's BTC lock for `recipientPub`, `seconds` from now on Bitcoin's own clock,
 * and signs the refund ahead. Returns what the book's report needs.
 */
async function lockBtc({ hashlock, recipientPub, seconds, sats }) {
  const locktime = (await btcMedianTime()) + seconds;
  const terms = { hashlock, recipientPub, senderPub: btcSigner.pub, locktime };
  const coins = (await btcCoins(btcAddress)).filter((c) => c.confirmed);
  const hex = await buildFunding({ coins, ownPub: btcSigner.pub, terms, sats, sign: btcSigner.sign });
  const txid = await btcBroadcast(hex);
  if (txid !== txidOf(hex)) throw new Error(`broadcast said ${txid}`);
  const vout = fundingVout(hex, terms, sats);
  const refund = await buildHtlcSpend({ outpoint: { txid, vout }, sats, terms, kind: "refund", ownPub: btcSigner.pub, sign: btcSigner.sign });
  say("BTC locked", txid, `(locktime ${locktime}, ${seconds} s on Bitcoin's clock)`);
  return { txid, vout, locktime, refund };
}
/** Checks a BTC lock that pays me: Pending, buried BTC.conf deep, with `minLeft` seconds left on Bitcoin's clock. */
async function checkBtcLockForMe(lock, { minLeft }) {
  for (;;) {
    const st = await btcLockState({ txid: lock.txid, vout: lock.vout, sats: lock.sats, terms: lock.terms });
    if (st.status !== "Pending") throw new Error(`BTC lock: ${st.why ?? st.status}`);
    if (lock.terms.recipientPub !== btcSigner.pub) throw new Error("BTC lock: not for me");
    if (st.confirmations >= BTC.conf) break;
    say(`waiting for ${BTC.conf} BTC confirmation`); await sleep(20000);
  }
  const left = lock.terms.locktime - (await btcMedianTime());
  if (left < minLeft) throw new Error(`BTC lock: ${left} s left on Bitcoin's clock, need ${minLeft}`);
  return left;
}
// Replaceable (BIP 125), so a claim stuck under a low fee can be sent again with a higher one.
const claimBtcAhead = (lock) => buildHtlcSpend({ outpoint: { txid: lock.txid, vout: lock.vout }, sats: lock.sats, terms: lock.terms, kind: "claim", ownPub: btcSigner.pub, sign: btcSigner.sign, sequence: 0xfffffffd });

/** Repeats a lock check while it only waits for confirmations. */
async function confirmed(check) {
  for (;;) {
    const c = await check();
    if (!c.pending) return c;
    say(c.why); await sleep(8000);
  }
}

async function waitFill(id, want) {
  for (;;) {
    const f = await api("GET", `/api/fills/${id}`);
    if (want.includes(f.status)) return f;
    await sleep(5000);
  }
}

async function finish(id) {
  const f = await waitFill(id, ["done", "refunded"]);
  say(`final ${id}: ${f.status}`);
  for (const l of f.log) say("  log:", l.text, l.tx ?? "");
  return f;
}

/** The maker's side of one fill: check the taker's lock on chain, then lock the maker's part. */
async function makerLock(f, token) {
  const { makerChain, takerChain } = legs(f);
  const t = timingsFor(f.window, assetOf(f));
  const delay = Number(opt("delay", 0));
  if (delay) { say(`fill ${f.id}: coming back in ${delay} s`); await sleep(delay * 1000); }
  let takerTimeout, btcClaim;
  if (takerChain === "btc") {
    // The taker's BTC pays me: checked on Bitcoin's clock, then my claim of it signed ahead.
    const lock = { ...f.takerLock, sats: f.usdcAmount };
    const left = await checkBtcLockForMe(lock, { minLeft: t.makerMinLeft + t.makerBeforeTaker - 600 });
    takerTimeout = now() + left;
    btcClaim = await claimBtcAhead(lock);
  } else if (makerChain === "ckb") {
    const c = await confirmed(() => checkTrainLock(provider, { token: tokenOf(f), hashlock: f.hashlock, solver: f.taker.evm, amount: f.usdcAmount, recipient: me.evm, minTimelock: now() + t.makerMinLeft + t.makerBeforeTaker, confirmations: CONF.evm }));
    if (!c.ok) throw new Error(`taker's Train lock: ${c.why}`);
    takerTimeout = c.timelock;
  } else {
    const c = await confirmed(() => checkHtlcCell(client, f.takerLock.outPoint, { hashlock: f.hashlock, amount: f.ckbAmount, recipientLockHash: myLock.hash(), senderLockHash: f.taker.ckbLockHash, minTimeout: now() + t.makerMinLeft + t.makerBeforeTaker, confirmations: CONF.ckb }));
    if (!c.ok) throw new Error(`taker's CKB cell: ${c.why}`);
    takerTimeout = c.timeoutSec;
  }
  say(`fill ${f.id}: checked the taker's lock on chain`);
  const lockFor = Number(opt("lock-for", 0));
  const mt = lockFor ? Math.min(makerTimeout(now(), takerTimeout, t), now() + lockFor) : makerTimeout(now(), takerTimeout, t);
  if (mt - now() < (lockFor ? Math.min(lockFor, t.makerMinLeft) : t.makerMinLeft) - 60) throw new Error("not enough time left to lock safely");
  let mine;
  if (makerChain === "btc") {
    const btc = await lockBtc({ hashlock: f.hashlock, recipientPub: f.taker.btcPub, seconds: mt - now(), sats: f.usdcAmount });
    mine = { txid: btc.txid, vout: btc.vout, terms: { hashlock: f.hashlock, recipientPub: f.taker.btcPub, senderPub: btcSigner.pub, locktime: btc.locktime } };
    keepFill(f, mine);
    await postUntilOk(`/api/fills/${f.id}/maker-lock`, { token, btc });
  } else if (makerChain === "ckb") {
    const outPoint = await lockCkb({ hashlock: f.hashlock, recipientLockHash: f.taker.ckbLockHash, timeoutSec: mt, amount: f.ckbAmount });
    const l = htlcScript({ hashlock: f.hashlock, recipientLockHash: f.taker.ckbLockHash, senderLockHash: myLock.hash(), timeoutSec: mt });
    keepFill(f, { outPoint, lock: { codeHash: l.codeHash, hashType: l.hashType, args: l.args } });
    await postUntilOk(`/api/fills/${f.id}/maker-lock`, { token, outPoint, ...(btcClaim ? { btcClaim } : {}) });
  } else {
    const evmNow = Number((await provider.getBlock("latest")).timestamp);
    const tx = await lockUsdc({ token: tokenOf(f), hashlock: f.hashlock, recipient: f.taker.evm, timelockDelta: mt - evmNow, amount: f.usdcAmount, dstAmount: f.ckbAmount });
    keepFill(f, { solver: me.evm });
    await postUntilOk(`/api/fills/${f.id}/maker-lock`, { token, tx });
  }
}
/** What a parent needs to claim the taker's side once this fill's secret is out: both locks. */
function keepFill(f, mine) {
  if (!process.env.TOKEN_DIR) return;
  const dir = path.join(process.env.TOKEN_DIR, "fills");
  fs.mkdirSync(dir, { recursive: true });
  const { makerChain, takerChain } = legs(f);
  fs.writeFileSync(path.join(dir, `${f.id}.json`), JSON.stringify({ id: f.id, hashlock: f.hashlock, makerChain, takerChain, ckbAmount: f.ckbAmount, usdcAmount: f.usdcAmount,
    taker: { evm: f.taker.evm ?? null, ckbLockHash: f.taker.ckbLockHash, btcPub: f.taker.btcPub ?? null }, theirs: f.takerLock, mine, at: now() }));
}

if (args[0] === "maker") {
  const [, gives, ckb, usd] = args;
  const window = opt("window") ? Number(opt("window")) : undefined;
  const asset = opt("asset", ["BTC", "ETH"].includes(gives) ? gives : "USDC");
  const { offer, token } = await api("POST", "/api/offers", { asset, makerGives: gives, ckb, [amountKey(asset)]: usd, minCkb: opt("min"), window: window ?? windowsFor(asset)[0], maker: me });
  say(`offer ${offer.id}: I give ${gives === "CKB" ? ckb + " CKB" : `${usd} ${asset}`}, pieces from ${offer.display.min} CKB`);
  console.log(`OFFER_ID=${offer.id}`);
  const tokenFile = process.env.TOKEN_DIR ? path.join(process.env.TOKEN_DIR, `${offer.id}.json`) : null;
  if (tokenFile) fs.writeFileSync(tokenFile, JSON.stringify({ id: offer.id, token }), { mode: 0o600 });
  const want = opt("fills") ? Number(opt("fills")) : Infinity;
  const handled = new Set();
  let stopping = false;
  const askStop = () => { stopping = true; say("asked to stop: the offer is cancelled once no fill is under way"); };
  process.on("SIGTERM", askStop);
  process.on("message", (m) => m === "stop" && askStop()); // from a parent process (scripts/market-maker.mjs)
  const beat = setInterval(() => api("POST", "/api/heartbeat", { tokens: [token] }).catch(() => {}), 30000);
  // Lock for each fill whose taker has locked, one at a time, until enough fills or nothing is left.
  for (;;) {
    const o = await api("GET", `/api/offers/${offer.id}`);
    for (const f of o.fills) {
      if (f.status !== "taker-locked" || handled.has(f.id)) continue;
      handled.add(f.id);
      await makerLock(f, token).catch((e) => say(`fill ${f.id}: not locked: ${e.message}`));
    }
    const pending = o.fills.some((f) => ["taken", "taker-locked"].includes(f.status) && !handled.has(f.id));
    if (stopping && !pending) {
      await api("POST", `/api/offers/${offer.id}/cancel`, { token }).then(() => say(`offer ${offer.id} cancelled`)).catch((e) => say(`cancel: ${e.message}`));
      break;
    }
    if (handled.size >= want || (BigInt(o.remainingCkb) === 0n && !pending) || o.status === "cancelled") break;
    await sleep(5000);
  }
  clearInterval(beat);
  if (tokenFile) fs.rmSync(tokenFile, { force: true });
  if (!args.includes("--no-wait")) for (const id of handled) await finish(id);
} else if (args[0] === "taker") {
  const id = args[1];
  const secret = "0x" + crypto.randomBytes(32).toString("hex");
  const hashlock = sha256hex(secret);
  const { fill: f, token } = await api("POST", `/api/offers/${id}/fills`, { taker: me, hashlock, ckb: opt("ckb") });
  console.log(`FILL_ID=${f.id}`);
  say(`took ${f.display.ckb} CKB of ${id} as fill ${f.id}: I give ${f.makerGives === "CKB" ? f.display.other : f.display.ckb + " CKB"}`);
  const { takerChain, makerChain } = legs(f);
  const t = timingsFor(f.window, assetOf(f));
  let takerTimeout;
  if (takerChain === "btc") {
    takerTimeout = now() + t.takerLock;
    const btc = await lockBtc({ hashlock, recipientPub: f.maker.btcPub, seconds: t.takerLock, sats: f.usdcAmount });
    await postUntilOk(`/api/fills/${f.id}/taker-lock`, { token, btc });
  } else if (takerChain === "evm") {
    const tx = await lockUsdc({ token: tokenOf(f), hashlock, recipient: f.maker.evm, timelockDelta: t.takerLock, amount: f.usdcAmount, dstAmount: f.ckbAmount });
    await postUntilOk(`/api/fills/${f.id}/taker-lock`, { token, tx });
    takerTimeout = (await checkTrainLock(provider, { token: tokenOf(f), hashlock, solver: me.evm, amount: f.usdcAmount, recipient: f.maker.evm })).timelock;
  } else {
    takerTimeout = now() + t.takerLock;
    const outPoint = await lockCkb({ hashlock, recipientLockHash: f.maker.ckbLockHash, timeoutSec: takerTimeout, amount: f.ckbAmount });
    await postUntilOk(`/api/fills/${f.id}/taker-lock`, { token, outPoint });
  }
  const f2 = await waitFill(f.id, ["maker-locked", "refunding", "refunded"]);
  if (f2.status !== "maker-locked") { await finish(f.id); process.exit(0); }
  // Check the maker's lock myself before revealing.
  const maxT = takerTimeout - t.makerBeforeTaker + 120;
  let makerT, btcClaim;
  if (makerChain === "btc") {
    // The maker's BTC pays me: checked on Bitcoin's clock; my claim of it, signed ahead, goes to
    // the book with the secret, and the book's watcher sends it.
    const lock = { ...f2.makerLock, sats: f.usdcAmount };
    await checkBtcLockForMe(lock, { minLeft: t.revealMargin + 300 });
    btcClaim = await claimBtcAhead(lock);
  } else if (makerChain === "ckb") {
    const c = await confirmed(() => checkHtlcCell(client, f2.makerLock.outPoint, { hashlock, amount: f.ckbAmount, recipientLockHash: myLock.hash(), senderLockHash: f.maker.ckbLockHash, maxTimeout: maxT, confirmations: CONF.ckb }));
    if (!c.ok) throw new Error(`maker's CKB cell: ${c.why}`);
    makerT = c.timeoutSec;
    if (now() >= makerT - t.revealMargin) throw new Error("too late to reveal safely");
    if (opt("self-claim", "yes") === "yes" && opt("reveal", "yes") !== "no") {
      const h = await client.sendTransaction(htlcSpendTx(c.cell, { secret, toLock: myLock }));
      say("claimed the CKB myself, revealing the secret", h);
    }
  } else {
    const c = await confirmed(() => checkTrainLock(provider, { token: tokenOf(f), hashlock, solver: f.maker.evm, amount: f.usdcAmount, recipient: me.evm, maxTimelock: maxT, confirmations: CONF.evm }));
    if (!c.ok) throw new Error(`maker's Train lock: ${c.why}`);
    makerT = c.timelock;
    if (now() >= makerT - t.revealMargin) throw new Error("too late to reveal safely");
    if (opt("self-claim", "yes") === "yes" && opt("reveal", "yes") !== "no") {
      // Simulate first: a redeem that reverts would still put the secret on chain.
      await train(evm).redeemSolver.staticCall(hashlock, f.maker.evm, BigInt(secret));
      const r = await (await train(evm).redeemSolver(hashlock, f.maker.evm, BigInt(secret))).wait();
      say("redeemed the USDC myself, revealing the secret", r.hash);
    }
  }
  if (opt("reveal", "yes") === "yes") {
    await api("POST", `/api/fills/${f.id}/reveal`, { token, secret, ...(btcClaim ? { btcClaim } : {}) });
    say("secret handed to the book");
  } else if (opt("reveal") === "chain") { say("revealed on chain only; the book was not told"); process.exit(0); }
  else say("not revealing (refund test)");
  await finish(f.id);
} else {
  console.log("usage: party.mjs maker <CKB|USDC|BTC> <ckb> <other> --key <name> [--asset BTC] [--min <ckb>] | taker <offerId> --key <name> [--ckb <amount>]");
}
process.exit(0);
