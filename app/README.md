# Order book (testnet)

Live on testnet: https://swapbook.lusocryptolabs.com

A page and a small server where people post and take CKB <-> USDC and CKB <-> BTC offers.
Settlement is the hashlock swap from the repository root: `htlc-lock` on CKB testnet, Train on Base
Sepolia, and a P2WSH script per swap on Bitcoin testnet3.

- Three pairs, CKB·USDC, CKB·ETH and CKB·BTC, picked at the top of Trocar, of Livro and of the publish form.
- The page has three tabs. Trocar: say what you give, and the page picks the best offers for it
  (up to 5, online makers first by default) and shows the average price against the market.
  Livro: the offers grouped by price level, with filters (online, answers within 1 h, size,
  record), and publishing an offer. As minhas: your swaps and offers, and "É a tua vez" when
  someone took part of your offer and locked.
- Offers are divisible. The maker sets a minimum piece; a taker takes any piece from that minimum
  (or exactly what is left) up to what is left. Each piece is a fill: a swap of its own, with its
  own secret and both locks, at the offer's price (USDC rounded down to the unit). A fill holds
  its part of the offer until it fails before the maker locks (abandoned after 10 min, or refunded).
  Holding a piece costs nothing until the lock, so one account holds at most 2 pieces at a time and
  one address (the client's IP, from nginx) at most 3.
- Each maker shows a record (fills done, and fills where the taker locked and the maker did not)
  and whether they are online: the maker's page or script checks in every minute
  (`POST /api/heartbeat` with its tokens); online means seen in the last 150 s.
- API: `GET /api/offers` (open, with something left), `GET /api/offers/:id` (with its fills),
  `POST /api/offers` (`minCkb` optional, default the whole offer), `POST /api/offers/:id/fills`
  (`ckb`, `hashlock`, `taker`), then `POST /api/fills/:id/taker-lock`, `maker-lock`, `reveal`, and
  `GET /api/fills/:id`. Offers stored before fills existed load as offers taken whole, with their
  swap as the one fill under the same id.

- Wallet: the Cellula wallet only (his call, 2026-11-10). One connection gives its CKB account, its
  Ethereum address on Base and its Bitcoin key; each step is reviewed and signed in its window
  (cellula-wallet decision 0065). Until then the page also took any EIP-6963 Ethereum wallet, JoyID,
  UTXO Global and pasted addresses; the end-to-end scripts that drove those are gone with them.
- BTC: only the Cellula wallet gives or receives it. Bitcoin's script cannot say where coins go,
  so each claim and refund is signed ahead by the person it pays, which a pasted address cannot do
  (see below). Offers and pieces from 5000 sats to 0.1 BTC, windows of 6 h or more, and BTC prices
  shown in sats per CKB.
- Prices: the book serves CKB/USD and BTC/USD (`/api/price`, median of Binance, CoinGecko, Gate,
  KuCoin, for each). The form suggests amounts from it; locked amounts never
  depend on it.
- The taker picks the secret in the browser and locks first, with the longer timeout.
  The maker checks that lock on chain and locks second. The taker checks the maker's lock,
  claims it, and hands the secret to the book.
- Each offer has a response window W, picked by the maker: 1, 6, 12 or 24 h. After the taker
  locks, the maker has W to come back and lock. The maker's lock runs L, the pair's shortest
  window (1 h; 6 h with BTC), whatever W is: the taker then has L to reveal (less a 10 min
  margin; 3 h with BTC), never the whole window. That limits how long a taker holds a free
  option on the price: it is shorter, not gone. The taker's lock runs W + L + 40 min (2 h with BTC), so the maker's side
  keeps that margin after a reveal. A page loaded before L existed locks the taker for 2W + 40
  min; the book still takes that. Offers made before windows existed keep 2 h and 1 h.
- The server never holds funds or the parties' keys. Its watcher only sends transactions
  anyone may send: claims once the secret is public (they pay the address in the lock),
  and refunds after a timeout (they pay the sender). On CKB they need no signature; on
  Base a relayer key pays the gas; on Bitcoin they were signed ahead by their owner (below).
- Each page checks the other side's lock on chain before it locks or reveals. It does not
  trust the book.

## Run

```
npm clean-install
npm run build
RELAYER_KEY_FILE=<testnet key with Base Sepolia ETH> node server/server.mjs
```

Env: `PORT` (8787), `DATA_DIR` (offers.json), `DIST_DIR`, `WATCH_MS`, `RELAYER_KEY` or
`RELAYER_KEY_FILE`, `T_*` to shorten the timings for tests (see `server/server.mjs`), and
`WINDOWS` (seconds, comma separated) to offer short windows in tests.
