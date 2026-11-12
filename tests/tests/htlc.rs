//! htlc-lock in CKB-VM. Where a case is about a rule the spike lock lacked, the same transaction
//! also runs against the spike binary as a control: it must pass there for the reason the case
//! names, which shows the test has the precondition of the hole it guards.

use htlc_lock_tests::*;

const CAP: u64 = 1000 * CKB;
const S: [u8; 32] = [7u8; 32];

struct Fx {
    env: Env,
    alice: ckb_testtool::ckb_types::packed::Script,
    bob: ckb_testtool::ckb_types::packed::Script,
    mallory: ckb_testtool::ckb_types::packed::Script,
}

fn fx(bin: Bin) -> Fx {
    let mut env = Env::new(bin);
    let alice = env.party("alice"); // recipient on claim
    let bob = env.party("bob"); // sender, gets the refund
    let mallory = env.party("mallory");
    Fx { env, alice, bob, mallory }
}

/// One HTLC cell of CAP under H = sha256(S), recipient alice, sender bob.
fn one_cell(f: &mut Fx) -> ckb_testtool::ckb_types::packed::OutPoint {
    let lock = f.env.htlc(&sha256(&S), &f.alice.clone(), &f.bob.clone(), TIMEOUT_TS, MAX_FEE);
    f.env.cell(&lock, CAP, None, &[])
}

fn claim(f: &mut Fx, outs: &[(u64, &str)]) -> Result<u64, i8> {
    let op = one_cell(f);
    let outputs: Vec<_> = outs
        .iter()
        .map(|(cap, who)| {
            let l = match *who {
                "alice" => f.alice.clone(),
                "bob" => f.bob.clone(),
                _ => f.mallory.clone(),
            };
            (output(&l, *cap, None), &[][..])
        })
        .collect();
    f.env.verify(tx(&[(op, 0)], &outputs, &[witness(Some(&S))]))
}

#[test]
fn claim_pays_recipient_down_to_max_fee() {
    let mut f = fx(Bin::New);
    let cycles = claim(&mut f, &[(CAP - MAX_FEE, "alice")]).expect("claim at the fee boundary");
    println!("claim cycles: {cycles}");
    assert_eq!(claim(&mut fx(Bin::New), &[(CAP - MAX_FEE - 1, "alice")]), Err(14));
}

#[test]
fn claim_with_dust_to_recipient_and_rest_elsewhere() {
    // Anyone who has seen the preimage builds this: a token output to alice, the rest to mallory.
    let outs = [(100 * CKB, "alice"), (CAP - 100 * CKB - MAX_FEE, "mallory")];
    assert_eq!(claim(&mut fx(Bin::New), &outs), Err(14));
    assert!(claim(&mut fx(Bin::Spike), &outs).is_ok(), "control: the spike lets the value go to mallory");
}

#[test]
fn claim_recipient_must_be_the_paired_output() {
    let outs = [(CAP - MAX_FEE - 100 * CKB, "mallory"), (100 * CKB, "alice")];
    assert_eq!(claim(&mut fx(Bin::New), &outs), Err(11));
    assert!(claim(&mut fx(Bin::Spike), &outs).is_ok(), "control: the spike accepts alice anywhere");
    assert_eq!(claim(&mut fx(Bin::New), &[(CAP - MAX_FEE, "mallory")]), Err(11));
}

#[test]
fn two_htlc_cells_cannot_share_one_output() {
    for bin in [Bin::New, Bin::Spike] {
        let mut f = fx(bin);
        let (s1, s2) = ([1u8; 32], [2u8; 32]);
        let (a, b) = (f.alice.clone(), f.bob.clone());
        let l1 = f.env.htlc(&sha256(&s1), &a, &b, TIMEOUT_TS, MAX_FEE);
        let l2 = f.env.htlc(&sha256(&s2), &a, &b, TIMEOUT_TS, MAX_FEE);
        let (o1, o2) = (f.env.cell(&l1, CAP, None, &[]), f.env.cell(&l2, CAP, None, &[]));
        let outs = [(output(&a, CAP - MAX_FEE, None), &[][..]), (output(&f.mallory, CAP, None), &[][..])];
        let r = f.env.verify(tx(&[(o1, 0), (o2, 0)], &outs, &[witness(Some(&s1)), witness(Some(&s2))]));
        match bin {
            Bin::New => assert_eq!(r, Err(11)),
            Bin::Spike => assert!(r.is_ok(), "control: one output to alice satisfies both spike cells"),
        }
    }
}

