// Keeps the book stocked on testnet: one open offer per pair and side (USDC, ETH and BTC against CKB, selling
// and buying CKB), near the market price, from one testnet key. Each offer is served by a
// `party.mjs maker` process, which checks every taker's lock on chain before it locks, says it is
// online, and is asked to stop (a "stop" message: it cancels once no fill is under way) when the market
// moves away from its price. An offer used up or stopped is posted again, sized from what the key
// holds then.
//
//   BOOK       the book's URL
//   KEYS_DIR   where `<KEY>.key` is (testnet only)
//   KEY        the key's name (default "maker")
//   SPREAD     how far from the market each side is (default 0.02: sells CKB 2% above, buys 2% below)
//   DRIFT      how far an offer may sit from its price before it is posted again (default 0.01: the
//              page warns from 2% below the market, and the spread is already 2%)
//   CHECK_S    how often it looks (default 60)
//   TOKEN_DIR  where each running offer keeps its token (default ./maker-tokens); offers left there by
//              a run that died are cancelled when this one starts
//   ONCE=1     post what it would, print it, and exit (a dry look; nothing is locked)
//   CLAIM=0    leave every claim to the book's watcher (the default: the maker also claims itself)
//
// The maker does not rely on the book to be paid: for each fill it locked for (TOKEN_DIR/fills), it
// watches its own lock on chain, and once the taker's claim puts the secret there, claims the
// taker's lock itself (CKB with no signature, USDC through Train, BTC signed with its key). A BTC
// claim still unconfirmed when the taker's refund nears is sent again with twice the fee. A lock of
// its own that ran out with no claim comes back to it the same way, by its own hand.
// It locks for at most LOCK_FOR seconds instead of the offer's whole window, so a taker cannot
// keep a free option on the price for hours: a taker who does not reveal in time is refunded.
import { ccc } from "@ckb-ccc/core";
import { ethers } from "ethers";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NET, ckbClient, evmProvider, usdc, fmtPrice, train, htlcState, htlcSpendTx, trainLockState, ckbMedianTime } from "../shared/swaplib.mjs";
import { BTC, keySigner, p2wpkhOf, btcCoins, btcApi, btcLockState, btcMedianTime, buildHtlcSpend, claimWithSecret, btcBroadcast } from "../shared/btclib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOK = process.env.BOOK ?? "http://127.0.0.1:8787";
const KEYS_DIR = process.env.KEYS_DIR ?? "./keys";
const KEY = process.env.KEY ?? "maker";
const SPREAD = Number(process.env.SPREAD ?? 0.02);
const DRIFT = Number(process.env.DRIFT ?? 0.01);
const CHECK_S = Number(process.env.CHECK_S ?? 60);
const TOKEN_DIR = path.resolve(process.env.TOKEN_DIR ?? "maker-tokens");
fs.mkdirSync(TOKEN_DIR, { recursive: true });
const key = fs.readFileSync(path.join(KEYS_DIR, `${KEY}.key`), "utf8").trim();
const client = ckbClient();
const ckbSigner = new ccc.SignerCkbPrivateKey(client, key);
const evmAddr = new ethers.Wallet(key).address;
const btcAddr = p2wpkhOf(keySigner(key).pub).address;
const pub = evmProvider();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(`[maker ${new Date().toISOString().slice(11, 19)}]`, ...a);

// What each side may hold out at once, at most, and what stays back for fees.
const CAP = { ckb: 10_000, usdc: 10, sats: 20_000, eth: 0.01 };
// ETH kept back pays the fees on Base: USDC locks, claims and refunds of its own.
const KEEP = { ckb: 300, sats: 3_000, eth: 0.0002 };
const MIN_ETH = 0.0001; // the book's smallest ETH piece
const MIN_SATS = 5_000; // the book's smallest BTC piece
// How long the maker's own lock runs: the taker's time to reveal is this less the book's margin
// (10 min, 3 h with BTC) and the confirmations. With BTC it must outlast a slow block and the margin.
const LOCK_FOR = { USDC: Number(process.env.LOCK_FOR_USDC ?? 1800), ETH: Number(process.env.LOCK_FOR_ETH ?? 1800), BTC: Number(process.env.LOCK_FOR_BTC ?? 18000) };
// Each slot is one offer: the pair, what the maker gives.
const SLOTS = [
  { asset: "USDC", gives: "CKB" },
  { asset: "USDC", gives: "USDC" },
  { asset: "ETH", gives: "CKB" },
  { asset: "ETH", gives: "ETH" },
  { asset: "BTC", gives: "CKB" },
  { asset: "BTC", gives: "BTC" },
];

