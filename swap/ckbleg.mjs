// The CKB side of a swap with any parties: lock, check, claim, watch, refund. Same htlc-lock as
// swap.mjs; here the sender, recipient and amount are parameters instead of fixed roles.
import { ccc } from "@ckb-ccc/core";
import { client, sha256, htlcScript, cellDep, waitTx, MAX_FEE, SINCE_TS } from "./common.mjs";

export async function ckbLock(d, senderSigner, { hashlock, recipientLock, senderLock, timeoutSec, amount }) {
  const lock = htlcScript(d, { hashlock, recipientLock, senderLock, timeoutSec });
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: amount }], outputsData: ["0x"] });
  await tx.completeInputsByCapacity(senderSigner);
  await tx.completeFeeBy(senderSigner, 1000);
  const hash = await senderSigner.sendTransaction(tx);
  await waitTx(hash, "htlc cell");
  return { lock, outPoint: { txHash: hash, index: 0 } };
}

/** The other side's check before relying on the cell: exact lock, amount, no type, no data. */
export async function checkCkbCell(d, outPoint, terms, amount) {
  const cell = await client.getCellLive(outPoint, true);
  const want = htlcScript(d, terms);
  if (!cell || !cell.cellOutput.lock.eq(want) || cell.cellOutput.capacity !== amount || cell.cellOutput.type || cell.outputData !== "0x") {
    throw new Error("CKB cell does not match the terms");
  }
}

export const feeFor = (tx) => { const f = tx.estimateFee(1000n) * 3n; return f < 10000n ? 10000n : f; };

/** Claim with the secret. No signature: the lock pays the recipient's lock and nothing else. */
export async function ckbClaim(d, outPoint, amount, secret, toLock) {
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: outPoint, since: 0 }],
    outputs: [{ lock: toLock, capacity: amount }],
    outputsData: ["0x"],
    cellDeps: [cellDep(d)],
  });
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: ccc.hexFrom(secret) }));
  const fee = feeFor(tx);
  if (fee > MAX_FEE) throw new Error("fee above max fee");
  tx.outputs[0].capacity = amount - fee;
  const hash = await client.sendTransaction(tx);
  await waitTx(hash, "claim");
  return hash;
}

/** Watcher: the secret from the transaction that spent the HTLC cell. */
export async function secretFromCkb(lock, hashlock) {
  for (let i = 0; i < 240; i++) {
    const res = await fetch("https://testnet.ckb.dev/rpc", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_transactions", params: [{ script: { code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args },
        script_type: "lock", script_search_mode: "exact" }, "asc", "0x64"] }),
    }).then((r) => r.json());
    const spent = (res.result?.objects ?? []).find((o) => o.io_type === "input");
    if (spent) {
      const t = await client.getTransaction(spent.tx_hash);
      const w = ccc.WitnessArgs.fromBytes(t.transaction.witnesses[Number(spent.io_index)]);
      const s = Buffer.from(ccc.bytesFrom(w.lock ?? "0x"));
      if (s.length !== 32 || !sha256(s).equals(Buffer.from(hashlock))) throw new Error("spent without the secret (refund?)");
      return { secret: s, txHash: spent.tx_hash };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("HTLC cell not spent");
}

export function refundTx(d, outPoint, amount, sinceSec, toLock) {
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: outPoint, since: SINCE_TS | BigInt(sinceSec) }],
    outputs: [{ lock: toLock, capacity: amount }],
    outputsData: ["0x"],
    cellDeps: [cellDep(d)],
  });
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({}));
  tx.outputs[0].capacity = amount - feeFor(tx);
  return tx;
}

/** The node's full verifier, nothing sent. */
export async function poolAccept(tx) {
  try {
    await client.sendTransactionDry(tx, "passthrough");
    return { accepted: true };
  } catch (e) {
    return { refused: String(e.message ?? e).slice(0, 220) };
  }
}
