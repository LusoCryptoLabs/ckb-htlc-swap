# ckb-usdc-htlc-swap

Atomic swap between CKB and USDC on an EVM chain, or BTC on Bitcoin. Both legs lock funds
under the same SHA-256 hashlock. Revealing the 32-byte secret to take one leg makes the other
leg redeemable.

- CKB leg: `contracts/htlc-lock`, a lock script.
- EVM leg: the Train contract (`trainprotocol/contracts`, `Train.sol`), already deployed at
  `0x265978c3e2E5dB9C3Ea665cC40C5925A5fc13Ee8`. On 2026-11-09 the same runtime bytecode was at
  that address on Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain, and on Base Sepolia
  and Ethereum Sepolia; Avalanche and Linea had nothing there. Train has no owner, pause or
  upgrade path. It checks `sha256(abi.encodePacked(uint256 secret))`, which is SHA-256 of the
  same 32 bytes.
- Bitcoin leg: a P2WSH script per swap, nothing deployed (`swap/btc.mjs`).

This is a prototype running on testnet. Anyone who intends to use it must weigh every security question needed to keep all of its functions and funds safe: this prototype does not guarantee that.

## htlc-lock

Args, 112 bytes:

| bytes | field |
| --- | --- |
| 0..32 | hashlock H |
| 32..64 | recipient lock hash |
| 64..96 | sender lock hash |
| 96..104 | timeout, absolute `since` (block number or timestamp), LE |
| 104..112 | max fee per input in shannons, at most 1 CKB, LE |

- Claim: the lock field of the group's first witness is exactly 32 bytes `p` with
  `SHA256(p) == H`. Anyone holding `p` can submit it; the funds go to the recipient.
- Refund: the lock field is absent or empty and every input of the group has
  `since >= timeout` with the same metric. The funds go to the sender.
- Both: input `i` under this lock is paired with output `i`, which must have the
  destination lock, the same type, the same data hash and at least the input capacity
  minus max fee.

Error codes: 5 args, 6 timeout format, 7 witness, 8 preimage, 9 since, 10 no paired
output, 11 output lock, 12 output type, 13 output data, 14 output capacity, 15 syscall.

## Build and test

Needs the riscv64imac target and runs in WSL:

```
bash build.sh               # build/htlc-lock and build/spike-htlc-lock
bash test.sh                # CKB-VM tests (ckb-testtool)
python3 scripts/mutants.py  # every guard disabled in turn must fail its test
```

`contracts/spike-htlc-lock` is the earlier spike lock, kept unchanged as a control. The
tests show which cases it accepts that htlc-lock refuses. It is never deployed from here.

### Reproducible build

The binary a plain `cargo build` gives depends on the machine: its C compiler for RISC-V and
where cargo keeps its files. `reproducible/` builds the lock in a container pinned by digest
instead, so any machine gets the same bytes:

```
bash reproducible/reproduce.sh   # builds in docker, checks the sha256, prints MATCH
```

This produces the canonical binary, sha256 `7a47a251f26dfb88926588f714a70c590eb4a3f4e0c8e6143a465ad56b48b1e6`,
30,936 bytes, the same on every run. A mainnet deployment uses this binary, so the on chain
bytes match `reproduce.sh`. The current testnet deploy below (sha256 `203b5096...`, data hash
`0x2631...`, 30,888 bytes) predates the hermetic build and was built ad hoc; it is testnet only
and not for value.

Like Train, the lock is referenced by its data hash (`data2`), so it has no owner, pause or
upgrade path: the code hash is the content and no key can replace the code.

Review notes are in `REVIEW.md`.

## Swap scripts

`swap/` holds the testnet scripts (Node, CCC and ethers). See `swap/README.md`.

## Results, 2026-11-09

CKB leg on the public CKB testnet, USDC leg on a local fork of Base Sepolia, using the real
Train bytecode and Circle's test USDC.

- htlc-lock deployed: tx `0x29379a658315c050bf4612dd671f986afc2c133ad2c6e14ef7e67ac9d6ae82b2`,
  data hash `0x2631477be216114391a8f0d2158c0f2ae33849ab20d692b49076ff5900d87932`, 30,888 bytes.
- usdc-first: 10 USDC for 500 CKB. CKB claim `0xd7d65b9be0ec606db04748f0d1856bc804d51930b59af6e9d34efe2e8dfd5e1c`,
  then Bob's watcher read the secret from it and redeemed on Train.
- ckb-first: 500 CKB for 10 USDC. Bob redeemed on Train, Alice's watcher read the secret from
  the event and claimed `0x8b26cc3ce2710f58f713b62129ecd7d7cd486c5eb12129e8e1a09e17f0b0eea9`.
- refund: the node refused the CKB refund before the median time reached the timeout
  (`Immature`), and Train reverted the early refund. After the timeouts, Bob's refund
  `0xf4163dcbbe81ad53c17f410b5fab70e5907c98265c9a98f755c8ebe7f6bc78ab` went through, and so did
  Alice's Train refund.
- attacks.mjs: 9 of 9 behaved. The honest claim and refund were accepted. A wrong secret,
  paying Mallory, paying 100 CKB to Alice and the rest to Mallory, a fee above the cap, a
  `since` one second early, a refund paying Alice and a block-number `since` were each
  refused by the lock, with codes 8, 11, 14, 14, 9, 11 and 9.

### Both legs on public testnets: CKB testnet and Tempo Moderato

Tempo's testnet funds addresses through its RPC (`tempo_fundAddress`, no captcha) and pays gas
in stablecoins. Train has a Tempo build at `0xCb74407724c463EAA9bC661818364b532F8B5Cb5` with the
same lock, redeem and refund calls. Its faucet has no USDC, so these runs use PathUSD
(`0x20C0000000000000000000000000000000000000`, 6 decimals).