async function market() {
  const r = await fetch(`${BOOK}/api/price`);
  if (!r.ok) throw new Error(`price: ${r.status}`);
  const m = await r.json();
  return { USDC: m.usdPerCkb, ETH: m.usdPerEth ? m.usdPerCkb / m.usdPerEth : null, BTC: m.usdPerBtc ? m.usdPerCkb / m.usdPerBtc : null }; // the other coin per CKB
}
async function holdings() {
  const [ckb, usd, coins, wei] = await Promise.all([
    ckbSigner.getBalance(),
    usdc(pub).balanceOf(evmAddr),
    btcCoins(btcAddr),
    pub.getBalance(evmAddr),
  ]);
  return { ckb: Number(ckb) / 1e8, usdc: Number(usd) / 1e6, sats: coins.filter((c) => c.confirmed).reduce((a, c) => a + c.value, 0), eth: Number(wei) / 1e18 };
}

/** The offer a slot posts now, or null with why not: amounts as the book takes them. */
function plan(slot, mkt, have, ckbShare) {
  const per = mkt[slot.asset];
  if (!per) return { why: "no market price" };
  const price = slot.gives === "CKB" ? per * (1 + SPREAD) : per * (1 - SPREAD); // the other coin per CKB
  const minFor = (ckb) => (slot.asset === "BTC" ? Math.ceil(MIN_SATS / 1e8 / price) + 20 : slot.asset === "ETH" ? Math.ceil(MIN_ETH / price) + 20 : Math.min(500, ckb));
  if (slot.gives === "CKB") {
    const ckb = Math.floor(Math.min(CAP.ckb, ckbShare));
    const min = minFor(ckb);
    if (ckb < Math.max(min, 300)) return { why: `${Math.floor(ckbShare)} CKB free, below a piece` };
    const other = slot.asset === "USDC" ? (Math.floor(ckb * price * 1e6) / 1e6).toFixed(6) : (ckb * price).toFixed(8);
    return { ckb, other, min, price };
  }
  if (slot.asset === "USDC") {
    const u = Math.floor(Math.min(CAP.usdc, have.usdc * 0.9) * 100) / 100;
    const ckb = Math.floor(u / price);
    if (u < 0.5) return { why: `${have.usdc} USDC, too little` };
    return { ckb, other: u.toFixed(2), min: Math.min(500, ckb), price };
  }
  if (slot.asset === "ETH") {
    const e = Math.floor(Math.min(CAP.eth, have.eth - KEEP.eth) * 1e6) / 1e6;
    if (e < MIN_ETH) return { why: `${have.eth.toFixed(6)} ETH, too little beside what pays the fees` };
    const ckb = Math.floor(e / price);
    return { ckb, other: e.toFixed(6), min: Math.min(ckb, minFor(ckb)), price };
  }
  const sats = Math.min(CAP.sats, have.sats - KEEP.sats);
  if (sats < MIN_SATS) return { why: `${have.sats} sats confirmed, below a piece` };
  const ckb = Math.floor(sats / 1e8 / price);
  return { ckb, other: (sats / 1e8).toFixed(8), min: Math.min(ckb, minFor(ckb)), price };
}

