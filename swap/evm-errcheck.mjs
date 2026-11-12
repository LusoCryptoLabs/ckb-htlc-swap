// Fork only: an early refundUser and a wrong-secret redeemUser must revert with the named Train
// errors, and the recipient's early cancel must pass (Train lets the recipient refund any time).
import { ethers } from "ethers";
import crypto from "node:crypto";
import { wallet, train, usdc, forkFund, evmNow, TRAIN, TOKEN, FORK } from "./evm.mjs";

if (!FORK) throw new Error("fork only");
const alice = wallet("alice");
const bob = wallet("bob");
await forkFund(alice.address, 1_000_000n);
await forkFund(bob.address, 0n);
const H = ethers.sha256(crypto.randomBytes(32));
await (await usdc(alice).approve(TRAIN, 1_000_000n)).wait();
await (await train(alice).userLock(
  { hashlock: H, amount: 1_000_000n, rewardAmount: 0n, timelockDelta: 600, rewardTimelockDelta: 0, quoteExpiry: (await evmNow()) + 600,
    recipient: bob.address, refundTo: alice.address, token: TOKEN, payoutCurve: ethers.ZeroAddress, payoutCurveData: "0x",
    rewardToken: "", rewardRecipient: "", srcChain: "x" },
  { dstChain: "", dstAddress: "", dstAmount: 0n, dstToken: "" }, "0x", "0x")).wait();
for (const [label, call] of [
  ["early refund by Alice", () => train(alice).refundUser.staticCall(H)],
  ["redeem with a wrong secret", () => train(bob).redeemUser.staticCall(H, 12345n)],
]) {
  try {
    await call();
    console.log(label, "-> ACCEPTED");
  } catch (e) {
    console.log(label, "->", e.revert?.name ?? e.shortMessage);
  }
}
await train(bob).refundUser.staticCall(H);
console.log("control: Bob (the recipient) cancels early -> accepted");
process.exit(0);
