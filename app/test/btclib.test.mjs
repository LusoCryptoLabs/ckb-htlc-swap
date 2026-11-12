// The book's Bitcoin side (shared/btclib.mjs) against the proof's own code (swap/btc.mjs, bitcoinjs-lib 6):
// the same terms give the same address, and a refund and a claim signed there pass the checks here,
// while each way of getting them wrong is refused for its reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as bitcoin from "bitcoinjs-lib";
import { htlcPay, checkSignedSpend, claimWithSecret, fundingVout, fmtBtc, parseBtc, btcPubOk, p2wpkhOf, toHex } from "../shared/btclib.mjs";

const V = JSON.parse(fs.readFileSync(new URL("./btc-vectors.json", import.meta.url), "utf8"));
const base = { outpoint: V.outpoint, sats: V.sats, terms: V.terms };

test("the same terms give the proof's script and address", () => {
  const p = htlcPay(V.terms);
  assert.equal(toHex(p.witnessScript), V.witnessScript);
  assert.equal(p.address, V.address);
  assert.equal(p2wpkhOf(V.terms.recipientPub).address, V.alice);
});

test("a refund and a claim signed by the proof's code pass", () => {
  assert.equal(checkSignedSpend({ ...base, hex: V.refund, kind: "refund", signerPub: V.terms.senderPub }).ok, true);
  assert.equal(checkSignedSpend({ ...base, hex: V.claim, kind: "claim", signerPub: V.terms.recipientPub }).ok, true);
  // The secret goes where the placeholder was: the result is the transaction the proof's code makes with it.
  assert.equal(claimWithSecret(V.claim, V.secret), V.claimReal);
});

test("anything else is refused, each for its reason", () => {
  const why = (o) => checkSignedSpend({ ...base, ...o }).why;
  assert.match(why({ hex: V.refund, kind: "refund", signerPub: V.terms.recipientPub }), /someone other than its signer|signature/, "the refund checked as the recipient's");
  assert.match(why({ hex: V.claim, kind: "refund", signerPub: V.terms.recipientPub }), /script|refund/);
  assert.match(why({ hex: V.refund, kind: "refund", signerPub: V.terms.senderPub, terms: { ...V.terms, locktime: V.terms.locktime + 1 } }), /script/);
  assert.match(why({ hex: V.refund, kind: "refund", signerPub: V.terms.senderPub, outpoint: { ...V.outpoint, vout: 0 } }), /another output/);
  assert.match(why({ hex: V.claim, kind: "claim", signerPub: V.terms.recipientPub, sats: V.sats + 1 }), /signature/, "another amount: the signature covers it");
  assert.match(why({ hex: "00", kind: "claim", signerPub: V.terms.recipientPub }), /not a transaction/);
  // A claim whose signature was made by another key, over the right transaction: refused.
  const tx = bitcoin.Transaction.fromHex(V.claim);
  const other = bitcoin.Transaction.fromHex(V.refund).ins[0].witness[0];
  tx.setWitness(0, [other, ...tx.ins[0].witness.slice(1)]);
  assert.match(why({ hex: tx.toHex(), kind: "claim", signerPub: V.terms.recipientPub }), /signature/);
  // A claim that pays elsewhere.
  const tx2 = bitcoin.Transaction.fromHex(V.claim);
  tx2.outs[0].script = p2wpkhOf(V.terms.senderPub).output;
  assert.match(why({ hex: tx2.toHex(), kind: "claim", signerPub: V.terms.recipientPub }), /someone other/);
});

test("amounts and keys", () => {
  assert.equal(fmtBtc(5000n), "0.00005");
  assert.equal(fmtBtc(100_000_000n), "1");
  assert.equal(parseBtc("0.00005"), 5000n);
  assert.equal(parseBtc("0,0001"), 10000n);
  assert.throws(() => parseBtc("0.000000001"));
  assert.equal(btcPubOk(V.terms.senderPub), V.terms.senderPub);
  assert.equal(btcPubOk("02" + "00".repeat(32)), null, "not a point");
  assert.equal(btcPubOk("04" + "11".repeat(32)), null);
  const funding = new bitcoin.Transaction();
  funding.addInput(new Uint8Array(32), 0);
  funding.addOutput(p2wpkhOf(V.terms.senderPub).output, 100n);
  funding.addOutput(htlcPay(V.terms).output, BigInt(V.sats));
  assert.equal(fundingVout(funding.toHex(), V.terms, V.sats), 1);
  assert.equal(fundingVout(funding.toHex(), V.terms, V.sats + 1), -1);
});

