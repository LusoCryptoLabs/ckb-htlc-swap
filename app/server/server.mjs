// Order book for CKB <-> USDC hashlock swaps, testnet.
//
// The book only matches people and remembers what they told it. It never holds funds or keys of
// the parties. Its watcher does the transactions anyone may do: once the secret is public it
// completes the claims (they always pay the address in the lock), and after a timeout it sends the
// refunds (they always pay the sender). On CKB those need no signature; on Base the relayer key
// pays the gas.
//
// An offer is taken in fills: each fill is one swap (its own secret and both locks) for a piece of
// the offer, between the offer's minimum piece and what is left of it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ccc } from "@ckb-ccc/core";
import { ethers } from "ethers";
import {
  NET, T, setTimings, WINDOWS, setWindows, timingsFor, oldTakerLock, fmtWindow, MIN_CKB, tokenOf, amountKey, legs, ASSETS, assetOf, fmtOther, windowsFor, ckbClient, evmProvider, train, checkTrainLock, checkHtlcCell,
  htlcSpendTx, htlcState, trainLockState, ckbMedianTime, sha256hex, parseUsdc, parseCkb, fmtCkb, fmtUsdc,
  fillUsdc, remainingCkb, pieceOk,
} from "../shared/swaplib.mjs";
import { btcPubOk, p2wpkhOf, btcLockState, btcMedianTime, checkSignedSpend, claimWithSecret, btcBroadcast } from "../shared/btclib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? path.join(HERE, "..", "data");
const DIST = path.resolve(process.env.DIST_DIR ?? path.join(HERE, "..", "dist")); // resolved, so the prefix check below also holds for a Windows path
const STORE = path.join(DATA_DIR, "offers.json");
const WATCH_MS = Number(process.env.WATCH_MS ?? 15000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const ONLINE_SEC = 150; // a maker whose page or script checked in this recently counts as online
setTimings({ takerLock: process.env.T_TAKER_LOCK, makerLock: process.env.T_MAKER_LOCK, makerBeforeTaker: process.env.T_MAKER_BEFORE_TAKER,
  makerMinLeft: process.env.T_MAKER_MIN_LEFT, revealMargin: process.env.T_REVEAL_MARGIN, takeToLock: process.env.T_TAKE_TO_LOCK });
if (process.env.WINDOWS) setWindows(process.env.WINDOWS.split(",").map(Number)); // tests: short windows
// The taker reveals only while the maker's lock has T.revealMargin left, and the maker's lock runs
// one window: a window at or below twice the margin leaves the taker almost no time to reveal.
if (WINDOWS.some((w) => w <= 2 * T.revealMargin)) {
  console.error(`every window must be above ${2 * T.revealMargin} s (twice the reveal margin); lower T_REVEAL_MARGIN for short test windows`);
  process.exit(1);
}

const client = ckbClient();
const provider = evmProvider();
const relayerKey = process.env.RELAYER_KEY ?? (process.env.RELAYER_KEY_FILE ? fs.readFileSync(process.env.RELAYER_KEY_FILE, "utf8").trim() : null);
const relayer = relayerKey ? new ethers.NonceManager(new ethers.Wallet(relayerKey, provider)) : null;

fs.mkdirSync(DATA_DIR, { recursive: true });
let offers = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : [];
const save = () => { const tmp = STORE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(offers, null, 1)); fs.renameSync(tmp, STORE); };
const now = () => Math.floor(Date.now() / 1000);
const tokenHash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const newToken = () => crypto.randomBytes(24).toString("hex");
const log = (o, text, extra = {}) => { o.log.push({ at: now(), text, ...extra }); console.log(`[${o.id}] ${text}`, extra.tx ?? ""); };
const ACTIVE = new Set(["taken", "taker-locked", "maker-locked", "revealed", "refunding"]);

// Offers from before fills were one swap each: each becomes an offer taken whole, with that swap as
// its one fill under the same id, so old links still find it.
for (const o of offers) {
  if (o.fills) continue;
  const swap = ["open", "cancelled"].includes(o.status) ? null : o;
  const fill = swap && {
    id: o.id, offerId: o.id, createdAt: o.takenAt ?? o.createdAt, status: o.status, makerGives: o.makerGives, window: o.window, maker: o.maker,
    ckbAmount: o.ckbAmount, usdcAmount: o.usdcAmount, taker: o.taker, takerToken: o.takerToken, hashlock: o.hashlock, takenAt: o.takenAt,
    takerLock: o.takerLock, makerLock: o.makerLock, secret: o.secret, revealedOnChain: o.revealedOnChain, log: o.log,
  };
  for (const k of ["taker", "takerToken", "hashlock", "takenAt", "takerLock", "makerLock", "secret", "revealedOnChain", "settle", "abandoned"]) delete o[k];
  Object.assign(o, { minCkb: o.ckbAmount, status: swap ? "closed" : o.status, fills: fill ? [fill] : [], log: swap ? [] : o.log });
}
const allFills = () => offers.flatMap((o) => o.fills);
const offerOf = (f) => offers.find((o) => o.id === f.offerId);

