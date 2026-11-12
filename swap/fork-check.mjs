// Sanity check of the fork: Train and USDC have code, and the funding helper works.
import { provider, TRAIN, USDC, forkFund, usdc, fmtUsdc, train } from "./evm.mjs";
import { ethers } from "ethers";
const code = async (a) => ((await provider.getCode(a)).length - 2) / 2;
console.log("chain", (await provider.getNetwork()).chainId, "Train code bytes", await code(TRAIN), "USDC code bytes", await code(USDC));
const probe = ethers.Wallet.createRandom().address;
const slot = await forkFund(probe, 5_000_000n);
console.log("USDC balance slot", slot, "probe balance", fmtUsdc(await usdc(provider).balanceOf(probe)));
const none = await train(provider).getUserLock(ethers.ZeroHash);
console.log("getUserLock(0) status", none.status, "sender", none.sender);