#[test]
fn same_args_cells_each_need_their_own_output() {
    let run = |outs: &[(u64, &str)]| {
        let mut f = fx(Bin::New);
        let (o1, o2) = (one_cell(&mut f), one_cell(&mut f));
        let outputs: Vec<_> = outs
            .iter()
            .map(|(c, who)| (output(if *who == "alice" { &f.alice } else { &f.mallory }, *c, None), &[][..]))
            .collect();
        f.env.verify(tx(&[(o1, 0), (o2, 0)], &outputs, &[witness(Some(&S))]))
    };
    assert!(run(&[(CAP - MAX_FEE, "alice"), (CAP - MAX_FEE, "alice")]).is_ok());
    assert_eq!(run(&[(CAP - MAX_FEE, "alice"), (CAP, "mallory")]), Err(11));
    assert_eq!(run(&[(2 * CAP - MAX_FEE, "alice")]), Err(10));
}

#[test]
fn wrong_preimage_is_refused() {
    let mut f = fx(Bin::New);
    let op = one_cell(&mut f);
    let outs = [(output(&f.alice, CAP - MAX_FEE, None), &[][..])];
    assert_eq!(f.env.verify(tx(&[(op, 0)], &outs, &[witness(Some(&[8u8; 32]))])), Err(8));
}

#[test]
fn preimage_must_be_exactly_32_bytes() {
    // Train redeems only a uint256 (32 bytes). A secret holder who used a 33-byte preimage could
    // claim the CKB and leave the other side unable to redeem on EVM.
    let p33 = [7u8; 33];
    for bin in [Bin::New, Bin::Spike] {
        let mut f = fx(bin);
        let (a, b) = (f.alice.clone(), f.bob.clone());
        let lock = f.env.htlc(&sha256(&p33), &a, &b, TIMEOUT_TS, MAX_FEE);
        let op = f.env.cell(&lock, CAP, None, &[]);
        let r = f.env.verify(tx(&[(op, 0)], &[(output(&a, CAP - MAX_FEE, None), &[][..])], &[witness(Some(&p33))]));
        match bin {
            Bin::New => assert_eq!(r, Err(8)),
            Bin::Spike => assert!(r.is_ok(), "control: the spike takes any length"),
        }
    }
}

#[test]
fn token_cell_keeps_type_and_data() {
    let amount = 5_000_000u128.to_le_bytes();
    let run = |bin: Bin, out_type: bool, out_data: &[u8]| {
        let mut f = fx(bin);
        let t = f.env.token_type();
        let (a, b) = (f.alice.clone(), f.bob.clone());
        let lock = f.env.htlc(&sha256(&S), &a, &b, TIMEOUT_TS, MAX_FEE);
        let op = f.env.cell(&lock, CAP, Some(t.clone()), &amount);
        let o = output(&a, CAP - MAX_FEE, if out_type { Some(t) } else { None });
        f.env.verify(tx(&[(op, 0)], &[(o, out_data)], &[witness(Some(&S))]))
    };
    assert!(run(Bin::New, true, &amount).is_ok());
    let less = 1u128.to_le_bytes();
    assert_eq!(run(Bin::New, true, &less), Err(13));
    assert_eq!(run(Bin::New, false, &amount), Err(12));
    assert!(run(Bin::Spike, true, &less).is_ok(), "control: the spike does not look at the token amount");
}

fn refund(f: &mut Fx, sinces: &[u64], to: &str, w: Option<&[u8]>) -> Result<u64, i8> {
    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    for s in sinces {
        inputs.push((one_cell(f), *s));
        let l = if to == "bob" { f.bob.clone() } else { f.alice.clone() };
        outputs.push((output(&l, CAP - MAX_FEE, None), &[][..]));
    }
    f.env.verify(tx(&inputs, &outputs, &[witness(w)]))
}

#[test]
fn refund_only_after_timeout_and_only_to_sender() {
    assert!(refund(&mut fx(Bin::New), &[TIMEOUT_TS], "bob", None).is_ok());
    assert!(refund(&mut fx(Bin::New), &[TIMEOUT_TS + 600], "bob", Some(&[])).is_ok());
    assert_eq!(refund(&mut fx(Bin::New), &[TIMEOUT_TS - 1], "bob", None), Err(9));
    assert_eq!(refund(&mut fx(Bin::New), &[0], "bob", None), Err(9));
    // same value, block-number metric instead of timestamp
    assert_eq!(refund(&mut fx(Bin::New), &[TIMEOUT_TS & 0x00ff_ffff_ffff_ffff], "bob", None), Err(9));
    assert_eq!(refund(&mut fx(Bin::New), &[TIMEOUT_TS], "alice", None), Err(11));
    // a non-empty lock field is a claim attempt, never a refund
    assert_eq!(refund(&mut fx(Bin::New), &[TIMEOUT_TS], "bob", Some(&[8u8; 32])), Err(8));
    // every input of the group must be past the timeout
    assert_eq!(refund(&mut fx(Bin::New), &[TIMEOUT_TS, TIMEOUT_TS - 1], "bob", None), Err(9));
    assert!(refund(&mut fx(Bin::New), &[TIMEOUT_TS, TIMEOUT_TS], "bob", None).is_ok());
}