// ------------------------------------------------------------------ what each party sees
const makerKey = (m) => `${m.evm}|${m.ckbLockHash}`;
/** A maker's record across the book: fills completed, and fills where the taker locked but the maker did not. */
function statsOf(maker) {
  const k = makerKey(maker);
  let done = 0, failed = 0;
  for (const f of allFills()) {
    if (makerKey(f.maker) !== k) continue;
    if (f.status === "done") done++;
    else if (["refunding", "refunded"].includes(f.status) && f.takerLock && !f.makerLock) failed++;
  }
  return { done, failed };
}

// The secret is never served: once a claim puts it on chain anyone can read it there, and before
// that it must reach only the transactions that pay the taker first.
function fillView(f) {
  const { takerToken, secret, takerIp, ...rest } = f;
  // A BTC lock's signed claim and refund pay only their signers; the claim waits for the secret.
  const lockView = (l) => (l && l.chain === "btc" ? { ...l, refundTx: l.refundTx ? true : undefined, claimTx: l.claimTx ? true : undefined } : l);
  return { ...rest, asset: assetOf(f), takerLock: lockView(f.takerLock), makerLock: lockView(f.makerLock), display: { ckb: fmtCkb(f.ckbAmount), other: fmtOther(f, f.usdcAmount) } };
}
function offerView(o, { full = false } = {}) {
  const { makerToken, fills, ...rest } = o;
  const left = remainingCkb(o);
  return {
    ...rest, remainingCkb: left.toString(), remainingUsdc: fillUsdc(o, left).toString(),
    online: now() - (o.seenAt ?? 0) < ONLINE_SEC, stats: statsOf(o.maker),
    fills: full ? fills.map(fillView) : fills.map((f) => ({ id: f.id, status: f.status, ckbAmount: f.ckbAmount })),
    asset: assetOf(o), display: { ckb: fmtCkb(o.ckbAmount), other: fmtOther(o, o.usdcAmount), min: fmtCkb(o.minCkb) },
  };
}

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const need = (cond, code, msg) => { if (!cond) throw new HttpError(code, msg); };
const offerById = (id) => { const o = offers.find((x) => x.id === id); need(o, 404, "offer not found"); return o; };
const fillById = (id) => { const f = allFills().find((x) => x.id === id); need(f, 404, "fill not found"); return f; };
const tokenOk = (have, token) => !!token && have === tokenHash(token);
const evmAddr = (a) => { need(ethers.isAddress(a ?? ""), 400, "bad EVM address"); return ethers.getAddress(a); };

async function party(p, asset = "USDC") {
  need(p && typeof p.ckbAddress === "string", 400, "ckbAddress required");
  let lockHash, lock;
  try { const a = await ccc.Address.fromString(p.ckbAddress, client); need(a.prefix === "ckt", 400, "CKB testnet address required"); lock = a.script; lockHash = a.script.hash(); }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(400, "bad CKB address"); }
  const ckb = { ckbAddress: p.ckbAddress, ckbLockHash: lockHash, ckbLock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args } };
  if (asset !== "BTC") return { evm: evmAddr(p.evm), ...ckb };
  // A BTC pair: the key that signs the Bitcoin side; the address is its own (p2wpkh), never asked.
  const btcPub = btcPubOk(p.btcPub ?? "");
  need(btcPub, 400, "btcPub required: a compressed public key");
  return { evm: p.evm && ethers.isAddress(p.evm) ? ethers.getAddress(p.evm) : null, btcPub, btcAddress: p2wpkhOf(btcPub).address, ...ckb };
}
/** Two people are one if any of their keys is the same. */
const samePerson = (a, b) => a.ckbLockHash === b.ckbLockHash || (!!a.evm && a.evm === b.evm) || (!!a.btcPub && a.btcPub === b.btcPub);

