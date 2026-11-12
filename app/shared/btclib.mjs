// The Bitcoin side of a swap (testnet3), shared by the server and the page. No key here.
//
// Each swap pays to its own P2WSH address whose script holds the terms (swap/btc.mjs, the proof):
//
//   OP_IF
//     OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <recipient pubkey>
//   OP_ELSE
//     <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <sender pubkey>
//   OP_ENDIF
//   OP_CHECKSIG
//
// Unlike CKB's htlc-lock and Train, the script cannot say where the coins go, so a claim and a
// refund each need their owner's signature. To keep "nothing to do" for people, as on the other
// chains, both are signed ahead (as Lightning does): the sender signs the refund when it locks
// (valid only after the locktime), the recipient signs the claim with a placeholder where the
// secret goes (the signature does not cover the witness), and the book's watcher sends either at
// its time. Both pay only their own signer, so handing them to the book gives it nothing.
import * as bitcoin from "bitcoinjs-lib";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const BTC = {
  net: bitcoin.networks.testnet,
  apis: ["https://mempool.space/testnet/api", "https://blockstream.info/testnet/api"],
  explorer: "https://mempool.space/testnet/tx/",
  conf: 1, // blocks a BTC lock must be buried under before the other side relies on it
  feeRate: 3, // sat/vB for the claims and refunds signed ahead
  dust: 546,
};
const OP = bitcoin.opcodes;
const u8 = (x) => (x instanceof Uint8Array ? x : typeof x === "string" ? Uint8Array.from(x.replace(/^0x/, "").match(/../g) ?? [], (h) => parseInt(h, 16)) : new Uint8Array(x));
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export const fmtBtc = (sats) => {
  const s = BigInt(sats), w = s / 100_000_000n, f = (s % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : `${w}`;
};
export function parseBtc(str) {
  const m = String(str).trim().replace(",", ".").match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error("bad BTC amount");
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0") || "0");
}

/** A compressed secp256k1 public key, as hex, or null. */
export function btcPubOk(hexPub) {
  try { const b = u8(hexPub); return b.length === 33 && (b[0] === 2 || b[0] === 3) && !!secp256k1.Point.fromBytes(b) ? toHex(b) : null; } catch { return null; }
}
export const p2wpkhOf = (pubHex) => { const p = bitcoin.payments.p2wpkh({ pubkey: u8(pubHex), network: BTC.net }); return { output: p.output, address: p.address }; };

export function htlcWitnessScript({ hashlock, recipientPub, senderPub, locktime }) {
  return bitcoin.script.compile([
    OP.OP_IF, OP.OP_SIZE, bitcoin.script.number.encode(32), OP.OP_EQUALVERIFY,
    OP.OP_SHA256, u8(hashlock), OP.OP_EQUALVERIFY, u8(recipientPub),
    OP.OP_ELSE, bitcoin.script.number.encode(locktime), OP.OP_CHECKLOCKTIMEVERIFY, OP.OP_DROP, u8(senderPub),
    OP.OP_ENDIF, OP.OP_CHECKSIG,
  ]);
}
/** The swap's P2WSH address for these terms. */
export function htlcPay(terms) {
  const witnessScript = htlcWitnessScript(terms);
  const p = bitcoin.payments.p2wsh({ redeem: { output: witnessScript }, network: BTC.net });
  return { witnessScript, output: p.output, address: p.address };
}

// ------------------------------------------------------------------ chain reads (esplora)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function btcApi(path, init) {
  let last;
  for (let i = 0; i < 6; i++) {
    const base = BTC.apis[i % BTC.apis.length];
    try {
      const r = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
      const body = await r.text();
      if (r.ok) return (r.headers.get("content-type") ?? "").includes("json") ? JSON.parse(body) : body;
      last = new Error(`${r.status} ${body}`.slice(0, 300));
      if (init?.method === "POST" || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw last;
    } catch (e) { last = e; if (init?.method === "POST") throw e; }
    await sleep(1500 * (i + 1));
  }
  throw last;
}
/** The tip's median time past: what a time locktime is judged against (BIP 113). */
export async function btcMedianTime() { const hash = await btcApi("/blocks/tip/hash"); return (await btcApi(`/block/${hash}`)).mediantime; }
export async function btcConfirmations(txid) {
  const st = await btcApi(`/tx/${txid}/status`);
  return st.confirmed ? Number(await btcApi("/blocks/tip/height")) - st.block_height + 1 : 0;
}
export async function btcBalance(address) {
  const a = await btcApi(`/address/${address}`);
  return BigInt(a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum + a.mempool_stats.funded_txo_sum - a.mempool_stats.spent_txo_sum);
}
/** Sends a raw transaction; the node's refusal comes back as an error with its reason. */
export const btcBroadcast = (hex) => btcApi("/tx", { method: "POST", body: hex });

/**
 * A swap's lock as the chain has it: the funding output for these terms and amount, its
 * confirmations, and what spent it: Pending, Redeemed (with the secret) or Refunded.
 */
export async function btcLockState({ txid, vout, sats, terms }) {
  const pay = htlcPay(terms);
  const tx = await btcApi(`/tx/${txid}`).catch(() => null);
  const o = tx?.vout?.[vout];
  if (!o || o.scriptpubkey !== toHex(pay.output) || BigInt(o.value) !== BigInt(sats)) return { status: "Empty", why: "no output of that amount to the swap's script" };
  const confirmations = tx.status?.confirmed ? Number(await btcApi("/blocks/tip/height")) - tx.status.block_height + 1 : 0;
  const s = await btcApi(`/tx/${txid}/outspend/${vout}`);
  if (!s.spent) return { status: "Pending", confirmations };
  const spend = await btcApi(`/tx/${s.txid}`);
  const w = spend.vin[s.vin].witness ?? [];
  if (w.length === 4 && w[1].length === 64 && toHex(sha256(u8(w[1]))) === terms.hashlock.replace(/^0x/, "")) return { status: "Redeemed", secret: "0x" + w[1], tx: s.txid, confirmations };
  return { status: "Refunded", tx: s.txid, confirmations };
}

// ------------------------------------------------------------------ claims and refunds signed ahead
const SIGHASH_ALL = 1;
/**
 * Checks a claim or a refund signed ahead for a swap's lock: it spends that output alone, under
 * this script, with the witness of its path, pays one output to `payToPub`'s own address for at
 * most `maxFee`, and carries a valid SIGHASH_ALL signature of `signerPub`. A refund also has the
 * script's locktime and a sequence that lets it count. The claim's secret is a placeholder.
 */
export function checkSignedSpend({ hex, kind, outpoint, sats, terms, signerPub, maxFee = 20_000 }) {
  let tx;
  try { tx = bitcoin.Transaction.fromHex(hex); } catch { return { ok: false, why: "not a transaction" }; }
  const pay = htlcPay(terms);
  if (tx.ins.length !== 1 || tx.outs.length !== 1) return { ok: false, why: "one input and one output expected" };
  const i = tx.ins[0];
  if (toHex(Uint8Array.from(i.hash).reverse()) !== outpoint.txid || i.index !== outpoint.vout) return { ok: false, why: "it spends another output" };
  const w = i.witness;
  const n = kind === "refund" ? 3 : 4;
  if (w.length !== n || !eq(w[n - 1], pay.witnessScript)) return { ok: false, why: "not this swap's script" };
  if (kind === "refund" && (w[1].length !== 0 || tx.locktime !== terms.locktime || i.sequence === 0xffffffff)) return { ok: false, why: "not a refund at the swap's locktime" };
  if (kind === "claim" && (w[1].length !== 32 || !eq(w[2], Uint8Array.of(1)))) return { ok: false, why: "not a claim" };
  if (!eq(tx.outs[0].script, p2wpkhOf(signerPub).output)) return { ok: false, why: "it pays someone other than its signer" };
  const fee = BigInt(sats) - BigInt(tx.outs[0].value);
  if (fee <= 0n || fee > BigInt(maxFee)) return { ok: false, why: `fee ${fee} sats` };
  const sig = w[0];
  if (sig[sig.length - 1] !== SIGHASH_ALL) return { ok: false, why: "not SIGHASH_ALL" };
  const hash = tx.hashForWitnessV0(0, pay.witnessScript, BigInt(sats), SIGHASH_ALL);
  let good = false;
  try { good = secp256k1.verify(sig.slice(0, -1), hash, u8(signerPub), { prehash: false, format: "der" }); } catch { good = false; }
  return good ? { ok: true, fee } : { ok: false, why: "the signature is not its signer's" };
}
/** A claim signed ahead, with the swap's secret in the place kept for it. */
export function claimWithSecret(hex, secret) {
  const tx = bitcoin.Transaction.fromHex(hex);
  const w = tx.ins[0].witness;
  tx.setWitness(0, [w[0], u8(secret), w[2], w[3]]);
  return tx.toHex();
}
/** The output of a funding transaction that pays these terms this amount, or -1. */
export function fundingVout(hex, terms, sats) {
  const tx = bitcoin.Transaction.fromHex(hex);
  const out = htlcPay(terms).output;
  return tx.outs.findIndex((o) => eq(o.script, out) && BigInt(o.value) === BigInt(sats));
}
export const txidOf = (hex) => bitcoin.Transaction.fromHex(hex).getId();

// ------------------------------------------------------------------ building (keys stay with the caller)
// `sign(hash32)` returns a 64-byte compact low-S signature: a wallet's passkey-derived key, or a
// test key. Every input is SIGHASH_ALL.
const der = (sig64) => bitcoin.script.signature.encode(u8(sig64), SIGHASH_ALL);
const rev = (hexId) => u8(hexId).reverse();

/**
 * A claim or a refund of a swap's lock, paying `ownPub` all but the fee; a claim has a placeholder
 * where the secret goes (claimWithSecret). `sequence`: 0xfffffffd lets a claim be replaced by one
 * with a higher fee (BIP 125); by default a claim does not ask for that and a refund only counts
 * from its locktime.
 */
export async function buildHtlcSpend({ outpoint, sats, terms, kind, ownPub, feeRate = BTC.feeRate, sign, sequence }) {
  const pay = htlcPay(terms);
  const make = async (fee, real) => {
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.locktime = kind === "refund" ? terms.locktime : 0;
    tx.addInput(rev(outpoint.txid), outpoint.vout, sequence ?? (kind === "refund" ? 0xfffffffe : 0xffffffff));
    tx.addOutput(p2wpkhOf(ownPub).output, BigInt(sats) - BigInt(fee));
    const sig = real ? der(await sign(tx.hashForWitnessV0(0, pay.witnessScript, BigInt(sats), SIGHASH_ALL))) : new Uint8Array(73);
    tx.setWitness(0, kind === "refund" ? [sig, new Uint8Array(0), pay.witnessScript] : [sig, new Uint8Array(32), Uint8Array.of(1), pay.witnessScript]);
    return tx;
  };
  const fee = Math.ceil((await make(0, false)).virtualSize() * feeRate);
  if (BigInt(sats) - BigInt(fee) < BigInt(BTC.dust)) throw new Error(`the lock's ${sats} sats do not cover the ${fee} sats fee`);
  return (await make(fee, true)).toHex();
}

/** Pays `sats` to a swap's script from p2wpkh coins of `ownPub` ([{ txid, vout, value }]), change back. */
export async function buildFunding({ coins, ownPub, terms, sats, feeRate = BTC.feeRate, sign }) {
  const own = p2wpkhOf(ownPub);
  const scriptCode = bitcoin.payments.p2pkh({ pubkey: u8(ownPub) }).output;
  const out = htlcPay(terms).output;
  const sorted = [...coins].sort((a, b) => b.value - a.value);
  const make = async (fee, real) => {
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    let total = 0n;
    const used = [];
    for (const c of sorted) {
      if (total >= BigInt(sats) + BigInt(fee) + BigInt(BTC.dust)) break;
      tx.addInput(rev(c.txid), c.vout, 0xfffffffd);
      used.push(c); total += BigInt(c.value);
    }
    if (total < BigInt(sats) + BigInt(fee)) throw new Error(`not enough BTC: have ${fmtBtc(total)}, need ${fmtBtc(BigInt(sats) + BigInt(fee))}`);
    tx.addOutput(out, BigInt(sats));
    const change = total - BigInt(sats) - BigInt(fee);
    if (change >= BigInt(BTC.dust)) tx.addOutput(own.output, change);
    for (let i = 0; i < used.length; i++) {
      const sig = real ? der(await sign(tx.hashForWitnessV0(i, scriptCode, BigInt(used[i].value), SIGHASH_ALL))) : new Uint8Array(73);
      tx.setWitness(i, [sig, u8(ownPub)]);
    }
    return tx;
  };
  const fee = Math.ceil((await make(1000, false)).virtualSize() * feeRate);
  return (await make(fee, true)).toHex();
}
/** The confirmed and unconfirmed coins of an address, from the chain. */
export const btcCoins = async (address) => (await btcApi(`/address/${address}/utxo`)).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
/** A signer from a test key (hex): for scripts and tests, never the page. */
export function keySigner(privHex) {
  const k = u8(privHex);
  return { pub: toHex(secp256k1.getPublicKey(k, true)), sign: async (h) => secp256k1.sign(h, k, { prehash: false, lowS: true, format: "compact" }) };
}
