// Deploys build/htlc-lock to CKB testnet as a code cell (data2), once. Writes deploy.testnet.json.
import { ccc } from "@ckb-ccc/core";
import fs from "node:fs";
import path from "node:path";
import { HERE, DEPLOY_JSON, client, ckbSigner, waitTx } from "./common.mjs";

const bin = fs.readFileSync(path.join(HERE, "..", "build", "htlc-lock"));
const data = ccc.hexFrom(bin);
const dataHash = ccc.hashCkb(data);
if (fs.existsSync(DEPLOY_JSON)) {
  const d = JSON.parse(fs.readFileSync(DEPLOY_JSON, "utf8"));
  const live = await client.getCellLive({ txHash: d.txHash, index: d.index }, true);
  if (live && d.dataHash === dataHash) { console.log("already deployed:", d); process.exit(0); }
}
const signer = ckbSigner("deployer");
const lock = (await signer.getRecommendedAddressObj()).script;
const tx = ccc.Transaction.from({ outputs: [{ lock }], outputsData: [data] });
await tx.completeInputsByCapacity(signer);
await tx.completeFeeBy(signer, 1000);
const hash = await signer.sendTransaction(tx);
await waitTx(hash, "deploy");
const d = { network: "testnet", txHash: hash, index: 0, dataHash, hashType: "data2", bytes: bin.length,
  binarySha256: (await import("node:crypto")).createHash("sha256").update(bin).digest("hex") };
fs.writeFileSync(DEPLOY_JSON, JSON.stringify(d, null, 2) + "\n");
console.log(d);
process.exit(0);