// ------------------------------------------------------------------ market price
// CKB/USD from public tickers (USDT counted as USD), the median of those that answer, kept a minute.
// The price only suggests amounts: once both sides lock, the amounts are fixed.
const PRICE_SOURCES = [
  ["Binance", "https://api.binance.com/api/v3/ticker/price?symbol=CKBUSDT", (j) => Number(j.price)],
  ["CoinGecko", "https://api.coingecko.com/api/v3/simple/price?ids=nervos-network&vs_currencies=usd", (j) => Number(j["nervos-network"].usd)],
  ["Gate", "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=CKB_USDT", (j) => Number(j[0].last)],
  ["KuCoin", "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=CKB-USDT", (j) => Number(j.data.price)],
];
const BTC_SOURCES = [
  ["Binance", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", (j) => Number(j.price)],
  ["CoinGecko", "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", (j) => Number(j.bitcoin.usd)],
  ["Gate", "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT", (j) => Number(j[0].last)],
  ["KuCoin", "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BTC-USDT", (j) => Number(j.data.price)],
];
const ETH_SOURCES = [
  ["Binance", "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", (j) => Number(j.price)],
  ["CoinGecko", "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (j) => Number(j.ethereum.usd)],
  ["Gate", "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=ETH_USDT", (j) => Number(j[0].last)],
  ["KuCoin", "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=ETH-USDT", (j) => Number(j.data.price)],
];
async function medianOf(sources) {
  const got = await Promise.all(sources.map(async ([name, url, read]) => {
    try { const p = read(await fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.json())); return p > 0 && Number.isFinite(p) ? p : null; } catch { return null; }
  }));
  const v = got.filter(Boolean).sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
}
// The public test's limits (his "sim", 2026-11-10): each take is worth at most LIMITS.takeUsd (Bitcoin:
// takeUsdBtc, as its two network fees would eat a 1 USD swap); one CKB account takes at most dayUsd (Bitcoin:
// dayUsdBtc) per pair and direction in 24 h; one address (IP) at most ipDayUsd in 24 h across all pairs. The
// day's limits default to one take's, so a wallet swaps once a day unless DAY_USD says more. Worth = the
// piece's CKB at the market price; pieces left without a lock (abandoned) do not count. 0 turns a limit off.
const TAKE_USD = Number(process.env.TAKE_USD ?? 1), TAKE_USD_BTC = Number(process.env.TAKE_USD_BTC ?? 5);
const LIMITS = { takeUsd: TAKE_USD, takeUsdBtc: TAKE_USD_BTC, dayUsd: Number(process.env.DAY_USD ?? TAKE_USD), dayUsdBtc: Number(process.env.DAY_USD_BTC ?? TAKE_USD_BTC), ipDayUsd: Number(process.env.IP_DAY_USD ?? 5) };
const SLACK = 1.05; // quotes round: 1 USDC typed buys about 0.98 USD of CKB at the bot's 2%
// Swaps from before the limits went live (2026-11-10 18:50 UTC) do not count: a tester's earlier swaps
// blocked their first try of the public test.
const LIMITS_FROM = Number(process.env.LIMITS_FROM ?? 1794336600);
const capFor = (asset) => (asset === "BTC" ? LIMITS.takeUsdBtc : LIMITS.takeUsd);
const dayCapFor = (asset) => (asset === "BTC" ? LIMITS.dayUsdBtc : LIMITS.dayUsd);
async function withinLimits(o, ckb, taker, takerIp) {
  const cap = capFor(assetOf(o)), dayCap = dayCapFor(assetOf(o));
  if (!cap && !dayCap && !LIMITS.ipDayUsd) return;
  const { usdPerCkb } = await marketPrice();
  const usd = (c) => (Number(c) / 1e8) * usdPerCkb;
  const worth = usd(ckb), sum = (xs) => xs.reduce((s, x) => s + usd(x.ckbAmount), 0);
  need(!cap || worth <= cap * SLACK, 409, `the public test takes at most ${cap} USD per swap; this is about ${worth.toFixed(2)} USD`);
  const day = allFills().filter((x) => now() - x.takenAt < 86400 && x.takenAt >= LIMITS_FROM && x.status !== "abandoned");
  const mine = day.filter((x) => x.taker.ckbLockHash === taker.ckbLockHash && assetOf(x) === assetOf(o) && x.makerGives === o.makerGives);
  need(!dayCap || sum(mine) + worth <= dayCap * SLACK, 429, `the public test takes at most ${dayCap} USD a day per pair and direction for one wallet: try again tomorrow`);
  need(!LIMITS.ipDayUsd || sum(day.filter((x) => x.takerIp === takerIp)) + worth <= LIMITS.ipDayUsd * SLACK, 429, `the public test takes at most ${LIMITS.ipDayUsd} USD a day from one address: try again tomorrow`);
}

let priceCache = null;
async function marketPrice() {
  // FIXED_USD_PER_CKB: a fixed price, for tests that must not reach the price sources.
  if (process.env.FIXED_USD_PER_CKB) return { usdPerCkb: Number(process.env.FIXED_USD_PER_CKB), usdPerBtc: null, usdPerEth: null, spreadPct: 0, sources: [], at: now() };
  if (priceCache && now() - priceCache.at < 60) return priceCache;
  const btc = medianOf(BTC_SOURCES), eth = medianOf(ETH_SOURCES);
  const got = await Promise.all(PRICE_SOURCES.map(async ([name, url, read]) => {
    try {
      const p = read(await fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()));
      return p > 0 && Number.isFinite(p) ? { name, price: p } : null;
    } catch { return null; }
  }));
  const ok = got.filter(Boolean);
  if (!ok.length) { if (priceCache) return priceCache; throw new HttpError(503, "no price source answered"); }
  const v = ok.map((x) => x.price).sort((a, b) => a - b);
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  priceCache = { usdPerCkb: median, usdPerBtc: (await btc) ?? priceCache?.usdPerBtc ?? null, usdPerEth: (await eth) ?? priceCache?.usdPerEth ?? null, spreadPct: ((v[v.length - 1] - v[0]) / median) * 100, sources: ok, at: now() };
  return priceCache;
}