- usdc-first (10 PathUSD for 500 CKB): CKB claim `0x45f0724848879aea542ae26a6c6e9e1c787d50e4fba5d1c0e538f83395efc2bb`,
  Train redeem `0x66986ab432e7e6ff4a97ed9f3614e399f40dc84e50457efac1d40ed065c2e833`. A separate read of
  `getUserLock` shows Redeemed, with the stored secret hashing to the hashlock.
- ckb-first: Train redeem `0x30ce04d7774b493bf5b1ac83654b7aebf6c79dcc97916917b644c7f29a86e795`, then the
  CKB claim `0x5910481077d6c149a69d4666b0afeb5d788813010ae72c8e0b689a97b71f7451`.
- refund: CKB refund `0xf1eae5a5908e97b84f0618925979b7454d6214d023ebd6b46bbbb550a75e9ae5` and Train refund
  `0x2622a00f43a1e0256e46acc08392e66442685a53c0e495b0a22f062043f6878e`, each after the early attempt was refused.

On the fork, `evm-errcheck.mjs` shows Train's reasons: an early refund reverts with
`RefundNotAllowed`, and a wrong secret with `HashlockMismatch`. The recipient can cancel early,
which pays the sender back.

### USDC on public Base Sepolia

Test ETH from the ZalalenA faucet and 20 test USDC from Circle's faucet, both on Base Sepolia,
moved to Alice and Bob by `swap/fund-public.mjs`. Every run used 5 USDC against 500 CKB.

- usdc-first: Train lock `0x829f5bd58f78e4a89d5b5dc788c8cb2a2ddb11594eabf3b89b1a8fbfb7d946be`, CKB claim
  `0xcb3603d2df48511558187402b6bfbfb2e3df6a454b49d3bc0e1f42e9163546b4`, Train redeem
  `0xacc196de093c1d900eab583039106c0e5bd575e3d81e0e504e36390b0eb25edc`.
- ckb-first: Train redeem `0x74fa3dbdfd6219456774787a7a205d916c22570fa5afca82198c33bff12a33c2`, CKB claim
  `0x98616d4501c162160e4b6e91d08f5e155a898cbe0bb2558d4caa7b23f109ef20`.
- refund: CKB refund `0xe2fdaf79c1dbb553f57e7d60dd64d902791c465cd6379afd1bad7c1b160d9506`, Train refund
  `0x524d95293023e8bc7d1a4791db891f5e92a49466bcae97fcb4783a06d570ad9d`. The early Train refund
  reverted with `RefundNotAllowed`.

A separate read of `getUserLock` for the three hashlocks shows Redeemed, Redeemed and Refunded,
5 USDC each, token Circle USDC. In both redeemed locks, the stored secret hashes to the hashlock.

### BTC on Bitcoin testnet3

The same htlc-lock against a P2WSH script on Bitcoin testnet3 (`swap/btc.mjs`, `swap/swap-btc.mjs`).
Nothing is deployed on Bitcoin. Every run used 300 CKB against 10,000 sats, and the other side
waited for 1 Bitcoin confirmation before relying on a lock.

- btc-first: BTC lock `bd8c95020d7d018d2c89581e48178a7e7f554def4f9714128f6471c832b90ed4`, CKB lock
  `0xea670304124ed4d6cd284589df69509479d0d15a3dd5a61be06f8b5102acda94`, CKB claim
  `0xbd2e1d791a08eaa6245b4e40e357bbb52e0e50eaf562f1e1f925b98f0fee8b6d`, then Alice read the secret
  from that witness and claimed the BTC: `89f654af89438ce507dd731240df18da2c050547934ffe7000fe199aa4dbae39`.
- ckb-first: CKB lock `0xb3d00e3e9b7e87c61335ec2000b22d5ab6f0825b6442e1dad8a0f8456f34e727`, BTC lock
  `58359ba7f20e7eb0c00dc012199a1d99582c378f96156931bc847abddd7b784a`, BTC claim
  `b384c5efcc9ee09b4fb0b3fcba83cf71d4081ca4536157006e3844a6d4fb8e28`. Bob read the secret from that
  witness while it was still in the mempool and claimed the CKB:
  `0x19f6346d74d8fb74a56cf38e4178b10d7c087c1a14dbef6f8517ebe58975d1c0`.
- refund: BTC lock `56f9d0117b6d074781a368496d4dd7c8dc86d2ca0ba73d39bbc6185b41121311`, CKB refund
  `0xdaa3b9c9528e6b93b0f7b1d8a3b58fb02763a14fa754ced9ff3583503eb23260`, BTC refund
  `9bc0feb35ecbbae4f0acb23a3bc9224e95ff3209761553d822ee16e8d0e74861`. The median time took 21 min
  to pass a locktime set 10 min ahead of it.

The node's reasons for each Bitcoin control, all as expected:

| control | result |
| --- | --- |
| refund before the median time passes the locktime | refused, `non-final` |
| claim with a wrong 32-byte secret | refused, `Script failed an OP_EQUALVERIFY operation` |
| claim with the right secret, signed by the sender | refused, `Signature must be zero for failed CHECK(MULTI)SIG operation` |
| claim with a 33-byte preimage of H, size check in the script | refused, `Script failed an OP_EQUALVERIFY operation` |
| the same claim, a copy of the script without the size check | accepted, `0f9de9dd23c6cfef330dd701c9d1b6f5ba772ac005bffbeea2f4314f60ad1751` |
| refund with nLockTime one below the script's locktime | refused, `Locktime requirement not satisfied` |
| refund signed by the recipient | refused, `Signature must be zero for failed CHECK(MULTI)SIG operation` |
| refund by the sender after the locktime | accepted |

A claim on Bitcoin is 140 vbytes.
