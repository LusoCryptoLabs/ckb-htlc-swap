#!/usr/bin/env python3
"""Mutation check for htlc-lock: disable one guard at a time, rebuild, run the test that names it.
Each mutant must be KILLED (the test fails). Run after build.sh: python3 scripts/mutants.py"""
import os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "contracts", "htlc-lock")
BASE = os.environ.get("HTLC_TARGET_BASE", os.path.join(ROOT, "target"))
WORK = os.path.join(BASE, "mut-src", "htlc-lock")
TARGET = os.path.join(BASE, "mut")
BIN = os.path.join(BASE, "mut-src", "htlc-lock.bin")
ENV = dict(os.environ, PATH="/root/.cargo/bin:" + os.environ["PATH"]) if os.path.isdir("/root/.cargo/bin") else dict(os.environ)

MUTANTS = [
    ("args length", "if args.len() != ARGS_LEN {", "if false && args.len() != ARGS_LEN {", "malformed_args_are_refused"),
    ("max_fee cap", "if max_fee > MAX_FEE_CAP {", "if false {", "max_fee_is_capped_at_one_ckb"),
    ("timeout metric", "(metric != SINCE_ABS_BLOCK && metric != SINCE_ABS_TIMESTAMP) ||", "false ||", "malformed_args_are_refused"),
    ("timeout not zero", "|| timeout & SINCE_VALUE_MASK == 0", "|| false", "malformed_args_are_refused"),
    ("empty lock field is a refund", "Some(b) if !b.raw_data().is_empty() =>", "Some(b) =>", "refund_only_after_timeout_and_only_to_sender"),
    ("preimage length", "p.len() != PREIMAGE_LEN ||", "false ||", "preimage_must_be_exactly_32_bytes"),
    ("preimage hash", "|| Sha256::digest(&p[..]).as_slice() != hashlock", "|| false", "wrong_preimage_is_refused"),
    ("claim pays recipient", "            recipient\n        }\n        None", "            sender\n        }\n        None", "claim_pays_recipient_down_to_max_fee"),
    ("since metric", "if (since >> 56) != (timeout >> 56)\n", "if false\n", "refund_only_after_timeout_and_only_to_sender"),
    ("since value", "|| (since & SINCE_VALUE_MASK) < (timeout & SINCE_VALUE_MASK)", "|| false", "refund_only_after_timeout_and_only_to_sender"),
    ("since on every group input", "                j += 1;", "                break;", "refund_only_after_timeout_and_only_to_sender"),
    ("refund pays sender", "            sender\n        }\n    };", "            recipient\n        }\n    };", "refund_only_after_timeout_and_only_to_sender"),
    ("every HTLC input paired", "if &lock_hash == self_hash {", "if &lock_hash == self_hash && i == 0 {", "two_htlc_cells_cannot_share_one_output"),
    ("paired output exists", "Err(SysError::IndexOutOfBound) => return Err(ERR_NO_OUTPUT),", "Err(SysError::IndexOutOfBound) => return Ok(()),", "same_args_cells_each_need_their_own_output"),
    ("output lock", "if &load_cell_lock_hash(i, Source::Output).map_err(sys)?[..] != destination {", "if false {", "claim_recipient_must_be_the_paired_output"),
    ("output type", "if input.type_().as_slice() != output.type_().as_slice() {", "if false {", "token_cell_keeps_type_and_data"),
    ("output data", "if load_cell_data_hash(i, Source::Input).map_err(sys)? != load_cell_data_hash(i, Source::Output).map_err(sys)? {", "if false {", "token_cell_keeps_type_and_data"),
    ("output capacity", "if (out_cap as u128) + (max_fee as u128) < in_cap as u128 {", "if false {", "claim_with_dust_to_recipient_and_rest_elsewhere"),
]

def run(cmd, cwd, extra=None):
    env = dict(ENV, **(extra or {}))
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)

original = open(os.path.join(SRC, "src", "main.rs"), encoding="utf-8").read()
survived = 0
for name, old, new, test in MUTANTS:
    if original.count(old) != 1:
        print(f"BAD MUTANT {name}: original text found {original.count(old)} times"); survived += 1; continue
    shutil.rmtree(WORK, ignore_errors=True)
    shutil.copytree(SRC, WORK)
    shutil.copy(os.path.join(ROOT, "rust-toolchain.toml"), os.path.dirname(WORK))
    open(os.path.join(WORK, "src", "main.rs"), "w", encoding="utf-8").write(original.replace(old, new))
    b = run(["cargo", "build", "--release"], WORK, {"CARGO_TARGET_DIR": TARGET})
    if b.returncode != 0:
        print(f"BUILD FAILED {name}\n{b.stderr[-800:]}"); survived += 1; continue
    shutil.copy(os.path.join(TARGET, "riscv64imac-unknown-none-elf", "release", "htlc-lock"), BIN)
    t = run(["cargo", "test", "--release", "--test", "htlc", test, "--", "--exact"], os.path.join(ROOT, "tests"),
            {"CARGO_TARGET_DIR": os.path.join(BASE, "tests"), "HTLC_BIN": BIN})
    ran = "1 passed" in t.stdout or "1 failed" in t.stdout
    verdict = "KILLED" if t.returncode != 0 and ran else ("SURVIVED" if ran else "DID NOT RUN")
    if verdict != "KILLED":
        survived += 1
    print(f"{verdict:9} {name}  ({test})")
print(f"{len(MUTANTS) - survived}/{len(MUTANTS)} killed")
sys.exit(1 if survived else 0)
