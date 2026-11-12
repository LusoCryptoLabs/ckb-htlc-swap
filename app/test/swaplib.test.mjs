// Rules of the shared library that the server and the page both rely on. Offline: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ccc } from "@ckb-ccc/core";
import { ethers } from "ethers";
import {
  NET, T, SINCE_TS, htlcScript, parseHtlcArgs, htlcSpendTx, makerTimeout, trainLockParams, fmtUsdc, parseUsdc, legs,
  WINDOWS, setWindows, timingsFor, makerDeadline, windowsFor, oldTakerLock, fmtWindow, fillUsdc, fillHolds, remainingCkb, pieceOk, quoteFills,
} from "../shared/swaplib.mjs";

const H = ethers.sha256("0x" + "07".repeat(32));
const R = "0x" + "11".repeat(32);
const S = "0x" + "22".repeat(32);

test("htlc args: 112 bytes, read back as written", () => {
  const lock = htlcScript({ hashlock: H, recipientLockHash: R, senderLockHash: S, timeoutSec: 1_794_225_600 });
  assert.equal(ccc.bytesFrom(lock.args).length, 112);
  assert.equal(lock.codeHash, NET.htlc.codeHash);
  assert.equal(lock.hashType, "data2");
  const a = parseHtlcArgs(lock.args);
  assert.equal(a.hashlock, H);
  assert.equal(a.recipient, R);
  assert.equal(a.sender, S);
  assert.equal(a.metric, 0x40);
  assert.equal(a.timeoutSec, 1_794_225_600);
  assert.equal(a.maxFee, T.maxFee);
  assert.equal(parseHtlcArgs("0x" + "00".repeat(111)), null);
});

function cell(capacity) {
  const lock = htlcScript({ hashlock: H, recipientLockHash: R, senderLockHash: S, timeoutSec: 1_794_225_600 });
  return { outPoint: ccc.OutPoint.from({ txHash: "0x" + "33".repeat(32), index: 0 }), cellOutput: ccc.CellOutput.from({ capacity, lock }) };
}
const to = ccc.Script.from({ codeHash: "0x" + "44".repeat(32), hashType: "type", args: "0x" });

test("a claim carries the secret, since 0, and pays all but a small fee", () => {
  const secret = "0x" + "07".repeat(32);
  const tx = htlcSpendTx(cell(500n * 100_000_000n), { secret, toLock: to });
  assert.equal(tx.inputs[0].since, 0n);
  assert.equal(ccc.WitnessArgs.fromBytes(tx.witnesses[0]).lock, secret);
  const fee = 500n * 100_000_000n - tx.outputs[0].capacity;
  assert.ok(fee >= 10_000n && fee <= T.maxFee, `fee ${fee}`);
  assert.ok(tx.outputs[0].lock.eq(to));
});

test("a refund has no witness lock and the timeout as an absolute timestamp since", () => {
  const tx = htlcSpendTx(cell(500n * 100_000_000n), { toLock: to, timeoutSec: 1_794_225_600 });
  assert.equal(tx.inputs[0].since, SINCE_TS | 1_794_225_600n);
  assert.equal(ccc.WitnessArgs.fromBytes(tx.witnesses[0]).lock, undefined);
});

test("the maker's lock ends at most an hour out and 40 minutes before the taker's", () => {
  const now = 1_000_000;
  assert.equal(makerTimeout(now, now + 7200), now + 3600);
  assert.equal(makerTimeout(now, now + 4000), now + 4000 - T.makerBeforeTaker);
});

test("Train locks are solver locks with no reward and no payout curve, in USDC", () => {
  const [p, dst, data] = trainLockParams({ hashlock: H, amount: 5_000_000n, recipient: ethers.ZeroAddress.replace(/0$/, "1"),
    refundTo: ethers.ZeroAddress.replace(/0$/, "2"), timelockDelta: 3600, dstAddress: "ckt1", dstAmount: 1n });
  assert.equal(p.reward, 0n);
  assert.equal(p.payoutCurve, ethers.ZeroAddress);
  assert.equal(p.token, NET.usdc);
  assert.equal(p.hashlock, H);
  assert.equal(data, "0x");
  assert.equal(dst.dstToken, "CKB");
  assert.ok(!("quoteExpiry" in p), "a user-lock field in a solver lock");
});

test("amounts", () => {
  assert.equal(fmtUsdc(2_000_000n), "2");
  assert.equal(fmtUsdc(2_500_000n), "2.5");
  assert.equal(parseUsdc("0.01"), 10_000n);
  assert.deepEqual(legs({ makerGives: "CKB" }), { takerChain: "evm", makerChain: "ckb" });
  assert.deepEqual(legs({ makerGives: "USDC" }), { takerChain: "ckb", makerChain: "evm" });
});