/**
 * A BTC lock reported by its sender: the funding output pays this swap's script exactly the fill's
 * sats, with `remaining` seconds left on Bitcoin's own clock (median time) inside [lo, hi], and a
 * refund signed ahead by the sender for that output. The lock's time is also kept on this
 * machine's clock (timeoutSec), as the other chains' are, for the watcher's ordering.
 */
async function btcLockReport(f, b, { senderPub, recipientPub, lo, hi }) {
  const r = b.btc ?? {};
  need(/^[0-9a-f]{64}$/.test(r.txid ?? "") && Number.isInteger(r.vout) && r.vout >= 0 && Number.isInteger(r.locktime) && r.locktime > 500_000_000, 400, "btc: { txid, vout, locktime, refund } required");
  const terms = { hashlock: f.hashlock, recipientPub, senderPub, locktime: r.locktime };
  const st = await btcLockState({ txid: r.txid, vout: r.vout, sats: f.usdcAmount, terms });
  need(st.status === "Pending", 409, `BTC lock not valid yet: ${st.why ?? st.status}`);
  const mtp = await btcMedianTime();
  const remaining = r.locktime - mtp;
  need(remaining >= lo && remaining <= hi, 409, `BTC locktime: ${remaining} s left on Bitcoin's clock, expected ${lo} to ${hi}`);
  const c = checkSignedSpend({ hex: r.refund ?? "", kind: "refund", outpoint: { txid: r.txid, vout: r.vout }, sats: f.usdcAmount, terms, signerPub: senderPub });
  need(c.ok, 400, `BTC refund signed ahead: ${c.why}`);
  return { chain: "btc", txid: r.txid, vout: r.vout, terms, refundTx: r.refund, timeoutSec: now() + remaining, tx: r.txid };
}
/** A claim of a BTC lock signed ahead by its recipient, the secret's place kept. */
function btcClaimFor(f, leg, hex, recipientPub) {
  const c = checkSignedSpend({ hex: hex ?? "", kind: "claim", outpoint: { txid: leg.txid, vout: leg.vout }, sats: f.usdcAmount, terms: leg.terms, signerPub: recipientPub });
  need(c.ok, 400, `BTC claim signed ahead: ${c.why}`);
  return hex;
}

