// Public Base Sepolia: moves the funder's test ETH (gas) to Alice and Bob, and its test USDC to Alice.
// The funder is the pay-tests key (testnet only). Never prints a key.
import { ethers } from "ethers";
import fs from "node:fs";
const p = new ethers.JsonRpcProvider("https://sepolia.base.org", 84532, { staticNetwork: true });
const funder = new ethers.NonceManager(new ethers.Wallet(fs.readFileSync(process.env.FUNDER_KEY ?? "./keys/funder.key", "utf8").trim(), p));
const USDC = new ethers.Contract("0x036CbD53842c5426634e7929541eC2318f3dCF7e", ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"], funder);
const alice = "0xe385727fDe3C99225610C64B60190772aF914607", bob = "0x85D3546341D416Afe459A0EE3d8a2705C986421f";
const eth = ethers.parseEther(process.env.GAS_ETH ?? "0.0004");
for (const to of [alice, bob]) {
  if ((await p.getBalance(to)) >= eth / 2n) { console.log("has gas already", to); continue; }
  const r = await (await funder.sendTransaction({ to, value: eth })).wait();
  console.log("gas to", to, r.hash);
}
const u = await USDC.balanceOf(await funder.getAddress());
if (u > 0n) { const r = await (await USDC.transfer(alice, u)).wait(); console.log("USDC to Alice", ethers.formatUnits(u, 6), r.hash); }
else console.log("funder has no USDC yet");
process.exit(0);