test("price: USDC to CKB and back, and how far from the market", async () => {
  const { ckbForUsdc, usdcForCkb, offerPrice, vsMarket, fmtPct } = await import("../shared/swaplib.mjs");
  const c = ckbForUsdc(5_000_000n, "0.00092"); // 5 USDC
  assert.equal(c, 543_478_000_000n); // 5434.78 CKB, rounded down to 0.01
  assert.equal(usdcForCkb(c, "0.00092"), 5_000_000n);
  assert.equal(usdcForCkb(30_000_000_000n, "0.0066667"), 2_000_000n); // 300 CKB at 0.0066667
  assert.ok(Math.abs(offerPrice({ usdcAmount: "2000000", ckbAmount: "30000000000" }) - 0.0066667) < 1e-6);
  assert.equal(fmtPct(vsMarket(0.000911, 0.00092)), "-1.0%");
  assert.equal(fmtPct(vsMarket(0.00092, 0.00092)), "0.0%");
  assert.equal(fmtPct(vsMarket(0.0009216, 0.00092161)), "0.0%"); // rounding of the shown price is not a premium
  assert.throws(() => ckbForUsdc(1n, "0"));
});

test("response window: the maker comes back within the window and locks for the pair's shortest one", () => {
  const t0 = 1_800_000_000;
  for (const asset of ["USDC", "BTC"]) {
    const shortest = Math.min(...windowsFor(asset));
    for (const w of windowsFor(asset)) {
      const t = timingsFor(w, asset);
      const takerTimeout = t0 + t.takerLock;
      assert.equal(t.makerLock, shortest, `${asset} ${w}: the maker's lock never runs longer than the shortest window`);
      assert.equal(t.takerLock, w + shortest + t.makerBeforeTaker);
      assert.equal(makerDeadline(takerTimeout, t), t0 + w, `${asset} ${w}: the maker may still come back for the whole window`);
      for (const back of [t0 + 60, t0 + w - 1]) {
        const mt = makerTimeout(back, takerTimeout, t);
        assert.equal(mt - back, shortest);
        assert.ok(mt <= takerTimeout - t.makerBeforeTaker);
        // so the taker has the shortest window, less the reveal margin, to reveal: never the whole window
        assert.ok(mt - t.revealMargin - back <= shortest - t.revealMargin);
      }
      // back after the window: refused (its lock would run less than it must)
      const tooLate = t0 + w + 60;
      assert.ok(makerTimeout(tooLate, takerTimeout, t) - tooLate < t.makerMinLeft);
    }
  }
  // the largest window of each pair, by number
  assert.equal(timingsFor(86400, "USDC").makerLock, 3600);
  assert.equal(timingsFor(86400, "BTC").makerLock, 6 * 3600);
  assert.equal(timingsFor(86400, "USDC").takerLock, 86400 + 3600 + 2400);
});

test("a taker lock made by a page from before the shorter maker lock is still accepted", () => {
  assert.equal(oldTakerLock(86400, "USDC"), 2 * 86400 + 2400);
  assert.equal(oldTakerLock(6 * 3600, "BTC"), 12 * 3600 + 7200);
  assert.equal(oldTakerLock(undefined), T.takerLock);
});

test("response window: offers without one keep the old timings", () => {
  assert.equal(timingsFor(undefined), T);
  assert.equal(makerDeadline(1_800_000_000 + T.takerLock), 1_800_000_000 + 3600);
  assert.deepEqual(WINDOWS.map(fmtWindow), ["1 h", "6 h", "12 h", "24 h"]);
  const before = [...WINDOWS];
  setWindows(["x"]); setWindows([]); setWindows([0]);
  assert.deepEqual(WINDOWS, before);
});

const C = (n) => BigInt(n) * 100_000_000n, U = (n) => BigInt(Math.round(n * 1e6));
const offer = (id, makerGives, ckb, usdc, minCkb, fills = []) => ({ id, status: "open", makerGives, ckbAmount: C(ckb).toString(), usdcAmount: U(usdc).toString(), minCkb: C(minCkb).toString(), fills });

test("fills: a piece keeps the offer's price and holds part of the offer", () => {
  const o = offer("a", "CKB", 10000, 9.2, 1000);
  assert.equal(fillUsdc(o, C(2500)), U(2.3));
  assert.equal(remainingCkb(o), C(10000));
  o.fills.push({ ckbAmount: C(2500).toString(), status: "taker-locked" });
  o.fills.push({ ckbAmount: C(1000).toString(), status: "refunded" }); // gave back
  o.fills.push({ ckbAmount: C(1000).toString(), status: "refunding" }); // maker never locked: gave back
  o.fills.push({ ckbAmount: C(500).toString(), status: "refunding", makerLock: { chain: "ckb" } }); // maker's coins still locked
  assert.equal(remainingCkb(o), C(7000));
  assert.ok(pieceOk(o, C(1000)));
  assert.ok(!pieceOk(o, C(999)), "below the minimum");
  assert.ok(!pieceOk(o, C(7001)), "more than is left");
  o.fills.push({ ckbAmount: C(6500).toString(), status: "done" });
  assert.equal(remainingCkb(o), C(500));
  assert.ok(pieceOk(o, C(500)), "what is left may be taken even below the minimum");
});