test("the builders make what the checks take, and what the proof's code makes", async () => {
  const { buildHtlcSpend, buildFunding, keySigner } = await import("../shared/btclib.mjs");
  const alice = keySigner("01".repeat(32)), bob = keySigner("02".repeat(32));
  assert.equal(alice.pub, V.terms.recipientPub);
  assert.equal(bob.pub, V.terms.senderPub);
  const refund = await buildHtlcSpend({ ...base, kind: "refund", ownPub: bob.pub, feeRate: 3, sign: bob.sign });
  const claim = await buildHtlcSpend({ ...base, kind: "claim", ownPub: alice.pub, feeRate: 3, sign: alice.sign });
  assert.equal(checkSignedSpend({ ...base, hex: refund, kind: "refund", signerPub: bob.pub }).ok, true);
  assert.equal(checkSignedSpend({ ...base, hex: claim, kind: "claim", signerPub: alice.pub }).ok, true);
  // The same transactions as the proof's code but for the fee, which is sized here with the longest
  // signature: at most a few sats more.
  const out = (hex) => BigInt(bitcoin.Transaction.fromHex(hex).outs[0].value);
  for (const [mine, theirs] of [[refund, V.refund], [claim, V.claim]]) {
    const d = out(theirs) - out(mine);
    assert.ok(d >= 0n && d <= 3n, `fee differs by ${d} sats`);
  }
  // A claim signed by the wrong key is refused.
  const wrong = await buildHtlcSpend({ ...base, kind: "claim", ownPub: alice.pub, feeRate: 3, sign: bob.sign });
  assert.match(checkSignedSpend({ ...base, hex: wrong, kind: "claim", signerPub: alice.pub }).why, /signature/);
  // Funding: pays the script the sats, change back, the rest is the fee.
  const fund = await buildFunding({ coins: [{ txid: "cd".repeat(32), vout: 0, value: 20000 }], ownPub: bob.pub, terms: V.terms, sats: V.sats, feeRate: 3, sign: bob.sign });
  const tx = bitcoin.Transaction.fromHex(fund);
  assert.equal(fundingVout(fund, V.terms, V.sats), 0);
  assert.equal(tx.outs.length, 2);
  assert.ok(20000n - BigInt(tx.outs[0].value) - BigInt(tx.outs[1].value) < 1000n);
  await assert.rejects(buildFunding({ coins: [{ txid: "cd".repeat(32), vout: 0, value: 4000 }], ownPub: bob.pub, terms: V.terms, sats: V.sats, sign: bob.sign }), /not enough BTC/);
});

test("a claim can be signed replaceable (BIP 125), and the book still takes it", async () => {
  const { buildHtlcSpend, keySigner } = await import("../shared/btclib.mjs");
  const alice = keySigner("01".repeat(32));
  const plain = await buildHtlcSpend({ ...base, kind: "claim", ownPub: alice.pub, feeRate: 3, sign: alice.sign });
  const rbf = await buildHtlcSpend({ ...base, kind: "claim", ownPub: alice.pub, feeRate: 3, sign: alice.sign, sequence: 0xfffffffd });
  assert.equal(bitcoin.Transaction.fromHex(plain).ins[0].sequence, 0xffffffff);
  assert.equal(bitcoin.Transaction.fromHex(rbf).ins[0].sequence, 0xfffffffd);
  assert.equal(checkSignedSpend({ ...base, hex: rbf, kind: "claim", signerPub: alice.pub }).ok, true);
  // The same claim again at twice the fee: more fee, the same input, still the signer's.
  const higher = await buildHtlcSpend({ ...base, kind: "claim", ownPub: alice.pub, feeRate: 6, sign: alice.sign, sequence: 0xfffffffd });
  const out = (hex) => BigInt(bitcoin.Transaction.fromHex(hex).outs[0].value);
  assert.ok(out(higher) < out(rbf));
  assert.equal(checkSignedSpend({ ...base, hex: higher, kind: "claim", signerPub: alice.pub }).ok, true);
});
