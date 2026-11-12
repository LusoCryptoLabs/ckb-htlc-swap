//! htlc_lock.rs - bridge Mode B (HTLC) CKB lock. Pairs with an XRPL PreimageSha256 escrow under the SAME
//! hashlock H = SHA256(preimage), so the bridge can include a non-programmable chain (XRPL) as an atomic-swap
//! leg without a light client or a SNARK. Two unlock paths:
//!   CLAIM : witness.lock = the preimage, SHA256(preimage) == H, and an output pays the recipient.
//!   REFUND: this input's `since` >= timeout, and an output pays the sender.
//! Revealing the preimage to claim one side exposes it for the other side; that is the atomic link. The
//! cross-chain trust is liveness only (the standard HTLC property), which is the honest ceiling for a chain
//! that cannot host a verifier of CKB.
//! args = H(32) || recipient_lock_hash(32) || sender_lock_hash(32) || timeout(8 LE, a CKB `since` value).
#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::prelude::*;
use ckb_std::high_level::{load_script, load_witness_args, load_cell_lock_hash, load_input_since};
use sha2::{Sha256, Digest};
#[cfg(not(test))] ckb_std::entry!(program_entry);
#[cfg(not(test))] ckb_std::default_alloc!();

// is there an output cell whose lock-script hash equals `lock_hash`? (binds the funds to a party, so revealing
// the preimage never lets a third party redirect the value)
fn output_pays(lock_hash: &[u8]) -> bool {
    let mut i = 0usize;
    loop {
        match load_cell_lock_hash(i, Source::Output) {
            Ok(lh) => { if &lh[..] == lock_hash { return true; } i += 1; }
            Err(_) => return false,
        }
    }
}

// require the same `since` encoding on both sides: equal flag byte, then value >= timeout value.
fn since_reached(since: u64, timeout: u64) -> bool {
    (since >> 56) == (timeout >> 56) && (since & 0x00ff_ffff_ffff_ffff) >= (timeout & 0x00ff_ffff_ffff_ffff)
}

fn program_entry() -> i8 {
    let args = match load_script() { Ok(s) => s.args().raw_data(), Err(_) => return 1 };
    if args.len() != 32 + 32 + 32 + 8 { return 1; }
    let h = &args[0..32];
    let recipient = &args[32..64];
    let sender = &args[64..96];
    let mut tb = [0u8; 8]; tb.copy_from_slice(&args[96..104]);
    let timeout = u64::from_le_bytes(tb);

    // CLAIM: preimage in witness.lock, SHA256(preimage) == H, funds go to the recipient.
    if let Ok(w) = load_witness_args(0, Source::GroupInput) {
        if let Some(p) = w.lock().to_opt() {
            let pre = p.raw_data();
            let digest = Sha256::digest(&pre[..]);
            if digest.as_slice() == h {
                return if output_pays(recipient) { 0 } else { 20 };
            }
        }
    }
    // REFUND: this input's since >= timeout, funds go back to the sender.
    if let Ok(since) = load_input_since(0, Source::GroupInput) {
        if since_reached(since, timeout) && output_pays(sender) { return 0; }
    }
    2
}

// --- single-hart __sync_* atomic polyfills (CKB-VM has no A-extension; built with -a,+forced-atomics) ---
#[cfg(not(test))]
#[allow(non_snake_case)]
mod sync_polyfill {
    use core::ptr::{read_volatile, write_volatile};
    macro_rules! sync_ops {
        ($ty:ty, $cas:ident, $bcas:ident, $tas:ident, $faa:ident, $fas:ident, $fao:ident, $faand:ident, $fax:ident) => {
            #[no_mangle] pub unsafe extern "C" fn $cas(p:*mut $ty,old:$ty,new:$ty)->$ty{let c=read_volatile(p);if c==old{write_volatile(p,new);}c}
            #[no_mangle] pub unsafe extern "C" fn $bcas(p:*mut $ty,old:$ty,new:$ty)->bool{let c=read_volatile(p);if c==old{write_volatile(p,new);true}else{false}}
            #[no_mangle] pub unsafe extern "C" fn $tas(p:*mut $ty,new:$ty)->$ty{let c=read_volatile(p);write_volatile(p,new);c}
            #[no_mangle] pub unsafe extern "C" fn $faa(p:*mut $ty,v:$ty)->$ty{let c=read_volatile(p);write_volatile(p,c.wrapping_add(v));c}
            #[no_mangle] pub unsafe extern "C" fn $fas(p:*mut $ty,v:$ty)->$ty{let c=read_volatile(p);write_volatile(p,c.wrapping_sub(v));c}
            #[no_mangle] pub unsafe extern "C" fn $fao(p:*mut $ty,v:$ty)->$ty{let c=read_volatile(p);write_volatile(p,c|v);c}
            #[no_mangle] pub unsafe extern "C" fn $faand(p:*mut $ty,v:$ty)->$ty{let c=read_volatile(p);write_volatile(p,c&v);c}
            #[no_mangle] pub unsafe extern "C" fn $fax(p:*mut $ty,v:$ty)->$ty{let c=read_volatile(p);write_volatile(p,c^v);c}
        };
    }
    sync_ops!(u8,  __sync_val_compare_and_swap_1,__sync_bool_compare_and_swap_1,__sync_lock_test_and_set_1,__sync_fetch_and_add_1,__sync_fetch_and_sub_1,__sync_fetch_and_or_1,__sync_fetch_and_and_1,__sync_fetch_and_xor_1);
    sync_ops!(u16, __sync_val_compare_and_swap_2,__sync_bool_compare_and_swap_2,__sync_lock_test_and_set_2,__sync_fetch_and_add_2,__sync_fetch_and_sub_2,__sync_fetch_and_or_2,__sync_fetch_and_and_2,__sync_fetch_and_xor_2);
    sync_ops!(u32, __sync_val_compare_and_swap_4,__sync_bool_compare_and_swap_4,__sync_lock_test_and_set_4,__sync_fetch_and_add_4,__sync_fetch_and_sub_4,__sync_fetch_and_or_4,__sync_fetch_and_and_4,__sync_fetch_and_xor_4);
    sync_ops!(u64, __sync_val_compare_and_swap_8,__sync_bool_compare_and_swap_8,__sync_lock_test_and_set_8,__sync_fetch_and_add_8,__sync_fetch_and_sub_8,__sync_fetch_and_or_8,__sync_fetch_and_and_8,__sync_fetch_and_xor_8);
    #[no_mangle] pub extern "C" fn __sync_synchronize() {}
}
