// Attacks against the deployed htlc-lock through the node's full verifier (test_tx_pool_accept),
// nothing sent except the cell under test and the honest refund at the end.
//
// The cell's timeout is already behind the chain's median time, so every `since` the attacks use is
// mature: a refusal comes from the lock (Inputs[0].Lock, its error code), not from consensus timing.
// Each attack sits next to the honest version of the same transaction, which must be accepted.
import { ccc } from "@ckb-ccc/core";
import crypto from "node:crypto";
import { client, ckbSigner, sha256, deployment, htlcScript, cellDep, waitTx, medianTimeSec, SINCE_TS } from "./common.mjs";

const d = deployment();
const bob = ckbSigner("bob");
const aliceLock = (await ckbSigner("alice").getRecommendedAddressObj()).script;
const bobLock = (await bob.getRecommendedAddressObj()).script;
const malloryLock = (await ckbSigner("deployer").getRecommendedAddressObj()).script;
const CAP = ccc.fixedPointFrom("300");
const FEE = 10000n;

const secret = crypto.randomBytes(32);
const H = sha256(secret);
const timeoutSec = (await medianTimeSec()) - 60;
const lock = htlcScript(d, { hashlock: H, recipientLock: aliceLock, senderLock: bobLock, timeoutSec });
const fund = ccc.Transaction.from({ outputs: [{ lock, capacity: CAP }], outputsData: ["0x"] });
await fund.completeInputsByCapacity(bob);
await fund.completeFeeBy(bob, 1000);
const fundHash = await bob.sendTransaction(fund);
await waitTx(fundHash, "cell under test");
const outPoint = { txHash: fundHash, index: 0 };

function build({ since = 0n, preimage, outputs }) {
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: outPoint, since }],
    outputs: outputs.map(([l, c]) => ({ lock: l, capacity: c })),
    outputsData: outputs.map(() => "0x"),
    cellDeps: [cellDep(d)],
  });
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from(preimage ? { lock: ccc.hexFrom(preimage) } : {}));
  return tx;
}

async function dry(tx) {
  try {
    await client.sendTransactionDry(tx, "passthrough");
    return "accepted";
  } catch (e) {
    const m = String(e.message ?? e);
    const code = m.match(/error code (-?\d+)/);
    return code ? `refused by ${e.source ?? "script"} with error ${code[1]}` : `refused: ${m.slice(0, 160)}`;
  }
}

const since = SINCE_TS | BigInt(timeoutSec);
const cases = [
  ["honest claim: secret, all to Alice", build({ preimage: secret, outputs: [[aliceLock, CAP - FEE]] }), "accepted"],
  ["claim with a wrong secret", build({ preimage: crypto.randomBytes(32), outputs: [[aliceLock, CAP - FEE]] }), "8"],
  ["claim paying Mallory", build({ preimage: secret, outputs: [[malloryLock, CAP - FEE]] }), "11"],
  ["claim with 100 CKB to Alice, the rest to Mallory", build({ preimage: secret, outputs: [[aliceLock, ccc.fixedPointFrom("100")], [malloryLock, CAP - ccc.fixedPointFrom("100") - FEE]] }), "14"],
  ["claim leaving 0.02 CKB as fee (cap 0.01)", build({ preimage: secret, outputs: [[aliceLock, CAP - 2_000_000n]] }), "14"],
  ["honest refund: since at the timeout, to Bob", build({ since, outputs: [[bobLock, CAP - FEE]] }), "accepted"],
  ["refund with since one second before the timeout (mature on chain)", build({ since: since - 1n, outputs: [[bobLock, CAP - FEE]] }), "9"],
  ["refund paying Alice", build({ since, outputs: [[aliceLock, CAP - FEE]] }), "11"],
  ["refund with a block-number since (block 1000, mature)", build({ since: 1000n, outputs: [[bobLock, CAP - FEE]] }), "9"],
];

let bad = 0;
for (const [name, tx, want] of cases) {
  const got = await dry(tx);
  const ok = want === "accepted" ? got === "accepted" : got.endsWith(`error ${want}`);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${got}${ok ? "" : ` (expected ${want})`}`);
}

// Clean up: Bob takes the cell back with the honest refund.
const refund = build({ since, outputs: [[bobLock, CAP - FEE]] });
const h = await client.sendTransaction(refund);
await waitTx(h, "refund of the cell under test");
console.log(bad ? `${bad} case(s) did not behave` : "all cases behaved");
process.exit(bad ? 1 : 0);
