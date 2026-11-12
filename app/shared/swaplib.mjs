// Rules and chain helpers shared by the server (Node) and the page (browser bundle).
// Nothing here holds a key. Every check reads the chain; nothing trusts the order book.
import { ccc } from "@ckb-ccc/core";
import { ethers } from "ethers";
import { fmtBtc, parseBtc } from "./btclib.mjs";

export const NET = {
  ckbRpc: "https://testnet.ckb.dev/",
  ckbExplorer: "https://testnet.explorer.nervos.org/transaction/",
  evmRpc: "https://sepolia.base.org",
  evmChainId: 84532,
  evmChainHex: "0x14a34",
  evmName: "Base Sepolia",
  evmExplorer: "https://sepolia.basescan.org/tx/",
  train: "0x265978c3e2E5dB9C3Ea665cC40C5925A5fc13Ee8",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  usdcDecimals: 6,
  // htlc-lock on CKB testnet (deploy.testnet.json in swap/)
  htlc: {
    codeHash: "0x2631477be216114391a8f0d2158c0f2ae33849ab20d692b49076ff5900d87932",
    hashType: "data2",
    dep: { outPoint: { txHash: "0x29379a658315c050bf4612dd671f986afc2c133ad2c6e14ef7e67ac9d6ae82b2", index: 0 }, depType: "code" },
  },
};

// Timings, in seconds. The taker picks the secret and locks first, with the longer timeout.
export const T = {
  takerLock: 7200, // the taker's lock runs 2 h
  makerLock: 3600, // the maker's lock runs at most 1 h ...
  makerBeforeTaker: 2400, // ... and ends at least 40 min before the taker's
  makerMinLeft: 1200, // the maker locks only if its lock would still run 20 min
  revealMargin: 600, // the secret is revealed only while the maker's lock has 10 min left
  takeToLock: 600, // a taker who does not lock within 10 min frees the piece
  maxFee: 1_000_000n, // 0.01 CKB per htlc input
};
// Blocks a lock must be buried under before the other side relies on it (testnet values).
export const CONF = { ckb: 10, evm: 5 };

export function setTimings(over) {
  for (const [k, v] of Object.entries(over)) if (v !== undefined && v !== "") T[k] = typeof T[k] === "bigint" ? BigInt(v) : Number(v);
}

// The response window, picked by the maker for each offer: how long the maker may take to come
// back and lock after the taker locks. The maker's lock runs the pair's shortest window, never
// more (makerLockFor), so the taker has that long to reveal: a long maker lock is a free option
// for the taker, who could reveal only if the price still suits. The taker's lock runs the window,
// then the maker's lock, then the margin the maker's side needs after a reveal.
export const WINDOWS = [3600, 6 * 3600, 12 * 3600, 24 * 3600];
export function setWindows(list) {
  if (Array.isArray(list) && list.length && list.every((w) => Number.isInteger(w) && w > 0)) WINDOWS.splice(0, WINDOWS.length, ...list);
}
/**
 * The timings of one offer. Offers made before windows existed have none and keep T. Bitcoin
 * confirms in ten-minute steps and judges time by the median of its last blocks, so a pair with BTC
 * keeps two hours between the two locks' ends and reveals only while the maker's lock has three
 * hours (BTC_REVEAL_MARGIN).
 */
export function timingsFor(window, asset = "USDC") {
  if (!window) return T;
  const btc = asset === "BTC";
  const makerBeforeTaker = btc ? Math.max(T.makerBeforeTaker, 7200) : T.makerBeforeTaker;
  const lock = makerLockFor(window, asset);
  return { ...T, makerLock: lock, makerMinLeft: lock, makerBeforeTaker, revealMargin: btc ? Math.max(T.revealMargin, BTC_REVEAL_MARGIN) : T.revealMargin, takerLock: window + lock + makerBeforeTaker };
}
/** How long the maker's lock runs: the window, or the pair's shortest window if that is less (1 h; 6 h with BTC). */
export const makerLockFor = (window, asset = "USDC") => Math.min(window, ...windowsFor(asset));
/** The taker's lock as pages before makerLockFor made it (two windows): still accepted, it only lengthens the taker's own wait. */
export const oldTakerLock = (window, asset = "USDC") => (window ? 2 * window + timingsFor(window, asset).makerBeforeTaker : T.takerLock);
/** The windows a pair offers: with BTC, six hours and more. */
/**
 * With BTC the secret is revealed only while the maker's lock has 3 h left. A claim of a BTC lock
 * is signed ahead at a fixed fee; 3 h (about 18 blocks) gives it time to confirm before the
 * sender's refund counts, even if fees rise.
 */
