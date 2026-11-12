// The Bitcoin side of a CKB <-> BTC swap, on Bitcoin testnet3. There is no contract to deploy:
// each swap pays to its own P2WSH address whose script holds the terms.
//
//   OP_IF
//     OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <recipient pubkey>
//   OP_ELSE
//     <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <sender pubkey>
//   OP_ENDIF
//   OP_CHECKSIG
//
// The recipient claims with [sig, secret, 0x01]; the sender refunds with [sig, ""] once the
// chain's median time has passed the locktime. The size check matters: the CKB lock takes a
// 32-byte secret only, so a longer preimage of the same H must not open the Bitcoin side either.
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import fs from "node:fs";
import { readKey } from "./common.mjs";

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const OP = bitcoin.opcodes;
export const BTC_NET = bitcoin.networks.testnet;
export const BTC_API = process.env.BTC_API ?? "https://mempool.space/testnet/api";
export const BTC_CONF = Number(process.env.BTC_CONF ?? 1);
export const FEE_RATE = Number(process.env.BTC_FEE_RATE ?? 2); // sat/vB
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A testnet key from the swap keys (the same secp256k1 keys the CKB and EVM sides use). */
export function btcKey(nameOrFile) {
  const hex = nameOrFile.includes("/") ? fs.readFileSync(nameOrFile, "utf8").trim() : readKey(nameOrFile);
  const kp = ECPair.fromPrivateKey(Buffer.from(hex.replace(/^0x/, ""), "hex"), { network: BTC_NET });
  const pubkey = Buffer.from(kp.publicKey);
  const pay = bitcoin.payments.p2wpkh({ pubkey, network: BTC_NET });
  return { kp, pubkey, address: pay.address, output: pay.output, signer: { publicKey: pubkey, sign: (h) => Buffer.from(kp.sign(h)) } };
}

/** The swap script. `sizeCheck: false` exists only for the control that proves the size rule. */
export function htlcWitnessScript({ hashlock, recipientPub, senderPub, locktime, sizeCheck = true }) {
  return bitcoin.script.compile([
    OP.OP_IF,
    ...(sizeCheck ? [OP.OP_SIZE, bitcoin.script.number.encode(32), OP.OP_EQUALVERIFY] : []),
    OP.OP_SHA256, Buffer.from(hashlock), OP.OP_EQUALVERIFY, recipientPub,
    OP.OP_ELSE,
    bitcoin.script.number.encode(locktime), OP.OP_CHECKLOCKTIMEVERIFY, OP.OP_DROP, senderPub,
    OP.OP_ENDIF,
    OP.OP_CHECKSIG,
  ]);
}

export function htlcPayment(terms) {
  const ws = htlcWitnessScript(terms);
  const p = bitcoin.payments.p2wsh({ redeem: { output: ws }, network: BTC_NET });
  return { witnessScript: ws, output: p.output, address: p.address };
}

// ---------- chain reads (mempool.space esplora API) ----------
export async function api(path, init) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${BTC_API}${path}`, init).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (r.ok) return (r.headers.get("content-type") ?? "").includes("json") ? r.json() : r.text();
    const body = await r.text();
    if (init?.method === "POST" || i >= 4 || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw new Error(`${r.status} ${body}`.slice(0, 400));
    await sleep(2000 * (i + 1));
  }
}

/** The tip's median time past: what a time locktime is judged against (BIP 113). */
export async function btcMedianTime() {
  const hash = await api("/blocks/tip/hash");
  return (await api(`/block/${hash}`)).mediantime;
}

export async function confirmations(txid) {
  const st = await api(`/tx/${txid}/status`);
  if (!st.confirmed) return 0;
  return Number(await api("/blocks/tip/height")) - st.block_height + 1;
}

export async function waitConfirmations(txid, n, label) {
  const t0 = Date.now();
  while ((await confirmations(txid)) < n) {
    if (Date.now() - t0 > 6 * 3600_000) throw new Error(`${label}: ${txid} not confirmed in 6 h`);
    await sleep(15000);
  }
  console.log(`  ${label}: ${txid} has ${n} confirmation(s) after ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

