// Prints the testnet address and CKB balance of a key file (never prints the key).
import { ccc } from "@ckb-ccc/core";
import fs from "node:fs";
const client = new ccc.ClientPublicTestnet();
for (const f of process.argv.slice(2)) {
  const key = fs.readFileSync(f, "utf8").trim();
  const signer = new ccc.SignerCkbPrivateKey(client, key);
  const addr = await signer.getRecommendedAddress();
  const bal = await signer.getBalance();
  console.log(f.split(/[\/]/).pop(), addr, ccc.fixedPointToString(bal), "CKB");
}
process.exit(0);