// ------------------------------------------------------------------ API
const routes = {
  "GET /api/price": async () => marketPrice(),

  "GET /api/config": async () => ({ net: NET, timings: { ...T, maxFee: T.maxFee.toString() }, windows: WINDOWS, minCkb: MIN_CKB.toString(), relayer: relayer ? await relayer.getAddress() : null, limits: LIMITS }),

  // Open offers with something left, best first for each side.
  "GET /api/offers": async () => offers.filter((o) => o.status === "open" && remainingCkb(o) > 0n).map((o) => offerView(o)).sort((a, b) => b.createdAt - a.createdAt),

  "GET /api/offers/:id": async ({ id }) => offerView(offerById(id), { full: true }),

  "GET /api/fills/:id": async ({ id }) => { const f = fillById(id); return { ...fillView(f), offer: offerView(offerOf(f)) }; },

  "POST /api/offers": async (_, b) => {
    const asset = b.asset === undefined ? "USDC" : b.asset;
    need(Object.hasOwn(ASSETS, asset), 400, `asset must be one of ${Object.keys(ASSETS).join(", ")}`);
    need(["CKB", asset].includes(b.makerGives), 400, `makerGives must be CKB or ${asset}`);
    const A = ASSETS[asset];
    let ckbAmount, usdcAmount, minCkb;
    try { ckbAmount = parseCkb(b.ckb); usdcAmount = A.parse(b[amountKey(asset)]); minCkb = b.minCkb === undefined || b.minCkb === "" ? ckbAmount : parseCkb(b.minCkb); }
    catch { throw new HttpError(400, "bad amount"); }
    need(ckbAmount >= MIN_CKB, 400, `at least ${fmtCkb(MIN_CKB)} CKB`);
    const low = A.parse(A.min);
    need(usdcAmount >= low && usdcAmount <= A.parse(A.max), 400, `${asset} between ${A.fmt(low)} and ${A.max}`);
    need(minCkb >= MIN_CKB && minCkb <= ckbAmount, 400, `the minimum piece must be between ${fmtCkb(MIN_CKB)} CKB and the whole offer`);
    need((minCkb * usdcAmount) / ckbAmount >= low, 400, `the minimum piece must be worth at least ${A.fmt(low)} ${asset}`);
    const window = b.window === undefined ? windowsFor(asset)[0] : Number(b.window);
    need(windowsFor(asset).includes(window), 400, `window must be one of ${windowsFor(asset).join(", ")} seconds`);
    const token = newToken();
    const o = { id: crypto.randomBytes(5).toString("hex"), createdAt: now(), status: "open", asset, makerGives: b.makerGives, window,
      ckbAmount: ckbAmount.toString(), usdcAmount: usdcAmount.toString(), minCkb: minCkb.toString(), maker: await party(b.maker, asset), makerToken: tokenHash(token),
      seenAt: now(), fills: [], log: [] };
    log(o, `offer: maker gives ${b.makerGives === "CKB" ? fmtCkb(ckbAmount) + " CKB" : fmtOther(o, usdcAmount)}, pieces from ${fmtCkb(minCkb)} CKB, comes back within ${fmtWindow(window)}`);
    offers.push(o); save();
    return { offer: offerView(o, { full: true }), token };
  },

  // The maker stops new fills; the fills already taken carry on.
  "POST /api/offers/:id/cancel": async ({ id }, b) => {
    const o = offerById(id);
    need(tokenOk(o.makerToken, b.token), 403, "maker token required");
    need(o.status === "open", 409, "only an open offer can be cancelled");
    o.status = "cancelled"; log(o, "cancelled by the maker: no new fills"); save();
    return offerView(o, { full: true });
  },

  // Operator cleanup on testnet: stop new fills on an offer whose maker left.
  "POST /api/admin/offers/:id/cancel": async ({ id }, b) => {
    need(ADMIN_TOKEN && b.token && crypto.timingSafeEqual(Buffer.from(tokenHash(b.token)), Buffer.from(tokenHash(ADMIN_TOKEN))), 403, "admin token required");
    const o = offerById(id);
    need(o.status === "open", 409, "only an open offer can be cancelled");
    o.status = "cancelled"; log(o, "cancelled by the operator: no new fills"); save();
    return offerView(o, { full: true });
  },

  // A maker's page or script checking in: its offers count as online for a while.
  "POST /api/heartbeat": async (_, b) => {
    need(Array.isArray(b.tokens) && b.tokens.length <= 50, 400, "tokens: a list of up to 50 maker tokens");
    const hashes = new Set(b.tokens.map(tokenHash));
    let seen = 0;
    for (const o of offers) if (hashes.has(o.makerToken)) { o.seenAt = now(); seen++; }
    return { seen };
  },

  "POST /api/offers/:id/fills": async ({ id }, b, ctx) => {
    const o = offerById(id);
    need(o.status === "open", 409, "offer is not open");
    let ckb;
    try { ckb = b.ckb === undefined ? remainingCkb(o) : parseCkb(b.ckb); } catch { throw new HttpError(400, "bad amount"); }
    need(pieceOk(o, ckb), 409, `a piece must be between ${fmtCkb(o.minCkb)} CKB (or all that is left) and the ${fmtCkb(remainingCkb(o))} CKB left`);
    need(/^0x[0-9a-f]{64}$/.test(b.hashlock ?? ""), 400, "hashlock must be 32 bytes hex");
    need(!allFills().some((x) => x.hashlock === b.hashlock), 409, "hashlock already used");
    const taker = await party(b.taker, assetOf(o));
    need(!samePerson(taker, o.maker), 400, "maker and taker must differ");
    // Holding a piece costs nothing until the lock, so holding is limited: 2 pieces per account and
    // 3 per address at a time, each freed after takeToLock without a lock.
    const held = allFills().filter((x) => x.status === "taken");
    const takerIp = crypto.createHash("sha256").update(`book:${ctx.ip}`).digest("hex").slice(0, 16);
    need(held.filter((x) => x.taker.ckbLockHash === taker.ckbLockHash).length < 2, 429, "you already hold 2 pieces without locking: lock one first, or wait 10 min");
    need(held.filter((x) => x.takerIp === takerIp).length < 3, 429, "this address already holds 3 pieces without locking: lock one first, or wait 10 min");
    await withinLimits(o, ckb, taker, takerIp);
    const token = newToken();
    const f = { id: crypto.randomBytes(5).toString("hex"), offerId: o.id, createdAt: now(), status: "taken", asset: assetOf(o), makerGives: o.makerGives, window: o.window,
      maker: o.maker, ckbAmount: ckb.toString(), usdcAmount: fillUsdc(o, ckb).toString(), taker, takerToken: tokenHash(token), takerIp, takenAt: now(), hashlock: b.hashlock,
      takerLock: null, makerLock: null, log: [] };
    o.fills.push(f);
    log(f, `taken: ${fmtCkb(ckb)} CKB for ${fmtOther(f, f.usdcAmount)}; the taker picked the secret and must lock first`);
    log(o, `fill ${f.id}: ${fmtCkb(ckb)} CKB taken`); save();
    return { fill: fillView(f), token };
  },

  "POST /api/fills/:id/taker-lock": async ({ id }, b) => {
    const f = fillById(id);
    need(tokenOk(f.takerToken, b.token), 403, "taker token required");
    need(f.status === "taken", 409, `status is ${f.status}`);
    const { takerChain } = legs(f);
    const t = timingsFor(f.window, assetOf(f));
    // A page loaded before the maker's lock was capped still locks for two windows: accepted.
    const longest = Math.max(t.takerLock, oldTakerLock(f.window, assetOf(f)));
    const lo = now() + t.takerLock - 900, hi = now() + longest + 900;
    let c;
    if (takerChain === "btc") {
      f.takerLock = await btcLockReport(f, b, { senderPub: f.taker.btcPub, recipientPub: f.maker.btcPub, lo: t.takerLock - 1800, hi: longest + 1800 });
    } else if (takerChain === "evm") {
      c = await checkTrainLock(provider, { token: tokenOf(f), hashlock: f.hashlock, solver: f.taker.evm, amount: f.usdcAmount, recipient: f.maker.evm, refundTo: f.taker.evm, minTimelock: lo, maxTimelock: hi });
      need(c.ok, 409, `Train lock not valid yet: ${c.why}`);
      f.takerLock = { chain: "evm", solver: f.taker.evm, tx: b.tx ?? null, timeoutSec: c.timelock };
    } else {
      need(b.outPoint?.txHash, 400, "outPoint required");
      c = await checkHtlcCell(client, b.outPoint, { hashlock: f.hashlock, amount: f.ckbAmount, recipientLockHash: f.maker.ckbLockHash, senderLockHash: f.taker.ckbLockHash, minTimeout: lo, maxTimeout: hi });
      need(c.ok, 409, `CKB cell not valid yet: ${c.why}`);
      const l = c.cell.cellOutput.lock;
      f.takerLock = { chain: "ckb", outPoint: { txHash: b.outPoint.txHash, index: Number(b.outPoint.index) }, lock: { codeHash: l.codeHash, hashType: l.hashType, args: l.args }, timeoutSec: c.timeoutSec, tx: b.outPoint.txHash };
    }
    f.status = "taker-locked";
    log(f, `taker locked on ${CHAIN_NAME[takerChain]}; the maker can lock now`, { tx: f.takerLock.tx, chain: takerChain }); save();
    return fillView(f);
  },

  "POST /api/fills/:id/maker-lock": async ({ id }, b) => {
    const f = fillById(id);
    const o = offerOf(f);
    need(tokenOk(o.makerToken, b.token), 403, "maker token required");
    need(f.status === "taker-locked", 409, `status is ${f.status}`);
    const { makerChain } = legs(f);
    // The maker's page locks for the pair's shortest window; a report that arrives late is still
    // accepted while the taker keeps 15 min to reveal, and the lock must end before the taker's margin.
    const t = timingsFor(f.window, assetOf(f));
    const lo = now() + Math.min(t.makerMinLeft, T.makerMinLeft) - 300, hi = f.takerLock.timeoutSec - t.makerBeforeTaker + 120;
    // The maker who gets BTC signs its claim of the taker's BTC lock now, before locking: the
    // watcher sends it, with the secret, once the taker's claim puts the secret on chain.
    if (f.takerLock.chain === "btc") f.takerLock.claimTx = btcClaimFor(f, f.takerLock, b.btcClaim, f.maker.btcPub);
    let c;
    if (makerChain === "btc") {
      f.makerLock = await btcLockReport(f, b, { senderPub: f.maker.btcPub, recipientPub: f.taker.btcPub, lo: lo - now(), hi: hi - now() });
    } else if (makerChain === "evm") {
      c = await checkTrainLock(provider, { token: tokenOf(f), hashlock: f.hashlock, solver: f.maker.evm, amount: f.usdcAmount, recipient: f.taker.evm, refundTo: f.maker.evm, minTimelock: lo, maxTimelock: hi });
      need(c.ok, 409, `Train lock not valid yet: ${c.why}`);
      f.makerLock = { chain: "evm", solver: f.maker.evm, tx: b.tx ?? null, timeoutSec: c.timelock };
    } else {
      need(b.outPoint?.txHash, 400, "outPoint required");
      c = await checkHtlcCell(client, b.outPoint, { hashlock: f.hashlock, amount: f.ckbAmount, recipientLockHash: f.taker.ckbLockHash, senderLockHash: f.maker.ckbLockHash, minTimeout: lo, maxTimeout: hi });
      need(c.ok, 409, `CKB cell not valid yet: ${c.why}`);
      const l = c.cell.cellOutput.lock;
      f.makerLock = { chain: "ckb", outPoint: { txHash: b.outPoint.txHash, index: Number(b.outPoint.index) }, lock: { codeHash: l.codeHash, hashType: l.hashType, args: l.args }, timeoutSec: c.timeoutSec, tx: b.outPoint.txHash };
    }
    f.status = "maker-locked"; o.seenAt = now();
    log(f, `maker locked on ${CHAIN_NAME[makerChain]}; the taker can reveal`, { tx: f.makerLock.tx, chain: makerChain }); save();
    return fillView(f);
  },

  "POST /api/fills/:id/reveal": async ({ id }, b) => {
    const f = fillById(id);
    need(tokenOk(f.takerToken, b.token), 403, "taker token required");
    need(["maker-locked", "revealed"].includes(f.status), 409, `status is ${f.status}`);
    need(/^0x[0-9a-f]{64}$/.test(b.secret ?? "") && sha256hex(b.secret) === f.hashlock, 400, "secret does not match the hashlock");
    const t = timingsFor(f.window, assetOf(f));
    need(now() < f.makerLock.timeoutSec - t.revealMargin, 409, "too close to the maker's timeout: refunds only");
    if (f.makerLock.chain === "btc") {
      // The taker's claim of the maker's BTC lock, signed ahead: the watcher sends it with the
      // secret. Judged on Bitcoin's own clock too, so the claim lands well before the refund can.
      need(f.makerLock.terms.locktime - (await btcMedianTime()) > t.revealMargin, 409, "too close to the maker's BTC locktime: refunds only");
      f.makerLock.claimTx = btcClaimFor(f, f.makerLock, b.btcClaim, f.taker.btcPub);
    }
    f.secret = b.secret; f.status = "revealed";
    log(f, "secret handed in by the taker"); save();
    setTimeout(() => tick(f), 10);
    return fillView(f);
  },
};