/** Broadcast. A refusal comes back as { refused } with the node's reason, nothing thrown. */
export async function broadcast(tx) {
  try {
    const txid = await api("/tx", { method: "POST", body: tx.toHex() });
    return { txid };
  } catch (e) {
    return { refused: String(e.message ?? e) };
  }
}

// ---------- building ----------
/** Pays `outputs` ([{ script, value }]) from a p2wpkh key, change back to it. Two passes for the fee. */
export async function fundOutputs(from, outputs) {
  const utxos = (await api(`/address/${from.address}/utxo`)).sort((a, b) => b.value - a.value);
  const need = outputs.reduce((s, o) => s + o.value, 0);
  const build = (fee) => {
    const psbt = new bitcoin.Psbt({ network: BTC_NET });
    let total = 0;
    for (const u of utxos) {
      if (total >= need + fee + 546) break;
      psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: from.output, value: u.value } });
      total += u.value;
    }
    if (total < need + fee + 546) throw new Error(`not enough sats on ${from.address}: have ${total}, need ${need + fee + 546}`);
    for (const o of outputs) psbt.addOutput({ script: o.script, value: o.value });
    psbt.addOutput({ script: from.output, value: total - need - fee });
    psbt.signAllInputs(from.signer);
    psbt.finalizeAllInputs();
    return psbt.extractTransaction();
  };
  const draft = build(1000);
  return build(Math.ceil(draft.virtualSize() * FEE_RATE));
}

function witnessStack(items) {
  const parts = [Buffer.from([items.length])];
  for (const it of items) parts.push(Buffer.from([it.length]), it);
  return Buffer.concat(parts);
}

/**
 * Spends one HTLC output. `path` is { secret } to claim or { refund: true } to refund.
 * `locktime` sets the transaction's nLockTime (a refund needs it at or above the script's).
 */
export function spendHtlc({ outpoint, value, pay, path, signer, to, locktime = 0, feeRate = FEE_RATE }) {
  const build = (fee) => {
    const psbt = new bitcoin.Psbt({ network: BTC_NET });
    psbt.setLocktime(locktime);
    psbt.addInput({
      hash: outpoint.txid, index: outpoint.vout, sequence: path.refund ? 0xfffffffe : 0xffffffff,
      witnessUtxo: { script: pay.output, value }, witnessScript: pay.witnessScript,
    });
    psbt.addOutput({ script: to, value: value - fee });
    psbt.signInput(0, signer);
    psbt.finalizeInput(0, (_, input) => {
      const sig = input.partialSig[0].signature;
      const stack = path.refund ? [sig, Buffer.alloc(0), pay.witnessScript] : [sig, Buffer.from(path.secret), Buffer.from([1]), pay.witnessScript];
      return { finalScriptSig: undefined, finalScriptWitness: witnessStack(stack) };
    });
    return psbt.extractTransaction();
  };
  return build(Math.ceil(build(300).virtualSize() * feeRate));
}

/** The counterparty's check: the funding transaction pays exactly this script and amount. */
export async function findHtlcOutput(txid, pay, value) {
  const tx = await api(`/tx/${txid}`);
  const vout = tx.vout.findIndex((o) => o.scriptpubkey === pay.output.toString("hex") && o.value === value);
  if (vout < 0) throw new Error(`no output of ${value} sats to the agreed script in ${txid}`);
  return { txid, vout };
}

/** Watcher: the secret from whatever spent the HTLC output, mempool included. */
export async function secretFromBtc(outpoint, hashlock, sha256) {
  for (let i = 0; i < 480; i++) {
    const s = await api(`/tx/${outpoint.txid}/outspend/${outpoint.vout}`);
    if (s.spent) {
      const tx = await api(`/tx/${s.txid}`);
      const w = tx.vin[s.vin].witness ?? [];
      const secret = Buffer.from(w[1] ?? "", "hex");
      if (w.length !== 4 || secret.length !== 32 || !sha256(secret).equals(Buffer.from(hashlock))) throw new Error(`spent without the secret (refund?) in ${s.txid}`);
      return { secret, txid: s.txid };
    }
    await sleep(5000);
  }
  throw new Error("BTC HTLC output not spent");
}