const running = new Map(); // slot index -> { child, offer, price }
function start(i, p) {
  const s = SLOTS[i];
  const argv = ["maker", s.gives, String(p.ckb), p.other, "--key", KEY, "--asset", s.asset, "--min", String(p.min), "--no-wait", "--lock-for", String(LOCK_FOR[s.asset])];
  const child = spawn(process.execPath, [path.join(HERE, "party.mjs"), ...argv], { cwd: path.join(HERE, ".."), env: { ...process.env, BOOK, KEYS_DIR, TOKEN_DIR }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const r = { child, offer: null, price: p.price };
  running.set(i, r);
  const line = (b) => {
    for (const l of String(b).split("\n").filter(Boolean)) {
      const id = l.match(/^OFFER_ID=([0-9a-f]+)/)?.[1];
      if (id) r.offer = id; else console.log(`  ${s.asset}/${s.gives} ${l}`);
    }
  };
  child.stdout.on("data", line);
  child.stderr.on("data", line);
  child.on("exit", (code) => { say(`${s.asset}/${s.gives}: offer ${r.offer ?? "?"} ended (${code})`); running.delete(i); });
  say(`${s.asset}/${s.gives}: gives ${s.gives === "CKB" ? p.ckb + " CKB" : p.other + " " + s.asset} for ${s.gives === "CKB" ? p.other + " " + s.asset : p.ckb + " CKB"}, ${s.asset === "BTC" ? fmtPrice(p.price * 1e8) + " sats" : fmtPrice(p.price) + " USDC"} per CKB, pieces from ${p.min} CKB`);
}

// ------------------------------------------------------------------ its own claims
const FILLS = path.join(TOKEN_DIR, "fills");
fs.mkdirSync(FILLS, { recursive: true });
const evmSigner = new ethers.NonceManager(new ethers.Wallet(key, pub));
const btcKey = keySigner(key);
const myLock = (await ckbSigner.getRecommendedAddressObj()).script;
const SENT = /already|Dead|Unknown\(OutPoint|missingorspent|missing-inputs|LockNotPending|bad-txns-inputs-spent/i;
const legState = (chain, hashlock, l, sats) =>
  chain === "ckb" ? htlcState(client, l.outPoint, l.lock)
  : chain === "evm" ? trainLockState(pub, hashlock, l.solver)
  : btcLockState({ txid: l.txid, vout: l.vout, sats, terms: l.terms });
/** A BTC claim of the taker's lock, signed now, replaceable, at `rate` sats a vbyte. */
const btcClaim = async (r, secret, rate) => claimWithSecret(await buildHtlcSpend({ outpoint: { txid: r.theirs.txid, vout: r.theirs.vout }, sats: r.usdcAmount, terms: r.theirs.terms, kind: "claim", ownPub: btcKey.pub, feeRate: rate, sign: btcKey.sign, sequence: 0xfffffffd }), secret);
/** My own lock, run out with no claim: back to me (CKB with no signature, Train by anyone, BTC signed here). */
async function refundMine(r, mine) {
  if (r.makerChain === "ckb") {
    const timeout = BigInt(r.mine.lock.args.slice(2 + 96 * 2, 2 + 104 * 2).match(/../g).reverse().join("").replace(/^/, "0x")) & ((1n << 56n) - 1n);
    if (BigInt(await ckbMedianTime(client)) < timeout) return false;
    const h = await client.sendTransaction(htlcSpendTx(mine.cell, { toLock: myLock, timeoutSec: Number(timeout) }));
    say(`fill ${r.id}: my CKB came back by my own hand (${h})`);
    return true;
  }
  if (r.makerChain === "evm") {
    const st = await trainLockState(pub, r.hashlock, r.mine.solver);
    const evmNow = Number((await pub.getBlock("latest")).timestamp);
    if (evmNow <= st.timelock) return false;
    const t = await (await train(evmSigner).refundSolver(r.hashlock, r.mine.solver)).wait();
    say(`fill ${r.id}: my coin on Base came back by my own hand (${t.hash})`);
    return true;
  }
  if ((await btcMedianTime()) < r.mine.terms.locktime) return false;
  const hex = await buildHtlcSpend({ outpoint: { txid: r.mine.txid, vout: r.mine.vout }, sats: r.usdcAmount, terms: r.mine.terms, kind: "refund", ownPub: btcKey.pub, sign: btcKey.sign });
  say(`fill ${r.id}: my BTC came back by my own hand (${await btcBroadcast(hex)})`);
  return true;
}
async function claimRound() {
  for (const name of fs.readdirSync(FILLS).filter((x) => x.endsWith(".json"))) {
    const file = path.join(FILLS, name);
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    const done = (why) => { say(`fill ${r.id}: ${why}`); fs.rmSync(file, { force: true }); };
    try {
      const mine = await legState(r.makerChain, r.hashlock, r.mine, r.usdcAmount);
      if (mine.status === "Refunded") { done("my lock came back to me: the swap did not happen"); continue; }
      if (mine.status === "Pending" && (await refundMine(r, mine))) continue;
      if (mine.status !== "Redeemed" || !mine.secret) continue; // still waiting for the taker
      const theirs = await legState(r.takerChain, r.hashlock, r.theirs, r.usdcAmount);
      if (r.takerChain === "btc" && theirs.status === "Redeemed") {
        // Any claim of it is mine (it needs my signature): the book's, signed ahead, or my own. If it is
        // still unconfirmed when the taker's refund nears, it goes again with twice the fee.
        r.claimTxid = theirs.tx; r.claimRate ??= BTC.feeRate; r.claimAt ??= Math.floor(Date.now() / 1000);
        const st = await btcApi(`/tx/${theirs.tx}/status`).catch(() => null);
        if (st?.confirmed) { done(`the taker's BTC is claimed for me (${theirs.tx})`); continue; }
        const left = r.theirs.terms.locktime - (await btcMedianTime());
        if (left < 2 * 3600 && Date.now() / 1000 - r.claimAt > 1200) {
          const rate = Math.min(r.claimRate * 2, 200);
          const txid = await btcBroadcast(await btcClaim(r, mine.secret, rate));
          Object.assign(r, { claimTxid: txid, claimRate: rate, claimAt: Math.floor(Date.now() / 1000) });
          fs.writeFileSync(file, JSON.stringify(r));
          say(`fill ${r.id}: BTC claim sent again at ${rate} sat/vB (${left} s before the taker's refund counts)`);
        }
        continue;
      }
      if (theirs.status !== "Pending") { done(`the taker's lock is ${theirs.status}${theirs.tx ? " (" + theirs.tx + ")" : ""}`); continue; }
      if (r.takerChain === "ckb") {
        const h = await client.sendTransaction(htlcSpendTx(theirs.cell, { secret: mine.secret, toLock: myLock }));
        done(`claimed the taker's CKB myself (${h})`);
      } else if (r.takerChain === "evm") {
        const t = await (await train(evmSigner).redeemSolver(r.hashlock, r.theirs.solver, BigInt(mine.secret))).wait();
        done(`claimed the taker's coin on Base myself (${t.hash})`);
      } else {
        const rate = BTC.feeRate;
        const txid = await btcBroadcast(await btcClaim(r, mine.secret, rate));
        Object.assign(r, { claimTxid: txid, claimRate: rate, claimAt: Math.floor(Date.now() / 1000) });
        fs.writeFileSync(file, JSON.stringify(r));
        say(`fill ${r.id}: claimed the taker's BTC myself (${txid})`);
      }
    } catch (e) {
      const m = String(e?.shortMessage ?? e?.message ?? e);
      if (!SENT.test(m)) say(`fill ${r.id}: claim not done yet: ${m.slice(0, 160)}`);
    }
  }
}
if (process.env.CLAIM !== "0") (async () => { for (;;) { await claimRound().catch((e) => say("claims:", e.message)); await sleep(30_000); } })();

say(`book ${BOOK}, key ${KEY}: ${(await ckbSigner.getRecommendedAddress()).slice(0, 20)}… ${evmAddr} ${btcAddr}; spread ${SPREAD}, drift ${DRIFT}`);
// Offers a run that died left on the book: nobody serves them, so they are cancelled first.
for (const f of fs.readdirSync(TOKEN_DIR).filter((x) => x.endsWith(".json"))) {
  try {
    const { id, token } = JSON.parse(fs.readFileSync(path.join(TOKEN_DIR, f), "utf8"));
    const r = await fetch(`${BOOK}/api/offers/${id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    say(`left by an earlier run: offer ${id} ${r.ok ? "cancelled" : "not cancelled (" + r.status + ")"}`);
  } catch (e) { say(`left by an earlier run: ${f}: ${e.message}`); }
  fs.rmSync(path.join(TOKEN_DIR, f), { force: true });
}
let stopAll = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stopAll = true; say(`${sig}: stopping every offer`); for (const r of running.values()) r.child.send("stop"); });

for (;;) {
  try {
    const [mkt, have] = await Promise.all([market(), holdings()]);
    // Offers that drifted from the market are asked to stop; they are posted again once ended.
    for (const [i, r] of running) {
      const now = mkt[SLOTS[i].asset];
      if (now && Math.abs(r.price / (SLOTS[i].gives === "CKB" ? now * (1 + SPREAD) : now * (1 - SPREAD)) - 1) > DRIFT && !r.stopping) {
        r.stopping = true; say(`${SLOTS[i].asset}/${SLOTS[i].gives}: the market moved, stopping offer ${r.offer}`); r.child.send("stop");
      }
    }
    if (stopAll) { if (!running.size) break; await sleep(5000); continue; }
    // CKB free to offer, a third for each of the three slots that give CKB.
    const ckbShare = Math.max(0, have.ckb - KEEP.ckb) / 3;
    const idle = SLOTS.map((_, i) => i).filter((i) => !running.has(i));
    for (const i of idle) {
      const p = plan(SLOTS[i], mkt, have, ckbShare);
      if (p.why) { say(`${SLOTS[i].asset}/${SLOTS[i].gives}: nothing posted (${p.why})`); continue; }
      if (process.env.ONCE) { say(`${SLOTS[i].asset}/${SLOTS[i].gives} would post`, JSON.stringify(p)); continue; }
      start(i, p);
    }
    if (process.env.ONCE) break;
  } catch (e) { say("look failed:", e.message); }
  await sleep(CHECK_S * 1000);
}
say("stopped");
process.exit(0);