#[test]
fn malformed_args_are_refused() {
    let mut f = fx(Bin::New);
    let (a, b) = (f.alice.clone(), f.bob.clone());
    let run = |f: &mut Fx, lock: ckb_testtool::ckb_types::packed::Script| {
        let op = f.env.cell(&lock, CAP, None, &[]);
        let outs = [(output(&f.alice, CAP - MAX_FEE, None), &[][..])];
        f.env.verify(tx(&[(op, 0)], &outs, &[witness(Some(&S))]))
    };
    let short = f.env.raw_htlc(ckb_testtool::ckb_types::bytes::Bytes::from(vec![0u8; 111]));
    assert_eq!(run(&mut f, short), Err(5));
    let epoch = f.env.htlc(&sha256(&S), &a, &b, 0x2000_0000_0000_0100, MAX_FEE);
    assert_eq!(run(&mut f, epoch), Err(6));
    let relative = f.env.htlc(&sha256(&S), &a, &b, 0xc000_0000_0000_0100, MAX_FEE);
    assert_eq!(run(&mut f, relative), Err(6));
    let zero = f.env.htlc(&sha256(&S), &a, &b, 0x4000_0000_0000_0000, MAX_FEE);
    assert_eq!(run(&mut f, zero), Err(6));
}

#[test]
fn max_fee_is_capped_at_one_ckb() {
    let run = |max_fee: u64| {
        let mut f = fx(Bin::New);
        let (a, b) = (f.alice.clone(), f.bob.clone());
        let lock = f.env.htlc(&sha256(&S), &a, &b, TIMEOUT_TS, max_fee);
        let op = f.env.cell(&lock, CAP, None, &[]);
        let outs = [(output(&a, CAP - max_fee, None), &[][..])];
        f.env.verify(tx(&[(op, 0)], &outs, &[witness(Some(&S))]))
    };
    assert!(run(CKB).is_ok());
    assert_eq!(run(CKB + 1), Err(5));
}

#[test]
fn large_data_cell_can_still_be_claimed() {
    // Data is compared by hash: 400 KB of data must not exhaust the script's heap.
    let data = vec![0xabu8; 400 * 1024];
    let mut f = fx(Bin::New);
    let (a, b) = (f.alice.clone(), f.bob.clone());
    let lock = f.env.htlc(&sha256(&S), &a, &b, TIMEOUT_TS, MAX_FEE);
    let cap = 500_000 * CKB;
    let op = f.env.cell(&lock, cap, None, &data);
    let r = f.env.verify(tx(&[(op, 0)], &[(output(&a, cap - MAX_FEE, None), &data)], &[witness(Some(&S))]));
    println!("400 KB data claim: {r:?}");
    assert!(r.is_ok());
}

#[test]
fn cycles_for_many_htlc_groups() {
    // One group per cell (distinct hashlocks), each group scans every input: the cost grows with
    // the square of the cell count. The node's per-transaction limit is 70,000,000 cycles.
    for n in [1usize, 16, 64, 128] {
        let mut f = fx(Bin::New);
        let (a, b) = (f.alice.clone(), f.bob.clone());
        let mut inputs = Vec::new();
        let mut outputs = Vec::new();
        let mut witnesses = Vec::new();
        for k in 0..n {
            let s = [k as u8; 32];
            let lock = f.env.htlc(&sha256(&s), &a, &b, TIMEOUT_TS, MAX_FEE);
            inputs.push((f.env.cell(&lock, CAP, None, &[]), 0));
            outputs.push((output(&a, CAP - MAX_FEE, None), &[][..]));
            witnesses.push(witness(Some(&s)));
        }
        let cycles = f.env.verify(tx(&inputs, &outputs, &witnesses)).expect("honest batch");
        println!("{n} HTLC cells, one group each: {cycles} cycles");
        if n <= 64 {
            assert!(cycles < 70_000_000);
        }
    }
}
