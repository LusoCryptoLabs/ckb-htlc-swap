// Makes the testnet-only keys for the swap proof once (CKB secp256k1 and EVM). Never prints keys.
import { ccc } from "@ckb-ccc/core";
import { Wallet } from "ethers";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const dir = process.env.KEYS_DIR ?? "./keys";
const client = new ccc.ClientPublicTestnet();
const out = {};
for (const name of ["deployer", "alice", "bob"]) {
  const f = path.join(dir, `${name}.key`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, "0x" + crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const key = fs.readFileSync(f, "utf8").trim();
  const signer = new ccc.SignerCkbPrivateKey(client, key);
  out[name] = { ckb: await signer.getRecommendedAddress(), evm: new Wallet(key).address };
}
fs.writeFileSync(path.join(dir, "addresses.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
