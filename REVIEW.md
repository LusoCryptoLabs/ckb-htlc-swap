# htlc-lock review

Reviewed 2026-11-09 against the ckb-script-pitfalls catalogue and the review checklist.
`tests/tests/htlc.rs` has 13 tests. `scripts/mutants.py` disables each of the 18 guards in
turn, and all 18 are caught by the test that names them.

## Catalogue, entry by entry

- 01 payment sum: does not apply. There is no sum. Input `i` is paired with output `i`.
  Tests: `two_htlc_cells_cannot_share_one_output` (the spike lock accepts it, as a
  control), `same_args_cells_each_need_their_own_output`.
- 02 typed output: the paired output must carry the input's type and data hash, so a
  plain CKB cell pays out as a plain cell. Test: `token_cell_keeps_type_and_data`.
- 03 truncated compare: lock hashes and the hashlock are compared at 32 bytes on both
  sides. The preimage is read with `raw_data()`. The type is compared as two molecule
  `ScriptOpt` encodings.
- 04 output lock not pinned: the destination lock hash is pinned by args.
- 05 sentinel: does not apply.
- 06 public commitment: the preimage is public once a claim reaches the mempool. A
  front-runner can only send the same funds to the same recipient, losing at most max
  fee. Test: `claim_with_dust_to_recipient_and_rest_elsewhere`.
- 07 capacity on permissionless actions: guarded at input capacity minus max fee, and max
  fee is capped at 1 CKB. Tests: `claim_pays_recipient_down_to_max_fee`,
  `max_fee_is_capped_at_one_ckb`.
- 08 deposit to the wrong side: capacity goes to the destination, never to the builder.
- 09 since flags: the flags are compared before the value. Only absolute block number
  and absolute timestamp are accepted for the timeout. Tests:
  `refund_only_after_timeout_and_only_to_sender`, `malformed_args_are_refused`.
- 10 witnesses by output index: does not apply. Only the group's first witness is read.
- 11 QueryIter: not used. Every loop handles `IndexOutOfBound` explicitly.
- 12 comments: the header comment matches the code. Re-read after the max fee cap and
  the data hash change.
- 13 examples vs properties: covered by the mutation run. No proptest or fuzzing yet.
- 14 child cell: does not apply.
- 15 lock anyone can open: claim and refund are permissionless by design, with fixed
  destinations. Never name an htlc-lock hash as the owner of a token: anyone holding the
  preimage, or anyone after the timeout, opens it.
- 16 allowance anyone can claim: max fee is per input, never summed across cells.
- 17 epoch since fraction: the epoch metric is refused.

## Other points

- Heap: data is compared by `load_cell_data_hash`, so a cell holding 400 KB of data still
  claims at the same cycles (`large_data_cell_can_still_be_claimed`).
- Cycles: 55,864 for one cell. 128 cells, each its own group, cost 24.2 M, under the
  node's 70 M per-transaction limit (`cycles_for_many_htlc_groups`).
- Claim after the timeout is still possible, so claim and refund can race. Swap safety
  comes from timeout ordering off chain: the side that holds the secret locks first,
  with the longer timeout.
- Identity: deployed by data hash (`data2`), so the code cannot change, and anyone can
  redeploy the same bytes if the code cell is spent.

## Our mutation engine

Our mutation engine (kept in a private repository), 2026-11-09, on three honest transactions
built by a stranger: a claim, a claim of a token cell, and a refund at the exact timeout. 919
attacks, every one refused by htlc-lock, no findings and nothing for review (families A1, A2,
A5, A6, A8, B1, B2, C, C2, E, U1). Control: the same seeds against the spike lock give 209
findings, among them A1 (the value skimmed to the builder) and B1/B2 (one output satisfying two
cells), the holes the unit tests show.
