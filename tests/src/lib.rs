//! Helpers for the htlc-lock tests: a ckb-testtool context with the lock (or the spike control),
//! always-success locks for the parties, and builders for args and transactions.

use ckb_testtool::builtin::ALWAYS_SUCCESS;
use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{TransactionBuilder, TransactionView},
    packed::*,
    prelude::*,
};
use ckb_testtool::context::Context;
use sha2::{Digest, Sha256};

pub const MAX_CYCLES: u64 = 100_000_000;
pub const CKB: u64 = 100_000_000;
pub const NEW_BIN: &str = "../build/htlc-lock";
pub const SPIKE_BIN: &str = "../build/spike-htlc-lock";
/// Absolute timestamp `since` (flag 0x40) for 2026-11-09 12:00 UTC.
pub const TIMEOUT_TS: u64 = 0x4000_0000_0000_0000 | 1_794_225_600;
pub const MAX_FEE: u64 = CKB / 100; // 0.01 CKB per input

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Bin {
    New,
    Spike,
}

pub struct Env {
    pub ctx: Context,
    pub bin: Bin,
    lock_op: OutPoint,
    always_op: OutPoint,
}

pub fn sha256(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

impl Env {
    pub fn new(bin: Bin) -> Self {
        let mut ctx = Context::default();
        // HTLC_BIN points the tests at another build of the lock (scripts/mutants.py).
        let path = match bin {
            Bin::New => std::env::var("HTLC_BIN").unwrap_or_else(|_| NEW_BIN.to_string()),
            Bin::Spike => SPIKE_BIN.to_string(),
        };
        let path = path.as_str();
        let code = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e} (run ../build.sh)"));
        let lock_op = ctx.deploy_cell(Bytes::from(code));
        let always_op = ctx.deploy_cell(ALWAYS_SUCCESS.clone());
        Env { ctx, bin, lock_op, always_op }
    }

    /// An always-success lock standing in for a party's wallet lock; distinct `tag` gives a
    /// distinct lock hash.
    pub fn party(&mut self, tag: &str) -> Script {
        self.ctx.build_script(&self.always_op, Bytes::from(tag.as_bytes().to_vec())).unwrap()
    }

    /// Stand-in for an xUDT type script (always success, so only htlc-lock's own rules are tested).
    pub fn token_type(&mut self) -> Script {
        self.ctx.build_script(&self.always_op, Bytes::from_static(b"token")).unwrap()
    }

    /// htlc-lock args for this binary. The spike has no max_fee field (104 bytes).
    pub fn htlc(&mut self, h: &[u8; 32], recipient: &Script, sender: &Script, timeout: u64, max_fee: u64) -> Script {
        let mut a = Vec::new();
        a.extend_from_slice(h);
        a.extend_from_slice(recipient.calc_script_hash().as_slice());
        a.extend_from_slice(sender.calc_script_hash().as_slice());
        a.extend_from_slice(&timeout.to_le_bytes());
        if self.bin == Bin::New {
            a.extend_from_slice(&max_fee.to_le_bytes());
        }
        self.raw_htlc(Bytes::from(a))
    }

    pub fn raw_htlc(&mut self, args: Bytes) -> Script {
        self.ctx.build_script(&self.lock_op, args).unwrap()
    }

    pub fn cell(&mut self, lock: &Script, capacity: u64, type_: Option<Script>, data: &[u8]) -> OutPoint {
        let out = CellOutput::new_builder()
            .capacity(capacity.pack())
            .lock(lock.clone())
            .type_(ScriptOpt::new_builder().set(type_).build())
            .build();
        self.ctx.create_cell(out, Bytes::from(data.to_vec()))
    }

    pub fn verify(&mut self, tx: TransactionView) -> Result<u64, i8> {
        let tx = self.ctx.complete_tx(tx);
        self.ctx.verify_tx(&tx, MAX_CYCLES).map_err(|e| exit_code(&e.to_string()))
    }
}

pub fn output(lock: &Script, capacity: u64, type_: Option<Script>) -> CellOutput {
    CellOutput::new_builder()
        .capacity(capacity.pack())
        .lock(lock.clone())
        .type_(ScriptOpt::new_builder().set(type_).build())
        .build()
}

pub fn witness(lock_field: Option<&[u8]>) -> Bytes {
    let w = WitnessArgs::new_builder()
        .lock(BytesOpt::new_builder().set(lock_field.map(|b| Bytes::from(b.to_vec()).pack())).build())
        .build();
    w.as_bytes()
}

/// A transaction from (out point, since) inputs, (output, data) pairs and witnesses.
pub fn tx(inputs: &[(OutPoint, u64)], outputs: &[(CellOutput, &[u8])], witnesses: &[Bytes]) -> TransactionView {
    TransactionBuilder::default()
        .inputs(inputs.iter().map(|(op, since)| CellInput::new(op.clone(), *since)))
        .outputs(outputs.iter().map(|(o, _)| o.clone()))
        .outputs_data(outputs.iter().map(|(_, d)| Bytes::from(d.to_vec()).pack()))
        .witnesses(witnesses.iter().map(|w| w.pack()))
        .build()
}

/// The script exit code in a verification error ("... error code 8 ..."), or 0 if it has none.
pub fn exit_code(msg: &str) -> i8 {
    let key = "error code ";
    match msg.find(key) {
        Some(i) => msg[i + key.len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-')
            .collect::<String>()
            .parse()
            .unwrap_or(0),
        None => {
            eprintln!("no exit code in: {msg}");
            0
        }
    }
}
