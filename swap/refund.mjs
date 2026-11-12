// Sweeps every live htlc-lock cell whose sender is one of SENDERS (default bob) and whose timeout has passed back to that sender.
// Cells still before their timeout are listed with the time left. No signature is needed.
import { ccc } from "@ckb-ccc/core";
import { client, ckbSigner, readKey, deployment, cellDep, waitTx, medianTimeSec, SINCE_TS } from "./common.mjs";
import { ethers } from "ethers";

const d = deployment();
// Senders: each key's secp256k1 lock and the Omnilock its EVM wallet uses on the order book page.
const senders = new Map();
for (const name of (process.env.SENDERS ?? "bob").split(",")) {
  const s = ckbSigner(name);
  const secp = (await s.getRecommendedAddressObj()).script;
  const omni = (await new ccc.SignerEvmAddressReadonly(client, new ethers.Wallet(readKey(name)).address).getRecommendedAddressObj()).script;
  for (const l of [secp, omni]) senders.set(Buffer.from(ccc.bytesFrom(l.hash())).toString("hex"), l);
}
const now = await medianTimeSec();
const FEE = 10000n;

const prefix = ccc.Script.from({ codeHash: d.dataHash, hashType: d.hashType, args: "0x" });
let swept = 0;
for await (const cell of client.findCellsOnChain({ script: prefix, scriptType: "lock", scriptSearchMode: "prefix" })) {
  const args = Buffer.from(ccc.bytesFrom(cell.cellOutput.lock.args));
  const senderLock = senders.get(args.subarray(64, 96).toString("hex"));
  if (args.length !== 112 || !senderLock) continue;
  const timeout = args.readBigUInt64LE(96);
  const sec = Number(timeout & 0x00ff_ffff_ffff_ffffn);
  const where = `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`;
  if ((timeout >> 56n) !== 0x40n) { console.log(`skip ${where}: not a timestamp timeout`); continue; }
  if (sec > now) { console.log(`wait ${where}: ${ccc.fixedPointToString(cell.cellOutput.capacity)} CKB, ${Math.ceil((sec - now) / 60)} min left`); continue; }
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: cell.outPoint, since: SINCE_TS | BigInt(sec) }],
    outputs: [{ lock: senderLock, capacity: cell.cellOutput.capacity - FEE, type: cell.cellOutput.type }],
    outputsData: [cell.outputData],
    cellDeps: [cellDep(d)],
  });
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({}));
  const h = await client.sendTransaction(tx);
  await waitTx(h, `refund ${where}`);
  swept++;
}
console.log(`swept ${swept}`);
process.exit(0);