// ------------------------------------------------------------------ watcher
// Order matters: the maker's lock pays the taker and is claimed first. The taker's lock pays the
// maker and is claimed only after the first claim is on chain, so a secret that reached the book
// can never pay the maker while the taker is left without the other side.
const busy = new Set();
const sim = async (p) => { try { await p; return null; } catch (e) { return e.revert?.name ?? e.shortMessage ?? e.message; } };

const CHAIN_NAME = { ckb: "CKB", evm: NET.evmName, btc: "Bitcoin testnet3" };
async function legState(f, leg) {
  if (leg.chain === "btc") return btcLockState({ txid: leg.txid, vout: leg.vout, sats: f.usdcAmount, terms: leg.terms });
  return leg.chain === "ckb" ? htlcState(client, leg.outPoint, leg.lock) : trainLockState(provider, f.hashlock, leg.solver);
}

async function claimLeg(f, leg, st, toParty) {
  if (leg.chain === "btc") {
    if (!leg.claimTx) { if (leg.lastError !== "no claim") { leg.lastError = "no claim"; log(f, `BTC claim for the ${toParty}: none signed ahead yet`); } return; }
    // Sent once: the chain's index can show the lock unspent for a while after the claim is in.
    if (leg.claimSent && now() - leg.claimSent.at < 900) return;
    try {
      const txid = await btcBroadcast(claimWithSecret(leg.claimTx, f.secret));
      leg.claimSent = { txid, at: now() };
      log(f, `BTC claimed for the ${toParty}`, { tx: txid, chain: "btc" });
    } catch (e) {
      const why = String(e.message ?? e).slice(0, 160);
      if (/already in utxo set|already in block chain|txn-already-known|txn-already-in-mempool/i.test(why)) { leg.claimSent = { at: now() }; return; }
      if (leg.lastError !== why) { leg.lastError = why; log(f, `BTC claim for the ${toParty} refused: ${why}`); }
    }
    return;
  }
  if (leg.chain === "ckb") {
    const h = await client.sendTransaction(htlcSpendTx(st.cell, { secret: f.secret, toLock: ccc.Script.from(f[toParty].ckbLock) }));
    log(f, `CKB claimed for the ${toParty}`, { tx: h, chain: "ckb" });
  } else if (relayer) {
    const why = await sim(train(relayer).redeemSolver.staticCall(f.hashlock, leg.solver, BigInt(f.secret)));
    if (why) { if (leg.lastError !== why) { leg.lastError = why; log(f, `USDC redeem for the ${toParty} would fail: ${why}; not sent`); } return; }
    const r = await (await train(relayer).redeemSolver(f.hashlock, leg.solver, BigInt(f.secret))).wait();
    log(f, `USDC redeemed for the ${toParty}`, { tx: r.hash, chain: "evm" });
  }
}

