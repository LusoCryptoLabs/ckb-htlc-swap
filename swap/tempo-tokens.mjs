// Reads the faucet transactions on Tempo Moderato: which tokens arrived, symbols, decimals, balances.
import { ethers } from "ethers";
const p = new ethers.JsonRpcProvider("https://rpc.moderato.tempo.xyz", 42431, { staticNetwork: true });
const erc = ["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"];
const T = ethers.id("Transfer(address,address,uint256)");
const [addr, ...hashes] = process.argv.slice(2);
const seen = new Map();
for (const h of hashes) {
  const r = await p.getTransactionReceipt(h);
  for (const l of r?.logs ?? []) if (l.topics[0] === T) seen.set(l.address, true);
}
for (const t of seen.keys()) {
  const c = new ethers.Contract(t, erc, p);
  const [s, n, d, b] = await Promise.all([c.symbol(), c.name(), c.decimals(), c.balanceOf(addr)]);
  console.log(t, s, `"${n}"`, d, ethers.formatUnits(b, d));
}
console.log("native balance", (await p.getBalance(addr)).toString());
