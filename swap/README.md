# Swap scripts (testnet)

Node scripts for the CKB leg (CKB testnet, CCC) and the USDC leg (Train on Base Sepolia,
ethers). Keys are testnet only and live outside the repo (`KEYS_DIR`, default
`./keys`). The same key serves a party on both chains.

| script | what it does |
| --- | --- |
| `makekeys.mjs` | makes the deployer, Alice and Bob keys once and prints their addresses |
| `deploy.mjs` | deploys `build/htlc-lock` as a `data2` code cell, writes `deploy.testnet.json` |
| `fork-check.mjs` | checks a local fork: Train and USDC have code, the USDC balance slot |
| `swap.mjs usdc-first` | Alice locks USDC first, Bob locks CKB, Alice claims CKB, Bob redeems USDC |
| `swap.mjs ckb-first` | Bob locks CKB first, Alice locks USDC, Bob redeems USDC, Alice claims CKB |
| `swap.mjs refund` | both lock, nobody reveals, both refund; early refunds are refused first |
| `attacks.mjs` | attacks on the deployed lock through `test_tx_pool_accept`, next to the honest ones |
| `refund.mjs` | sends Bob's expired HTLC cells back to Bob |
| `fund-public.mjs` | public Base Sepolia: moves the funder key's test ETH to Alice and Bob, its test USDC to Alice |
| `swap-btc.mjs fund` | Bitcoin testnet3: sends test sats from the funder key (`BTC_FUNDER_KEY`) to Bob |
| `swap-btc.mjs btc-first` | Bob locks BTC first, Alice locks CKB, Bob claims CKB, Alice claims BTC with the secret from the CKB witness |
| `swap-btc.mjs ckb-first` | Alice locks CKB first, Bob locks BTC, Alice claims BTC, Bob claims CKB with the secret from the Bitcoin witness |
| `swap-btc.mjs refund` | both lock, nobody reveals, both refund; controls on the Bitcoin script on the way |

`EVM_CHAIN` picks the EVM chain: `base-sepolia` (Circle test USDC, the default) or
`tempo-moderato` (PathUSD, public). Fund a Tempo address with
`curl -X POST https://rpc.moderato.tempo.xyz -d '{"jsonrpc":"2.0","id":1,"method":"tempo_fundAddress","params":["<lowercase address>"]}'`.
`evm-errcheck.mjs` (fork only) prints Train's revert reasons.

For Base Sepolia, `EVM_RPC` picks the endpoint. The default is a local anvil fork:

```
anvil --fork-url https://sepolia.base.org --chain-id 84532 --port 8545
```

On the fork, `swap.mjs` funds the test wallets itself (ETH balance, and the USDC balance slot,
which is slot 9). On the public chain (`EVM_RPC=https://sepolia.base.org`), Alice needs test
USDC and both need test ETH.

Each run writes its transactions and balances to `runs/`.

The side that picks the secret locks first and gets the longer timeout. The other side
checks the first lock on chain before it locks, and refuses unless the first timeout
outlasts its own by at least 20 minutes.

## Bitcoin

`btc.mjs` builds the Bitcoin side. Nothing is deployed there: each swap pays to its own P2WSH
address, whose script holds the terms.

```
OP_IF
  OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <recipient pubkey>
OP_ELSE
  <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <sender pubkey>
OP_ENDIF
OP_CHECKSIG
```

- The size check keeps both chains on the same secret: the CKB lock takes 32 bytes only.
- A claim on Bitcoin needs the recipient's signature as well as the secret. On CKB it does not,
  because the lock fixes where the coins go.
- The locktime is a time, judged against the chain's median time past. The scripts compare
  timeouts on each chain's own clock, never on this machine's. On 2026-11-09 the testnet3
  median time ran about 100 minutes ahead of the wall clock, and testnet4's about 50.
- Defaults: 24 h for the side that locks first, 12 h for the other, and at least 3 h between
  them (`LONG_SEC`, `SHORT_SEC`, `MARGIN_SEC`). The margin is above the 2 h a Bitcoin block
  time may run ahead. `BTC_CONF` (default 1) is the confirmations the other side waits for.
- `BTC_API` picks the esplora endpoint, default `https://mempool.space/testnet/api`.