async function refundLeg(f, leg, st, fromParty) {
  if (leg.chain === "btc") {
    if ((await btcMedianTime()) < leg.terms.locktime) return;
    if (leg.refundSent && now() - leg.refundSent.at < 900) return;
    try {
      const txid = await btcBroadcast(leg.refundTx);
      leg.refundSent = { txid, at: now() };
      log(f, `BTC refunded to the ${fromParty}`, { tx: txid, chain: "btc" });
    } catch (e) {
      const why = String(e.message ?? e).slice(0, 160);
      if (/already in utxo set|already in block chain|txn-already-known|txn-already-in-mempool/i.test(why)) { leg.refundSent = { at: now() }; return; }
      if (leg.lastError !== why) { leg.lastError = why; log(f, `BTC refund to the ${fromParty} refused: ${why}`); }
    }
    return;
  }
  if (leg.chain === "ckb") {
    if ((await ckbMedianTime(client)) < leg.timeoutSec) return;
    const h = await client.sendTransaction(htlcSpendTx(st.cell, { toLock: ccc.Script.from(f[fromParty].ckbLock), timeoutSec: leg.timeoutSec }));
    log(f, `CKB refunded to the ${fromParty}`, { tx: h, chain: "ckb" });
  } else if (relayer) {
    const evmNow = Number((await provider.getBlock("latest")).timestamp);
    if (evmNow <= st.timelock) return;
    if (await sim(train(relayer).refundSolver.staticCall(f.hashlock, leg.solver))) return;
    const r = await (await train(relayer).refundSolver(f.hashlock, leg.solver)).wait();
    log(f, `USDC refunded to the ${fromParty}`, { tx: r.hash, chain: "evm" });
  }
}

