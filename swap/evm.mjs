// EVM leg: the Train contract and Circle's test USDC on Base Sepolia (or a local anvil fork of it).
import { ethers } from "ethers";
import { readKey } from "./common.mjs";

// EVM_CHAIN picks the chain. Base Sepolia uses Circle's test USDC; its default RPC is a local fork
// (EVM_RPC=https://sepolia.base.org for the public chain). Tempo Moderato is public, has a faucet
// RPC (tempo_fundAddress) and pays gas in stablecoins; Train has its own deployment there.
const CHAINS = {
  "base-sepolia": { rpc: "http://127.0.0.1:8545", chainId: 84532, train: "0x265978c3e2E5dB9C3Ea665cC40C5925A5fc13Ee8",
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC" },
  "tempo-moderato": { rpc: "https://rpc.moderato.tempo.xyz", chainId: 42431, train: "0xCb74407724c463EAA9bC661818364b532F8B5Cb5",
    token: "0x20C0000000000000000000000000000000000000", symbol: "PathUSD" },
};
export const CHAIN = process.env.EVM_CHAIN ?? "base-sepolia";
const C = CHAINS[CHAIN];
if (!C) throw new Error(`unknown EVM_CHAIN ${CHAIN}`);
export const EVM_RPC = process.env.EVM_RPC ?? C.rpc;
export const FORK = EVM_RPC.includes("127.0.0.1") || EVM_RPC.includes("localhost");
export const TRAIN = C.train;
export const TOKEN = process.env.EVM_TOKEN ?? C.token;
export const SYMBOL = process.env.EVM_TOKEN ? "token" : C.symbol;
export const USDC = TOKEN;
export const provider = new ethers.JsonRpcProvider(EVM_RPC, C.chainId, { staticNetwork: true });
/** A signer that counts its own nonces (the fork can answer a stale pending nonce). */
export const wallet = (name) => {
  const w = new ethers.Wallet(readKey(name), provider);
  const m = new ethers.NonceManager(w);
  m.address = w.address;
  return m;
};

const LOCK_PARAMS = "tuple(bytes32 hashlock,uint256 amount,uint256 rewardAmount,uint48 timelockDelta,uint48 rewardTimelockDelta,uint48 quoteExpiry,address recipient,address refundTo,address token,address payoutCurve,bytes payoutCurveData,string rewardToken,string rewardRecipient,string srcChain)";
const DST = "tuple(string dstChain,string dstAddress,uint256 dstAmount,string dstToken)";
export const trainAbi = [
  `function userLock(${LOCK_PARAMS} params, ${DST} dst, bytes userData, bytes solverData) payable`,
  "function redeemUser(bytes32 hashlock, uint256 secret)",
  "function refundUser(bytes32 hashlock)",
  "function getUserLock(bytes32 hashlock) view returns (tuple(uint256 secret,uint256 amount,address sender,uint48 timelock,uint48 startTime,uint8 status,address recipient,address refundTo,address token,address payoutCurve,bytes payoutCurveData))",
  "event UserRedeemed(bytes32 indexed hashlock, address redeemer, uint256 secret, uint256 payout, uint256 excess)",
  "error RefundNotAllowed()", "error LockNotPending()", "error LockNotFound()", "error HashlockMismatch()",
  "error QuoteExpired()", "error SwapAlreadyExists()", "error InvalidTimelock()", "error ZeroAmount()",
];
export const erc20Abi = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
export const train = (runner) => new ethers.Contract(TRAIN, trainAbi, runner);
export const usdc = (runner) => new ethers.Contract(USDC, erc20Abi, runner);
export const STATUS = ["Empty", "Pending", "Refunded", "Redeemed"];
export const fmtUsdc = (v) => ethers.formatUnits(v, 6);

/** Fork only: give an address test ETH and test USDC by writing the token's balance slot. */
export async function forkFund(addr, usdcAmount) {
  if (!FORK) throw new Error("forkFund is for the local fork only");
  await provider.send("anvil_setBalance", [addr, ethers.toQuantity(ethers.parseEther("1"))]);
  if (!usdcAmount) return;
  const token = usdc(provider);
  const want = BigInt(usdcAmount);
  for (let slot = 0; slot < 20; slot++) {
    const key = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, slot]));
    const before = await provider.send("eth_getStorageAt", [USDC, key, "latest"]);
    await provider.send("anvil_setStorageAt", [USDC, key, ethers.toBeHex(want, 32)]);
    if ((await token.balanceOf(addr)) === want) return slot;
    await provider.send("anvil_setStorageAt", [USDC, key, before]);
  }
  throw new Error("USDC balance slot not found");
}

/** The fork's clock moves only with blocks; this moves it forward (refund tests). */
export async function forkWarp(seconds) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

export async function evmNow() {
  // On the fork the latest block can be old (no traffic, or a warp long ago): mine one first so
  // its timestamp is the clock the next transaction will see.
  if (FORK) await provider.send("evm_mine", []);
  return Number((await provider.getBlock("latest")).timestamp);
}
