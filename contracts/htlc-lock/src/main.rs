//! htlc-lock: a hashlock + timelock lock for cross-chain atomic swaps.
//!
//! The other leg of the swap is any contract that releases funds against the same SHA-256 hashlock
//! (for example Train on EVM chains, which checks `sha256(abi.encodePacked(uint256 secret))`).
//!
//! args (112 bytes):
//!   hashlock H (32) || recipient lock hash (32) || sender lock hash (32)
//!   || timeout (8, LE, an absolute `since` value, block number or timestamp metric)
//!   || max_fee (8, LE, shannons each input may lose to the transaction fee, at most 1 CKB)
//!
//! CLAIM: the lock field of the group's first witness is exactly 32 bytes p and SHA256(p) == H.
//!        Funds go to the recipient. Anyone holding p may submit the claim.
//! REFUND: the lock field is absent or empty, and every input of the group has
//!        since >= timeout with the same absolute metric. Funds go to the sender.
//!
//! In both paths every input i locked by this script is paired with output i, which must carry the
//! destination lock, the same type script, the same data (so an xUDT amount is kept) and at least
//! the input capacity minus max_fee. The pairing is by index, so two HTLC cells can never be
//! settled by one output. Data is compared by hash, so a cell with large data cannot exhaust the
//! heap and block the claim.
#![no_std]
#![no_main]

mod atomics;

use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::prelude::*;
use ckb_std::error::SysError;
use ckb_std::high_level::{
    load_cell, load_cell_data_hash, load_cell_lock_hash, load_input_since, load_script, load_script_hash,
    load_witness_args,
};
use sha2::{Digest, Sha256};

ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

const ARGS_LEN: usize = 32 + 32 + 32 + 8 + 8;
const PREIMAGE_LEN: usize = 32;
/// The most a single input may give to the fee. Without a cap, a funder could set max_fee to the
/// whole capacity, and anyone holding the preimage could pay the cell to a miner instead.
const MAX_FEE_CAP: u64 = 100_000_000;
/// The top byte of an absolute `since`: 0x00 block number, 0x40 timestamp (median time, seconds).
const SINCE_ABS_BLOCK: u8 = 0x00;
const SINCE_ABS_TIMESTAMP: u8 = 0x40;
const SINCE_VALUE_MASK: u64 = 0x00ff_ffff_ffff_ffff;

const ERR_ARGS: i8 = 5;
const ERR_TIMEOUT_FORMAT: i8 = 6;
const ERR_WITNESS: i8 = 7;
const ERR_PREIMAGE: i8 = 8;
const ERR_SINCE: i8 = 9;
const ERR_NO_OUTPUT: i8 = 10;
const ERR_OUTPUT_LOCK: i8 = 11;
const ERR_OUTPUT_TYPE: i8 = 12;
const ERR_OUTPUT_DATA: i8 = 13;
const ERR_OUTPUT_CAPACITY: i8 = 14;
const ERR_SYSCALL: i8 = 15;

fn sys(_: SysError) -> i8 {
    ERR_SYSCALL
}

fn u64_le(b: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(b);
    u64::from_le_bytes(a)
}

fn program_entry() -> i8 {
    match run() {
        Ok(()) => 0,
        Err(code) => code,
    }
}

fn run() -> Result<(), i8> {
    let script = load_script().map_err(sys)?;
    let args = script.args().raw_data();
    if args.len() != ARGS_LEN {
        return Err(ERR_ARGS);
    }
    let hashlock = &args[0..32];
    let recipient = &args[32..64];
    let sender = &args[64..96];
    let timeout = u64_le(&args[96..104]);
    let max_fee = u64_le(&args[104..112]);
    if max_fee > MAX_FEE_CAP {
        return Err(ERR_ARGS);
    }

    let metric = (timeout >> 56) as u8;
    if (metric != SINCE_ABS_BLOCK && metric != SINCE_ABS_TIMESTAMP) || timeout & SINCE_VALUE_MASK == 0 {
        return Err(ERR_TIMEOUT_FORMAT);
    }

    // The preimage, if any, is in the lock field of the group's first witness.
    let preimage = match load_witness_args(0, Source::GroupInput) {
        Ok(w) => match w.lock().to_opt() {
            Some(b) if !b.raw_data().is_empty() => Some(b.raw_data()),
            _ => None,
        },
        Err(SysError::IndexOutOfBound) => None,
        Err(_) => return Err(ERR_WITNESS),
    };

    let destination = match preimage {
        Some(p) => {
            if p.len() != PREIMAGE_LEN || Sha256::digest(&p[..]).as_slice() != hashlock {
                return Err(ERR_PREIMAGE);
            }
            recipient
        }
        None => {
            let mut j = 0usize;
            loop {
                match load_input_since(j, Source::GroupInput) {
                    Ok(since) => {
                        if (since >> 56) != (timeout >> 56)
                            || (since & SINCE_VALUE_MASK) < (timeout & SINCE_VALUE_MASK)
                        {
                            return Err(ERR_SINCE);
                        }
                    }
                    Err(SysError::IndexOutOfBound) => break,
                    Err(e) => return Err(sys(e)),
                }
                j += 1;
            }
            sender
        }
    };

    check_paired_outputs(&load_script_hash().map_err(sys)?, destination, max_fee)
}

/// Every input locked by this script (this exact args) must be matched by the output at the same
/// index: destination lock, same type, same data, capacity at least input capacity - max_fee.
fn check_paired_outputs(self_hash: &[u8; 32], destination: &[u8], max_fee: u64) -> Result<(), i8> {
    let mut i = 0usize;
    loop {
        let lock_hash = match load_cell_lock_hash(i, Source::Input) {
            Ok(h) => h,
            Err(SysError::IndexOutOfBound) => return Ok(()),
            Err(e) => return Err(sys(e)),
        };
        if &lock_hash == self_hash {
            let input = load_cell(i, Source::Input).map_err(sys)?;
            let output = match load_cell(i, Source::Output) {
                Ok(c) => c,
                Err(SysError::IndexOutOfBound) => return Err(ERR_NO_OUTPUT),
                Err(e) => return Err(sys(e)),
            };
            if &load_cell_lock_hash(i, Source::Output).map_err(sys)?[..] != destination {
                return Err(ERR_OUTPUT_LOCK);
            }
            if input.type_().as_slice() != output.type_().as_slice() {
                return Err(ERR_OUTPUT_TYPE);
            }
            if load_cell_data_hash(i, Source::Input).map_err(sys)? != load_cell_data_hash(i, Source::Output).map_err(sys)? {
                return Err(ERR_OUTPUT_DATA);
            }
            let in_cap: u64 = input.capacity().unpack();
            let out_cap: u64 = output.capacity().unpack();
            if (out_cap as u128) + (max_fee as u128) < in_cap as u128 {
                return Err(ERR_OUTPUT_CAPACITY);
            }
        }
        i += 1;
    }
}