/** Records a leg that is spent on chain; returns true when it changed. */
function settle(f, leg, st, name) {
  if (leg.outcome || !["Redeemed", "Refunded"].includes(st.status)) return false;
  leg.outcome = st.status === "Redeemed" ? "claimed" : "refunded";
  if (st.secret && !f.secret) f.secret = st.secret;
  log(f, `${name} ${leg.outcome}`, st.tx ? { tx: st.tx, chain: leg.chain === "btc" ? "btc" : "ckb" } : {});
  return true;
}

async function tick(f) {
  if (busy.has(f.id) || !ACTIVE.has(f.status)) return;
  busy.add(f.id);
  try {
    if (f.status === "taken" && now() - f.takenAt > T.takeToLock) {
      f.status = "abandoned";
      log(f, "the taker did not lock in time; the piece is free again");
      return save();
    }
    if (!f.takerLock) return;
    // 1. The maker's lock: claimed for the taker while there is time, refunded to the maker after it.
    if (f.makerLock && !f.makerLock.outcome) {
      const st = await legState(f, f.makerLock);
      if (!settle(f, f.makerLock, st, "maker's lock") && st.status === "Pending") {
        if (f.secret && now() < f.makerLock.timeoutSec - 60) await claimLeg(f, f.makerLock, st, "taker");
        else if (now() >= f.makerLock.timeoutSec) await refundLeg(f, f.makerLock, st, "maker");
      }
    }
    if (f.makerLock?.outcome === "claimed" && ["maker-locked", "revealed"].includes(f.status) && !f.revealedOnChain) {
      f.revealedOnChain = true; f.status = "revealed"; log(f, "the taker's claim put the secret on chain");
    }
    // 2. The taker's lock: claimed for the maker only after step 1 is on chain; else refunded after its timeout.
    if (!f.takerLock.outcome) {
      const st = await legState(f, f.takerLock);
      if (!settle(f, f.takerLock, st, "taker's lock") && st.status === "Pending") {
        if (f.makerLock?.outcome === "claimed" && f.secret) await claimLeg(f, f.takerLock, st, "maker");
        else if (now() >= f.takerLock.timeoutSec) await refundLeg(f, f.takerLock, st, "taker");
      }
    }
    const makerFailed = f.makerLock && f.makerLock.outcome !== "claimed" && now() >= f.makerLock.timeoutSec;
    const takerAlone = !f.makerLock && now() >= f.takerLock.timeoutSec;
    if ((makerFailed || takerAlone) && !["refunding", "refunded", "done"].includes(f.status)) { f.status = "refunding"; log(f, "no claim before the timeout: refunds"); }
    if (f.takerLock.outcome && (!f.makerLock || f.makerLock.outcome)) {
      const swapped = f.takerLock.outcome === "claimed" && f.makerLock?.outcome === "claimed";
      f.status = swapped ? "done" : "refunded";
      log(f, swapped ? "swap complete" : "refunds complete");
    }
    save();
  } catch (e) {
    console.error(`[${f.id}] watcher:`, e.shortMessage ?? e.message);
  } finally {
    busy.delete(f.id);
  }
}

setInterval(() => { for (const f of allFills()) if (ACTIVE.has(f.status)) tick(f); }, WATCH_MS);

// ------------------------------------------------------------------ http
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

function match(method, url) {
  for (const [k, fn] of Object.entries(routes)) {
    const [m, pattern] = k.split(" ");
    if (m !== method) continue;
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$");
    const r = url.match(re);
    if (r) return [fn, r.groups ?? {}];
  }
  return null;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, offers: offers.length, fills: allFills().length })); }
  if (url.pathname.startsWith("/api/")) {
    const m = match(req.method, url.pathname);
    res.setHeader("content-type", "application/json");
    if (!m) { res.writeHead(404); return res.end(JSON.stringify({ error: "not found" })); }
    try {
      let body = {};
      if (req.method === "POST") {
        let raw = ""; for await (const c of req) { raw += c; if (raw.length > 20000) throw new HttpError(413, "body too large"); }
        body = raw ? JSON.parse(raw) : {};
      }
      // The client's address: nginx's X-Real-IP, trusted only from this machine (the port listens
      // on 127.0.0.1 behind it); otherwise the socket's own address.
      const remote = req.socket.remoteAddress ?? "";
      const ip = (/^(::1|127\.|::ffff:127\.)/.test(remote) && req.headers["x-real-ip"]) || remote;
      const out = await m[0](m[1], body, { ip });
      res.writeHead(200); res.end(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      if (code === 500) console.error(e);
      res.writeHead(code); res.end(JSON.stringify({ error: e.shortMessage ?? e.message }));
    }
    return;
  }
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("build the page first: npm run build"); }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`swap book on :${PORT}, relayer ${relayer ? "on" : "off"}, timings ${JSON.stringify({ ...T, maxFee: String(T.maxFee) })}`));