test("quote: best price first, limits kept, joined across offers", () => {
  const book = [
    offer("cheap", "CKB", 1000, 0.9, 500),
    offer("mid", "CKB", 5000, 4.6, 1000),
    offer("dear", "CKB", 50000, 47, 1000),
    offer("buyer", "USDC", 3000, 2.7, 1000), // wants CKB: not for a USDC giver
  ];
  const q = quoteFills(book, { give: "USDC", amount: U(7) });
  // with 6 USDC the 0.5 left would buy 531 CKB from "dear", under its 1000 minimum: skipped
  assert.deepEqual(quoteFills(book, { give: "USDC", amount: U(6) }).parts.map((p) => p.offer.id), ["cheap", "mid"]);
  assert.deepEqual(q.parts.map((p) => p.offer.id), ["cheap", "mid", "dear"]);
  assert.equal(q.parts[0].ckb, C(1000));
  assert.equal(q.parts[1].ckb, C(5000));
  assert.ok(q.parts[2].ckb >= C(1000), "the last piece is above the minimum");
  assert.equal(q.parts.reduce((s, p) => s + p.usdc, 0n) + q.left, U(7));
  assert.ok(q.left >= 0n && q.left < 1000n, "nothing left but dust");
  // a piece that would be under an offer's minimum is skipped, not shrunk
  const small = quoteFills(book, { give: "USDC", amount: U(0.3) });
  assert.equal(small.parts.length, 0);
  // the other way: giving CKB to the buyer
  const sell = quoteFills(book, { give: "CKB", amount: C(1500) });
  assert.deepEqual(sell.parts.map((p) => [p.offer.id, p.ckb]), [["buyer", C(1500)]]);
  assert.equal(sell.parts[0].usdc, U(1.35));
  // at most maxPieces
  assert.equal(quoteFills(book, { give: "USDC", amount: U(60), maxPieces: 2 }).parts.length, 2);
});

test("with BTC the secret is revealed only while the maker's lock has 3 h left", async () => {
  const { timingsFor, BTC_REVEAL_MARGIN } = await import("../shared/swaplib.mjs");
  assert.equal(BTC_REVEAL_MARGIN, 10800);
  for (const w of [6 * 3600, 12 * 3600, 24 * 3600]) {
    const t = timingsFor(w, "BTC");
    assert.equal(t.revealMargin, 10800);
    // the maker's lock still leaves time to reveal after the margin
    assert.ok(t.makerLock > t.revealMargin + 3600);
  }
  assert.equal(timingsFor(3600, "USDC").revealMargin, 600);
});


test("ETH is a pair of its own: 18 decimals, Train's native token, its amount in `eth`", async () => {
  const { ASSETS, assetOf, tokenOf, amountKey, legs, NET, trainLockParams } = await import("../shared/swaplib.mjs");
  const { ethers } = await import("ethers");
  assert.equal(ASSETS.ETH.parse("0.0001"), 100_000_000_000_000n);
  assert.equal(ASSETS.ETH.fmt(100_000_000_000_000n), "0.0001");
  assert.equal(ASSETS.ETH.chain, "evm");
  assert.equal(tokenOf({ asset: "ETH" }), ethers.ZeroAddress);
  assert.equal(tokenOf({ asset: "USDC" }), NET.usdc);
  assert.equal(tokenOf({}), NET.usdc, "an offer from before pairs is USDC");
  assert.equal(assetOf({ asset: "DOGE" }), "USDC", "an unknown asset is not taken for another");
  assert.deepEqual([amountKey("USDC"), amountKey("ETH"), amountKey("BTC")], ["usdc", "eth", "btc"]);
  assert.deepEqual(legs({ asset: "ETH", makerGives: "CKB" }), { takerChain: "evm", makerChain: "ckb" });
  const [p] = trainLockParams({ token: tokenOf({ asset: "ETH" }), hashlock: "0x" + "11".repeat(32), amount: 1n, recipient: ethers.ZeroAddress.replace(/0$/, "1"), refundTo: ethers.ZeroAddress.replace(/0$/, "2"), timelockDelta: 600, dstAddress: "ckt1", dstAmount: 1n });
  assert.equal(p.token, ethers.ZeroAddress, "the lock names ETH's token");
});

test("typing 1 USDC takes exactly 1 USDC, not 0.999999 (the CKB is rounded up, at most one shannon)", () => {
  // The market maker's real offers of 2026-11-10: each made 1 USDC typed into 0.999999 when rounded down twice.
  for (const usdcAmount of ["9577800", "9652000", "9600750", "9445200"]) {
    const o = { id: "x", status: "open", asset: "USDC", makerGives: "CKB", ckbAmount: "1000000000000", usdcAmount, minCkb: "50000000000", fills: [] };
    const { parts, left } = quoteFills([o], { give: "USDC", amount: 1_000_000n });
    assert.equal(parts.length, 1);
    assert.equal(parts[0].usdc, 1_000_000n, `offer ${usdcAmount}: the piece takes the 1 USDC typed`);
    assert.equal(left, 0n);
    assert.equal(parts[0].usdc, fillUsdc(o, parts[0].ckb), "the piece is the offer's price, as the book and the maker check it");
    assert.ok(parts[0].ckb - (1_000_000n * 1_000_000_000_000n) / BigInt(usdcAmount) <= 1n, "at most one shannon more than rounding down gave");
  }
});