export const BTC_REVEAL_MARGIN = 3 * 3600;
export const windowsFor = (asset) => { const w = asset === "BTC" ? WINDOWS.filter((x) => x >= 6 * 3600) : WINDOWS; return w.length ? w : WINDOWS; };
export const fmtWindow = (s) => (s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`);

export const SINCE_TS = 0x4000_0000_0000_0000n;
export const MIN_CKB = ccc.fixedPointFrom("200");

export const trainAbi = [
  "function userLock(tuple(bytes32 hashlock,uint256 amount,uint256 rewardAmount,uint48 timelockDelta,uint48 rewardTimelockDelta,uint48 quoteExpiry,address recipient,address refundTo,address token,address payoutCurve,bytes payoutCurveData,string rewardToken,string rewardRecipient,string srcChain) params, tuple(string dstChain,string dstAddress,uint256 dstAmount,string dstToken) dst, bytes userData, bytes solverData) payable",
  "function redeemUser(bytes32 hashlock, uint256 secret)",
  "function refundUser(bytes32 hashlock)",
  "function getUserLock(bytes32 hashlock) view returns (tuple(uint256 secret,uint256 amount,address sender,uint48 timelock,uint48 startTime,uint8 status,address recipient,address refundTo,address token,address payoutCurve,bytes payoutCurveData))",
  "event UserRedeemed(bytes32 indexed hashlock, address redeemer, uint256 secret, uint256 payout, uint256 excess)",
  // Solver locks are keyed by (hashlock, sender): a stranger who learns H cannot take the slot first.
  "function solverLock(tuple(bytes32 hashlock,uint256 amount,uint256 reward,uint48 timelockDelta,uint48 rewardTimelockDelta,address recipient,address rewardRecipient,address refundTo,address token,address rewardToken,address payoutCurve,bytes payoutCurveData,string srcChain) params, tuple(string dstChain,string dstAddress,uint256 dstAmount,string dstToken) dst, bytes data) payable",
  "function redeemSolver(bytes32 hashlock, address solver, uint256 secret)",
  "function refundSolver(bytes32 hashlock, address solver)",
  "function getSolverLock(bytes32 hashlock, address solver) view returns (tuple(uint256 secret,uint256 amount,uint256 reward,address sender,uint48 timelock,uint48 rewardTimelock,uint48 startTime,address recipient,uint8 status,address rewardRecipient,address refundTo,address token,address rewardToken,address payoutCurve,bytes payoutCurveData))",
  "event SolverRedeemed(bytes32 indexed hashlock, address indexed solver, address redeemer, uint256 secret, uint256 payout, uint256 excess, address rewardTo, uint256 reward)",
  "error SolverLockAlreadyExists()",
  "error RefundNotAllowed()", "error LockNotPending()", "error LockNotFound()", "error HashlockMismatch()",
  "error QuoteExpired()", "error SwapAlreadyExists()", "error InvalidTimelock()", "error ZeroAmount()",
];
export const erc20Abi = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
export const LOCK_STATUS = ["Empty", "Pending", "Refunded", "Redeemed"];

export const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256hex = (bytes) => ethers.sha256(bytes);
export const fmtCkb = (shannons) => ccc.fixedPointToString(BigInt(shannons));
// The other side of a pair. An offer's `usdcAmount` holds the other side's units whatever it is
// (USDC units, or sats for BTC): the name stayed so the offers kept in the book still read.
export const ASSETS = {
  USDC: { chain: "evm", decimals: 6, fmt: (u) => fmtUsdc(u), parse: (x) => parseUsdc(x), name: "USDC", note: "dólar digital", min: "0.000001", max: "10000", token: NET.usdc },
  // ETH on Base Sepolia, in the same Train lock with its native token, address 0: the lock's value is
  // its amount. From 0.0001 ETH a piece, a few tenths of a dollar, well above a claim's fee there.
  ETH: { chain: "evm", decimals: 18, fmt: (u) => fmtEth(u), parse: (x) => parseEth(x), name: "ETH", note: "Ether", min: "0.0001", max: "1", token: ethers.ZeroAddress },
  // BTC from 5000 sats a piece: a claim pays a fee of a few hundred sats, and the Cellula wallet
  // keeps coins of 2000 sats or fewer for RGB++, where its payments do not spend them.
  BTC: { chain: "btc", decimals: 8, fmt: (u) => fmtBtc(u), parse: (x) => parseBtc(x), name: "BTC", note: "Bitcoin", min: "0.00005", max: "0.1" },
};
export const assetOf = (o) => (Object.hasOwn(ASSETS, o?.asset ?? "") ? o.asset : "USDC");
/** The Train token of an EVM pair's coin: USDC's contract, or address 0 for ETH. */
export const tokenOf = (o) => ASSETS[assetOf(o)].token;
/** The field an offer's other amount comes in: usdc, btc or eth. */
export const amountKey = (asset) => (asset === "USDC" ? "usdc" : asset.toLowerCase());
/** An amount of the other side of `o` as its coin writes it, with the coin's name. */
export const fmtOther = (o, units) => `${ASSETS[assetOf(o)].fmt(units)} ${assetOf(o)}`;
export const fmtUsdc = (units) => ethers.formatUnits(BigInt(units), NET.usdcDecimals).replace(/\.0$/, "");
export const parseUsdc = (s) => ethers.parseUnits(String(s), NET.usdcDecimals);
export const fmtEth = (wei) => ethers.formatEther(BigInt(wei)).replace(/\.0$/, "");
export const parseEth = (s) => ethers.parseEther(String(s));
export const parseCkb = (s) => ccc.fixedPointFrom(String(s));

export function htlcScript({ hashlock, recipientLockHash, senderLockHash, timeoutSec, maxFee = T.maxFee }) {
  const le64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
  const args = ccc.bytesConcat(
    ccc.bytesFrom(hashlock), ccc.bytesFrom(recipientLockHash), ccc.bytesFrom(senderLockHash),
    le64(SINCE_TS | BigInt(timeoutSec)), le64(maxFee),
  );
  return ccc.Script.from({ codeHash: NET.htlc.codeHash, hashType: NET.htlc.hashType, args: ccc.hexFrom(args) });
}

export function parseHtlcArgs(args) {
  const b = ccc.bytesFrom(args);
  if (b.length !== 112) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const timeout = dv.getBigUint64(96, true);
  return { hashlock: hex(b.slice(0, 32)), recipient: hex(b.slice(32, 64)), sender: hex(b.slice(64, 96)),
    metric: Number(timeout >> 56n), timeoutSec: Number(timeout & 0x00ff_ffff_ffff_ffffn), maxFee: dv.getBigUint64(104, true) };
}

export const ckbClient = () => new ccc.ClientPublicTestnet();
export const evmProvider = () => new ethers.JsonRpcProvider(NET.evmRpc, NET.evmChainId, { staticNetwork: true });
export const train = (runner) => new ethers.Contract(NET.train, trainAbi, runner);
export const usdc = (runner) => new ethers.Contract(NET.usdc, erc20Abi, runner);

/** The chain's median time in seconds: what an absolute timestamp `since` is judged against. */
export async function ckbMedianTime(client) {
  const tip = await client.getTipHeader();
  const r = await fetch(NET.ckbRpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_block_median_time", params: [tip.hash] }) }).then((x) => x.json());
  return Number(BigInt(r.result) / 1000n);
}

export async function lockHashOf(client, address) {
  const a = await ccc.Address.fromString(address, client);
  if (a.prefix !== "ckt") throw new Error("not a CKB testnet address");
  return a.script.hash();
}

// ------------------------------------------------------------------ the two kinds of lock

/** Which chain each side locks on. makerGives = what the maker hands over. */
export function legs(offer) {
  const makerGivesCkb = offer.makerGives === "CKB";
  const other = ASSETS[assetOf(offer)].chain;
  return { takerChain: makerGivesCkb ? other : "ckb", makerChain: makerGivesCkb ? "ckb" : other };
}

/** Reads a Train solver lock (hashlock, solver) and checks it against the terms. With confirmations,
 *  it reads the state that many blocks back: a lock younger than that is "pending", not ok. */
export async function checkTrainLock(provider, { hashlock, solver, amount, recipient, refundTo, minTimelock, maxTimelock, confirmations = 0, token = NET.usdc }) {
  const t = train(provider);
  const head = await provider.getBlockNumber();
  const l = await t.getSolverLock(hashlock, solver, confirmations ? { blockTag: head - confirmations } : {});
  const status = LOCK_STATUS[Number(l.status)];
  if (confirmations && status === "Empty") {
    const now = await t.getSolverLock(hashlock, solver);
    if (LOCK_STATUS[Number(now.status)] === "Pending") return { ok: false, pending: true, why: `waiting for ${confirmations} confirmations` };
  }
  const why = [];
  if (status !== "Pending") why.push(`status ${status}`);
  if (l.token.toLowerCase() !== token.toLowerCase()) why.push(`token is not ${token === ethers.ZeroAddress ? "ETH" : "USDC"}`);
  if (l.amount !== BigInt(amount)) why.push(`amount ${l.amount}`);
  if (l.recipient.toLowerCase() !== recipient.toLowerCase()) why.push("wrong recipient");
  if (refundTo && l.refundTo.toLowerCase() !== refundTo.toLowerCase()) why.push("wrong refund address");
  if (l.payoutCurve !== ethers.ZeroAddress) why.push("payout curve set");
  if (l.reward !== 0n) why.push("reward set");
  if (minTimelock && Number(l.timelock) < minTimelock) why.push("timelock too soon");
  if (maxTimelock && Number(l.timelock) > maxTimelock) why.push("timelock too late");
  return { ok: why.length === 0, why: why.join(", "), status, timelock: Number(l.timelock), secret: l.secret, lock: l };
}

/** State of a Train solver lock now: Pending, Redeemed (with the secret) or Refunded. */
export async function trainLockState(provider, hashlock, solver) {
  const l = await train(provider).getSolverLock(hashlock, solver);
  const status = LOCK_STATUS[Number(l.status)];
  return { status, timelock: Number(l.timelock), secret: status === "Redeemed" ? ethers.toBeHex(l.secret, 32) : null };
}

/** Reads an htlc-lock cell and checks it against the terms. */
export async function checkHtlcCell(client, outPoint, { hashlock, amount, recipientLockHash, senderLockHash, minTimeout, maxTimeout, confirmations = 0 }) {
  const cell = await client.getCellLive(outPoint, true);
  if (!cell) return { ok: false, why: "cell not live" };
  if (confirmations) {
    const [t, tip] = await Promise.all([client.getTransaction(outPoint.txHash), client.getTip()]);
    const have = t?.blockNumber == null ? 0 : Number(tip - t.blockNumber);
    if (have < confirmations) return { ok: false, pending: true, why: `waiting for ${confirmations} confirmations (${have})` };
  }
  const lock = cell.cellOutput.lock;
  const a = parseHtlcArgs(lock.args);
  const why = [];
  if (lock.codeHash !== NET.htlc.codeHash || lock.hashType !== NET.htlc.hashType || !a) why.push("not an htlc-lock cell");
  else {
    if (a.hashlock !== hashlock) why.push("wrong hashlock");
    if (a.recipient !== recipientLockHash) why.push("wrong recipient");
    if (a.sender !== senderLockHash) why.push("wrong sender");
    if (a.metric !== 0x40) why.push("timeout is not a timestamp");
    if (a.maxFee > T.maxFee) why.push("max fee too high");
    if (minTimeout && a.timeoutSec < minTimeout) why.push("timeout too soon");
    if (maxTimeout && a.timeoutSec > maxTimeout) why.push("timeout too late");
  }
  if (cell.cellOutput.capacity !== BigInt(amount)) why.push(`amount ${cell.cellOutput.capacity}`);
  if (cell.cellOutput.type) why.push("cell has a type");
  if (cell.outputData !== "0x") why.push("cell has data");
  return { ok: why.length === 0, why: why.join(", "), timeoutSec: a?.timeoutSec, cell };
}

/** A claim (with the secret) or refund (no witness lock, since = timeout) of one htlc cell; no signature. */
export function htlcSpendTx(cell, { secret, toLock, timeoutSec }) {
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: cell.outPoint, since: secret ? 0n : SINCE_TS | BigInt(timeoutSec) }],
    outputs: [{ lock: toLock, capacity: cell.cellOutput.capacity }],
    outputsData: ["0x"],
    cellDeps: [NET.htlc.dep],
  });
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from(secret ? { lock: ccc.hexFrom(secret) } : {}));
  let fee = tx.estimateFee(1000n) * 3n;
  if (fee < 10000n) fee = 10000n;
  if (fee > T.maxFee) throw new Error("fee above max fee");
  tx.outputs[0].capacity = cell.cellOutput.capacity - fee;
  return tx;
}

/** The transaction that spent an htlc cell, and the secret in its witness if it was a claim. */
export async function htlcSpend(client, lock) {
  const r = await fetch(NET.ckbRpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_transactions", params: [{ script: { code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args },
      script_type: "lock", script_search_mode: "exact" }, "asc", "0x64"] }) }).then((x) => x.json());
  const spent = (r.result?.objects ?? []).find((o) => o.io_type === "input");
  if (!spent) return null;
  const t = await client.getTransaction(spent.tx_hash);
  const w = ccc.WitnessArgs.fromBytes(t.transaction.witnesses[Number(spent.io_index)]);
  const s = w.lock && ccc.bytesFrom(w.lock).length === 32 ? ccc.hexFrom(w.lock) : null;
  return { txHash: spent.tx_hash, secret: s };
}

/** Arguments of Train.solverLock for one side's USDC or ETH (token address 0, sent as the call's value): no reward, no payout curve. */
export function trainLockParams({ hashlock, amount, recipient, refundTo, timelockDelta, dstAddress, dstAmount, token = NET.usdc }) {
  return [
    { hashlock, amount: BigInt(amount), reward: 0n, timelockDelta, rewardTimelockDelta: 0, recipient, rewardRecipient: ethers.ZeroAddress,
      refundTo, token, rewardToken: ethers.ZeroAddress, payoutCurve: ethers.ZeroAddress, payoutCurveData: "0x", srcChain: "base-sepolia" },
    { dstChain: "ckb-testnet", dstAddress, dstAmount: BigInt(dstAmount), dstToken: "CKB" },
    "0x",
  ];
}

/** State of an htlc cell: live, or how it was spent (claim with the secret, or refund). */
export async function htlcState(client, outPoint, lock) {
  const live = await client.getCellLive(outPoint, true, true);
  if (live) return { status: "Pending", cell: live };
  const sp = await htlcSpend(client, ccc.Script.from(lock));
  if (!sp) return { status: "Spending" };
  return { status: sp.secret ? "Redeemed" : "Refunded", secret: sp.secret, tx: sp.txHash };
}

// ------------------------------------------------------------------ price
// Prices are USDC per CKB as decimal strings or numbers; amounts are bigint (shannons, USDC units).
const PRICE_SCALE = 10n ** 12n;
const scaled = (price) => {
  const n = Number(price);
  if (!(n > 0) || !Number.isFinite(n)) throw new Error("bad price");
  return BigInt(Math.round(n * 1e12));
};
/** CKB (shannons) that `usdcUnits` buys at `price`, rounded down to 0.01 CKB. */
export function ckbForUsdc(usdcUnits, price) {
  const sh = (BigInt(usdcUnits) * 10n ** 14n) / scaled(price); // 1e8 shannons / 1e6 units * 1e12 scale
  return (sh / 1_000_000n) * 1_000_000n;
}
/** USDC (units) that `shannons` cost at `price`, rounded to the nearest 0.01 USDC. */
export function usdcForCkb(shannons, price) {
  const u = (BigInt(shannons) * scaled(price)) / 10n ** 14n;
  return ((u + 5_000n) / 10_000n) * 10_000n;
}
/** The other coin per CKB of an offer (USDC per CKB, or BTC per CKB). */
export const offerPrice = (o) => Number(BigInt(o.usdcAmount)) / 10 ** ASSETS[assetOf(o)].decimals / (Number(BigInt(o.ckbAmount)) / 1e8);
/** How far a price is from the market, in percent (positive = above). */
export const vsMarket = (price, market) => (Number(price) / Number(market) - 1) * 100;
export const fmtPrice = (p) => Number(p).toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
export const fmtPct = (x) => (Math.abs(x) < 0.05 ? "0.0%" : `${x > 0 ? "+" : "-"}${Math.abs(x).toFixed(Math.abs(x) < 10 ? 1 : 0)}%`);

/** The maker's lock timeout: at most t.makerLock from now, and t.makerBeforeTaker before the taker's. */
export function makerTimeout(nowSec, takerTimeoutSec, t = T) {
  return Math.min(nowSec + t.makerLock, takerTimeoutSec - t.makerBeforeTaker);
}

/** Until when the maker may still lock: after this its lock would run less than t.makerMinLeft. */
export const makerDeadline = (takerTimeoutSec, t = T) => takerTimeoutSec - t.makerBeforeTaker - t.makerMinLeft;

// ------------------------------------------------------------------ divisible offers
// An offer is taken in fills. Each fill is a swap of its own (its own secret, both locks), sized by
// the taker between the offer's minimum piece and what is left. A fill keeps the offer's price:
// USDC = CKB x the offer's USDC / the offer's CKB, rounded down to the USDC unit.
export const fillUsdc = (offer, ckb) => (BigInt(ckb) * BigInt(offer.usdcAmount)) / BigInt(offer.ckbAmount);

/** A fill holds part of its offer while it can still complete, or while the maker's coins are locked in it. */
export const fillHolds = (f) =>
  ["taken", "taker-locked", "maker-locked", "revealed", "done"].includes(f.status) || (f.status === "refunding" && !!f.makerLock && !f.makerLock.outcome);

export function remainingCkb(offer) {
  const held = (offer.fills ?? []).filter(fillHolds).reduce((s, f) => s + BigInt(f.ckbAmount), 0n);
  const left = BigInt(offer.ckbAmount) - held;
  return left > 0n ? left : 0n;
}

/** A piece is fine if it is at least the offer's minimum (or exactly what is left) and buys some USDC. */
export function pieceOk(offer, ckb) {
  ckb = BigInt(ckb);
  const left = remainingCkb(offer);
  const min = BigInt(offer.minCkb ?? offer.ckbAmount);
  return ckb > 0n && ckb <= left && (ckb >= min || ckb === left) && fillUsdc(offer, ckb) > 0n;
}

/**
 * The fills for "I give `amount` of `give`" (give "USDC" or "CKB", amount in that coin's units):
 * the best prices for the giver first, each piece inside its offer's limits, at most maxPieces.
 * Returns { parts: [{ offer, ckb, usdc }], left }, amounts as bigint units.
 */
export function quoteFills(offers, { give, amount, asset = give === "CKB" ? "USDC" : give, maxPieces = 5, filter = () => true }) {
  // giveUsdc: the taker gives the other coin (USDC or BTC) and gets CKB.
  const giveUsdc = give !== "CKB";
  const pool = offers
    .filter((o) => o.status === "open" && assetOf(o) === asset && (o.makerGives === "CKB") === giveUsdc && filter(o))
    .sort((a, b) => (giveUsdc ? offerPrice(a) - offerPrice(b) : offerPrice(b) - offerPrice(a)));
  let left = BigInt(amount);
  const parts = [];
  for (const o of pool) {
    if (left <= 0n || parts.length >= maxPieces) break;
    const rem = remainingCkb(o);
    // Giving the other coin: the CKB rounded up, so the piece takes exactly what was typed (rounded
    // down twice, 1 USDC typed became 0.999999; the taker now gets at most one shannon more).
    let ckb = giveUsdc ? (left * BigInt(o.ckbAmount) + BigInt(o.usdcAmount) - 1n) / BigInt(o.usdcAmount) : left;
    if (ckb > rem) ckb = rem;
    if (!pieceOk(o, ckb)) continue;
    const usdc = fillUsdc(o, ckb);
    parts.push({ offer: o, ckb, usdc });
    left -= giveUsdc ? usdc : ckb;
  }
  return { parts, left };
}
