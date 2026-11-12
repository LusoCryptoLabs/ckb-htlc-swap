// The order book page. The Cellula wallet is the only wallet: it signs on CKB, on Base and on
// Bitcoin, each step reviewed in its own window (his call, 2026-11-10).
// Every lock or reveal is preceded by this page's own check of the other side's lock on chain.
import { ccc } from "@ckb-ccc/core";
import { CellulaWalletSigner } from "cellula-sdk";
import { ethers } from "ethers";
import {
  NET, T, CONF, setTimings, legs, ckbClient, evmProvider, train, usdc, htlcScript, checkTrainLock, checkHtlcCell,
  htlcSpendTx, htlcState, trainLockState, ckbMedianTime, trainLockParams, makerTimeout, sha256hex, fmtCkb, fmtUsdc,
  parseCkb, MIN_CKB, offerPrice, vsMarket, fmtPrice, fmtPct,
  setWindows, timingsFor, makerDeadline, fillUsdc, pieceOk, quoteFills, remainingCkb, tokenOf, amountKey, fmtEth,
  ASSETS, assetOf, fmtOther, windowsFor,
} from "../../shared/swaplib.mjs";
import { BTC, fmtBtc, btcCoins, btcMedianTime, btcLockState, btcBroadcast, fundingVout, txidOf, claimWithSecret } from "../../shared/btclib.mjs";
import { LANG, LOCALE, tr, setLang } from "./i18n.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a, n = 6) => (a && a.length > 2 * n + 3 ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : a ?? "");
const client = ckbClient();
const pub = evmProvider();
const W = { evm: null, ckb: null }; // connected wallet
let MKT = null; // { usdPerCkb, sources, spreadPct, at } from the book
let LIMITS = null; // the public test's limits from the book: { takeUsd, takeUsdBtc, ipDayUsd }, USD

let priceReady;
/** Resolves once the market has answered (or failed): a screen that shows it waits for this. */
const PRICE_READY = new Promise((r) => (priceReady = r));
async function loadPrice() {
  try { MKT = await api("GET", "/api/price"); } catch { MKT = null; }
  LOADED.price = true;
  priceReady();
  renderTicker();
  if ($("#swapbox")) renderQuote();
  if ($("#bookbox") && LOADED.offers) renderBook();
  const pa = document.getElementById("new")?.dataset.asset ?? SWAP.asset;
  const h = document.getElementById("f-mkt");
  if (h) showIn(h, marketLine(pa));
  const fp = document.getElementById("f-price");
  if (fp && !fp.value && mktO(pa)) { fp.value = fmtPrice(mktO(pa) * UNIT[pa].mul); fp.dispatchEvent(new Event("input", { bubbles: true })); }
}
/** The strip under the header: the two market prices, standing still. */
function renderTicker() {
  const t = $("#tickerTrack");
  if (!t || !LOADED.price) return;
  const items = [
    MKT ? `CKB <b>$${esc(pt(fmtPrice(MKT.usdPerCkb)))}</b>` : "",
    MKT?.usdPerEth ? `ETH <b>$${esc(pt(Math.round(MKT.usdPerEth).toLocaleString(LOCALE)))}</b>` : "",
    MKT?.usdPerBtc ? `BTC <b>$${esc(pt(Math.round(MKT.usdPerBtc).toLocaleString(LOCALE)))}</b>` : "",
  ].filter(Boolean);
  const html = items.length ? items.map((x) => `<span>${x}</span>`).join("") : `<span>${tr("Sem preço de mercado agora")}</span>`;
  if (t.querySelector(".sktext")) { t.dataset.html = html; return showIn(t, html); }
  if (t.dataset.html !== html) { t.dataset.html = html; t.innerHTML = html; }
}
const SK = (cls = "") => `<span class="sk ${cls}"></span>`;

// ------------------------------------------------------------------ waiting shapes
// The names app's rule (LCL.cells, 2026-09-25): nothing says an answer before it has it. Until then a
// screen shows the shape it showed last time in this browser: its real markup, the words hidden. What
// arrives after the screen is up fades in, and a size that changed glides instead of jumping.
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SHAPE = {
  key: (k) => `book:shape:${LANG}:${k}`,
  save(k, html) { try { localStorage.setItem(this.key(k), html); } catch {} },
  get(k) { try { return localStorage.getItem(this.key(k)); } catch { return null; } },
};
/** The HTML with its words hidden: each run of text in a .sktext, nothing focusable, no ids or links. */
function ghost(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  const walk = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent.trim()) texts.push(n);
  for (const n of texts) { const w = document.createElement("span"); w.className = "sktext"; n.replaceWith(w); w.append(n); }
  t.content.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
  t.content.querySelectorAll("a[href]").forEach((e) => e.removeAttribute("href"));
  t.content.querySelectorAll("button, input, a").forEach((e) => e.setAttribute("tabindex", "-1"));
  for (const e of t.content.children) { e.classList.add("ghost"); e.setAttribute("aria-hidden", "true"); e.setAttribute("inert", ""); }
  return t.innerHTML;
}
/** Runs `change` on `el`; if its height changed, it glides there from the old one (0.22 s). */
function glide(el, change) {
  if (!el) return change();
  const h0 = el.getBoundingClientRect().height;
  change();
  const h1 = el.getBoundingClientRect().height;
  if (REDUCED || Math.abs(h1 - h0) < 2) return;
  el.animate([{ height: `${h0}px`, overflow: "clip" }, { height: `${h1}px`, overflow: "clip" }], { duration: 220, easing: "ease-out" });
}
/** Real content in `el`: where a waiting shape was, the words fade in and the height glides. */
function showIn(el, html) {
  const waited = !!el.querySelector(".ghost, .sk, .sktext");
  glide(el, () => { el.innerHTML = html; });
  if (waited && !REDUCED) for (const c of el.children.length ? el.children : [el]) { c.classList.remove("wfade"); void c.offsetWidth; c.classList.add("wfade"); }
}
function marketLine(asset = SWAP.asset) {
  if (!LOADED.price) return `<span class="sktext">${tr("Preço de mercado: <strong>{price}</strong> <span title=\"{sources}\">(o do meio entre várias bolsas)</span>.", { price: "0,0000000 USDC", sources: "" }).replace(/<[^>]+>/g, "")}</span>`;
  if (!mktO(asset)) return tr("Sem preço de mercado agora: escreve o preço à mão.");
  return tr('Preço de mercado: <strong>{price}</strong> <span title="{sources}">(o do meio entre várias bolsas)</span>.',
    { price: esc(priceText(mktO(asset), asset)), sources: esc(MKT.sources.map((x) => x.name).join(", ")) });
}
const vsText = (o) => (MKT ? ` · ${tr("{pct} vs mercado", { pct: fmtPct(vsMarket(offerPrice(o), MKT.usdPerCkb)) })}` : "");
let busy = false;

// ------------------------------------------------------------------ local records (tokens, secrets)
const store = {
  get(id) { try { return JSON.parse(localStorage.getItem(`book:${id}`) ?? "null"); } catch { return null; } },
  set(id, v) { try { localStorage.setItem(`book:${id}`, JSON.stringify(v)); } catch {} },
  ids() { try { return Object.keys(localStorage).filter((k) => k.startsWith("book:")).map((k) => k.slice(5)); } catch { return []; } },
};

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error ?? `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}
async function postUntilOk(url, body, tries = 15) {
  for (let i = 0; ; i++) {
    try { return await api("POST", url, body); }
    catch (e) {
      const retry = e.status === 409 || e.status === undefined || e.status >= 500;
      if (!retry || i >= tries) throw e;
      note(tr("À espera de que o livro veja o teu envio ({n})…", { n: i + 1 })); await sleep(8000);
    }
  }
}

function note(msg, kind = "") {
  const n = $("#notice");
  if (!msg) { n.hidden = true; return; }
  n.className = `notice ${kind}`; n.textContent = msg; n.hidden = false;
}
// Notices are toasts over the bottom bar, where the person's thumb and eyes are; an error also
// buzzes on a phone that can.
const fail = (e) => { console.error(e); note(friendly(e), "err"); navigator.vibrate?.(40); };
document.getElementById("notice").addEventListener("click", () => note(""));
/** Says `msg` after the hash change about to happen, which clears the notice (route()). */
const sayAfterRoute = (fn) => window.addEventListener("hashchange", () => setTimeout(fn, 0), { once: true });
function friendly(e) {
  const m = e?.shortMessage ?? e?.info?.error?.message ?? e?.message ?? String(e);
  // The book refuses with 429 for two reasons: pieces held without a lock, or the public test's daily limit.
  // 502, 503 and 504 come from nginx while a deploy swaps the book (its maintenance page), not from the book.
  if ([502, 503, 504].includes(e?.status)) return tr("O livro está a ser actualizado. Tenta outra vez daqui a um minuto.");
  if (e?.status === 429 && /a day/i.test(m)) return tr("Chegaste ao limite diário do teste para esta troca. Volta amanhã, ou experimenta outro par.");
  if (e?.status === 429) return tr("Já tens partes reservadas sem as trancar. Tranca uma, ou espera 10 minutos.");
  if (e?.status === 409 && /per swap/i.test(m)) return tr("Acima do limite do teste: escreve um valor mais pequeno.");
  if (/user rejected|denied|ACTION_REJECTED/i.test(m) || e?.code === 4001 || e?.error?.code === 4001) return tr("Cancelaste na carteira. Nada foi enviado.");
  if (e?.code === -32002 || /already pending/i.test(m)) return tr("O MetaMask tem um pedido à espera. Abre o MetaMask (ícone da raposa), aprova-o e recarrega esta página.");
  if (/the wallet did not sign|did not connect|closed before it answered|was not opened/i.test(m)) return tr("A carteira não confirmou. Nada foi enviado.");
  if (/did not answer in time/i.test(m)) return tr("A carteira não respondeu a tempo. Nada foi enviado: tenta outra vez.");
  if (/blocks the wallet/i.test(m)) return tr("O navegador bloqueou a janela da carteira. Permite janelas deste site e tenta outra vez.");
  if (/insufficient/i.test(m)) return tr("Não tens saldo suficiente para isto, contando com a taxa da rede.");
  if (/missing revert data|execution reverted/i.test(m)) return tr("O contrato recusaria esta transacção, e nada foi enviado. Confirma o saldo e a rede (Base Sepolia).");
  return m;
}

// The Cellula wallet's link dialogs (cellula-sdk) are in English; this page says them in Portuguese
// or in Chinese, and leaves the SDK's own English in English.
const SDK_PT = new Map([
  ["Your Cellula wallet opens in a new window to connect.", "A carteira Cellula abre-se para te ligares."],
  ["Your Cellula wallet opens in a new window to sign.", "A carteira Cellula abre-se para confirmares."],
  ["Open the wallet", "Abrir a carteira"],
  ["Cancel", "Cancelar"],
  ["Connect in your Cellula app, then come back here.", "À espera de que te ligues na carteira Cellula. Depois, esta página continua sozinha."],
  ["Sign in your Cellula app, then come back here.", "À espera da tua confirmação na carteira Cellula. Depois de confirmares, esta página continua sozinha."],
]);
const SDK_ZH = new Map([
  ["Your Cellula wallet opens in a new window to connect.", "Cellula 钱包会在新窗口中打开，供你连接。"],
  ["Your Cellula wallet opens in a new window to sign.", "Cellula 钱包会在新窗口中打开，供你确认。"],
  ["Open the wallet", "打开钱包"],
  ["Cancel", "取消"],
  ["Connect in your Cellula app, then come back here.", "正在等待你在 Cellula 钱包中连接。连接后，本页面会自动继续。"],
  ["Sign in your Cellula app, then come back here.", "正在等待你在 Cellula 钱包中确认。确认后，本页面会自动继续。"],
]);
const SDK_TEXT = LANG === "pt" ? SDK_PT : LANG === "zh" ? SDK_ZH : null;
if (SDK_TEXT) new MutationObserver((ms) => {
  for (const m of ms) for (const n of m.addedNodes) {
    if (n.nodeType !== 1 || !/^link-/.test(n.dataset?.testid ?? "")) continue;
    n.querySelectorAll("p, button").forEach((e) => { const t = SDK_TEXT.get(e.textContent.trim()); if (t) e.textContent = t; });
  }
}).observe(document.body, { childList: true });

// ------------------------------------------------------------------ wallets
// One wallet, the Cellula wallet: one connection gives its CKB account, its Ethereum address and its
// Bitcoin key. Base is still reached through an EIP-1193 provider, the one cellulaProvider makes.
const pref = {
  get() { try { return JSON.parse(localStorage.getItem("book:wallet") ?? "{}"); } catch { return {}; } },
  set(v) { try { localStorage.setItem("book:wallet", JSON.stringify({ ...pref.get(), ...v })); } catch {} },
};
// Bitcoin is signed only by the Cellula wallet here: it signs a swap's claim and refund ahead.
const canGive = (chain) => (chain === "evm" ? Boolean(W.evm) : chain === "btc" ? Boolean(W.cellula && W.btcPub) : Boolean(W.ckb));
/** A wallet for both sides of a pair: CKB, and the other side's address or key. */
const readyFor = (asset) => Boolean(W.ckbAddr && (asset === "BTC" ? W.btcPub : W.evmAddr));
const ready = () => readyFor(SWAP.asset);
/** Me, as the book takes a party for a pair. */
const meFor = (asset) => ({ evm: W.evmAddr ?? null, ckbAddress: W.ckbAddr, ...(asset === "BTC" ? { btcPub: W.btcPub } : {}) });

async function ensureBase(provider = W.evmProvider) {
  const id = await provider.request({ method: "eth_chainId" });
  if (id === NET.evmChainHex) return;
  try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: NET.evmChainHex }] }); }
  catch (e) {
    if (e.code !== 4902) throw e;
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: NET.evmChainHex, chainName: "Base Sepolia",
      rpcUrls: [NET.evmRpc], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://sepolia.basescan.org"] }] });
  }
}

// One wallet request at a time: a second request while a popup is open is refused ("already pending").
let connecting = null;
function serial(fn) {
  connecting ??= (async () => { try { await fn(); note(""); } catch (e) { fail(e); } finally { connecting = null; await renderWallet(); route(); } })();
  return connecting;
}

async function setCkb(signer, name, address) {
  const a = address ?? (await signer.getRecommendedAddressObj());
  W.ckb = signer; W.ckbName = name;
  W.ckbAddr = a.toString(); W.ckbLock = a.script; W.ckbLockHash = a.script.hash();
}

// The Cellula wallet on both sides (cellula-wallet decision 0065, step 3). One connection gives its CKB
// account and its Ethereum address; on Base the page talks to it as to any EIP-1193 wallet, and each
// transaction goes to the wallet's window, which signs only the swap's own calls, reviewed there.
// The signed transaction comes back and is sent from here, as on CKB.
const cellulaEvm = {
  get() { try { const a = localStorage.getItem("book:cellula-evm"); return a && ethers.isAddress(a) ? ethers.getAddress(a) : null; } catch { return null; } },
  keep(a) { try { if (a) localStorage.setItem("book:cellula-evm", a); else localStorage.removeItem("book:cellula-evm"); } catch {} },
};
const cellulaBtc = {
  get() { try { const v = JSON.parse(localStorage.getItem("book:cellula-btc") ?? "null"); return v && /^0[23][0-9a-f]{64}$/.test(v.pub ?? "") && typeof v.address === "string" ? v : null; } catch { return null; } },
  keep(v) { try { if (v) localStorage.setItem("book:cellula-btc", JSON.stringify(v)); else localStorage.removeItem("book:cellula-btc"); } catch {} },
};
class CellulaBoth extends CellulaWalletSigner {
  answer = null;
  async ask(req) {
    const a = await super.ask(req.kind === "connect" ? { ...req, evm: true, btc: true } : req);
    if (req.kind === "connect") this.answer = a;
    return a;
  }
  async connect() {
    await super.connect();
    const e = this.answer?.evm;
    cellulaEvm.keep(typeof e === "string" && ethers.isAddress(e) ? ethers.getAddress(e) : null);
    const b = this.answer?.btc;
    cellulaBtc.keep(b && /^0[23][0-9a-f]{64}$/.test(b.pub ?? "") && typeof b.address === "string" ? { pub: b.pub, address: b.address } : null);
  }
  async disconnect() { await super.disconnect(); cellulaEvm.keep(null); cellulaBtc.keep(null); }
  askEvm(tx) { return this.ask({ kind: "evm-tx", chainId: NET.evmChainId, tx }); }
  /** A swap's Bitcoin lock (funding and refund signed ahead) or a claim signed ahead, from the wallet. */
  askBtc(req) { return this.ask(req); }
}
function useCellulaBtc(s) {
  const b = cellulaBtc.get();
  if (!b) return;
  W.cellula = s; W.btcPub = b.pub; W.btcAddr = b.address;
}

/** The Cellula wallet's Ethereum address as an EIP-1193 provider on Base Sepolia: reads go to the
 *  public node; a transaction is signed in the wallet's window, checked to be the one asked, sent. */
function cellulaProvider(signer, address) {
  const err = (message, code) => Object.assign(new Error(message), { code });
  return {
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return [address];
        case "eth_chainId": return NET.evmChainHex;
        case "wallet_switchEthereumChain":
          if (String(params[0]?.chainId).toLowerCase() === NET.evmChainHex) return null;
          throw err(tr("Aqui a carteira Cellula assina só na Base Sepolia."), 4902);
        case "eth_sendTransaction": {
          const tx = params[0] ?? {};
          const data = String(tx.data ?? tx.input ?? "0x").toLowerCase();
          if (tx.from && tx.from.toLowerCase() !== address.toLowerCase()) throw err(tr("Essa transacção não é desta carteira."), 4100);
          let a;
          try { a = await signer.askEvm({ to: tx.to, data, ...(tx.value && BigInt(tx.value) ? { value: ethers.toQuantity(tx.value) } : {}) }); }
          catch (e) { throw err(e?.message ?? "the wallet did not sign", 4001); }
          const got = a?.kind === "signed" ? ethers.Transaction.from(a.tx) : null;
          if (!got || got.from?.toLowerCase() !== address.toLowerCase() || got.to?.toLowerCase() !== String(tx.to).toLowerCase() || got.data.toLowerCase() !== data || got.chainId !== BigInt(NET.evmChainId))
            throw err(tr("A carteira devolveu outra transacção: nada foi enviado."), 4001);
          return await pub.send("eth_sendRawTransaction", [a.tx]);
        }
        case "personal_sign": case "eth_sign": case "eth_signTransaction": case "eth_signTypedData_v4":
          throw err(tr("A carteira Cellula não assina isto para sites."), 4200);
        default: return pub.send(method, params);
      }
    },
    on() {}, removeListener() {},
  };
}

async function useCellulaEvm(s, address) {
  W.evmProvider = cellulaProvider(s, address); W.evmName = tr("Carteira Cellula");
  W.evm = await new ethers.BrowserProvider(W.evmProvider).getSigner(address);
  W.evmAddr = address;
  pref.set({ evm: "cellula", evmPaste: null });
}

async function useCellula() {
  note(tr("A abrir a carteira Cellula…"));
  const s = new CellulaBoth(client);
  await s.connect();
  await setCkb(s, tr("Carteira Cellula"));
  pref.set({ ckb: "cellula", ckbPaste: null });
  useCellulaBtc(s);
  const evm = cellulaEvm.get();
  if (evm) await useCellulaEvm(s, evm);
  else throw new Error(tr("A carteira Cellula ligou-se para a CKB, mas esta versão dela ainda não dá um endereço na Base. Actualiza a carteira e liga outra vez."));
}

/**
 * Forgets the wallet on this page, and that it was used: the next visit does not reconnect it until
 * it is picked again. A swap under way is not lost:
 * its secret stays in this browser, and connecting again carries on.
 */
async function disconnectWallet() {
  try { await W.ckb?.disconnect?.(); } catch {}
  cellulaEvm.keep(null); cellulaBtc.keep(null);
  pref.set({ evm: "none", evmPaste: null, ckb: "none", ckbPaste: null });
  for (const k of ["evm", "evmProvider", "evmName", "evmAddr", "ckb", "ckbName", "ckbAddr", "ckbLock", "ckbLockHash", "cellula", "btcPub", "btcAddr", "bal", "balText", "name"]) W[k] = null;
  SWAP.touched = false;
}

/** Reconnects the Cellula wallet if this browser used it last, without asking for anything new. */
async function restore() {
  const p = pref.get();
  W.likely = p.ckb === "cellula";
  try {
    if (p.ckb === "cellula") {
      const s = new CellulaBoth(client);
      if (await s.isConnected()) {
        await setCkb(s, tr("Carteira Cellula"));
        useCellulaBtc(s);
        if (p.evm === "cellula" && cellulaEvm.get()) await useCellulaEvm(s, cellulaEvm.get());
      }
    }
  } catch (e) { console.warn("restore", e); }
  W.likely = false;
  note("");
  await renderWallet();
  route();
}

function openWallets() {
  const m = $("#modal");
  const connected = Boolean(W.evmAddr || W.ckbAddr);
  m.innerHTML = `<div class="card" role="dialog" aria-modal="true" aria-labelledby="w-t"><h3 id="w-t">${connected ? tr("A tua carteira") : tr("Ligar carteira")}</h3>
    ${connected ? $("#wallet").innerHTML
      : `<button class="go wide" id="w-cellula" type="button">${tr("Carteira Cellula")}</button>
    <p class="small muted">${tr("Serve para CKB, USDC, ETH e Bitcoin. Cada passo pede a tua impressão digital, na carteira.")}</p>`}
    <div class="row">${connected ? `<button class="btn" id="w-off" type="button">${tr("Desligar carteira")}</button>` : ""}<button class="btn" id="w-close" type="button">${tr("Fechar")}</button></div></div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; };
  $("#w-close").onclick = close;
  if ($("#w-cellula")) $("#w-cellula").onclick = () => { close(); serial(useCellula); };
  if ($("#w-off")) $("#w-off").onclick = () => { close(); serial(disconnectWallet); };
}

async function signerEvm() {
  if (!W.evmProvider) throw new Error(tr("Para isto precisas de uma carteira da Base ligada, não só de um endereço."));
  await ensureBase();
  W.evm = await new ethers.BrowserProvider(W.evmProvider).getSigner();
  return W.evm;
}

async function renderWallet() {
  const el = $("#wallet");
  const chip = $("#connect");
  const connected = Boolean(W.evmAddr || W.ckbAddr);
  // The strip keeps the addresses for the wallet sheet; on screen the header's chip says the balances.
  el.hidden = true;
  if (!connected && W.likely) { chip.classList.add("on"); chip.innerHTML = `<i class="dot"></i><span>${tr("Carteira")}</span>`; showConnect(); return; }
  if (!connected) { chip.classList.remove("on"); chip.textContent = tr("Ligar carteira"); showConnect(); if ($("#swapbox")) renderQuote(); return; }
  chip.classList.add("on");
  chip.innerHTML = `<i class="dot"></i><span>${tr("Carteira")}</span>`;
  showConnect();
  const [ckb, usd, eth, btc] = await Promise.all([
    W.ckbLock ? client.getBalanceSingle(W.ckbLock).catch(() => null) : null,
    W.evmAddr ? usdc(pub).balanceOf(W.evmAddr).catch(() => null) : null,
    W.evmAddr ? pub.getBalance(W.evmAddr).catch(() => null) : null,
    // BTC: only confirmed coins count, since the wallet spends only those; the rest is said apart.
    W.btcAddr ? btcCoins(W.btcAddr).then((cs) => cs.reduce((a, c) => (c.confirmed ? { ...a, c: a.c + BigInt(c.value) } : { ...a, p: a.p + BigInt(c.value) }), { c: 0n, p: 0n })).catch(() => null) : null,
  ]);
  W.bal = { ckb, usd, eth, btc: btc?.c ?? null, btcPending: btc?.p ?? 0n };
  W.balRead = true;
  const ckb2 = (sh) => { const n = Math.floor(ckbNum(sh) * 100) / 100; return pt(Number.isInteger(n) ? n.toLocaleString(LOCALE) : n.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })); };
  W.balText = { ckb: W.ckbAddr ? `${ckb === null ? "?" : ckb2(ckb)} CKB` : "", usd: W.evmAddr ? `${usd === null ? "?" : pt(fmtUsdc(usd))} USDC` : "", btc: W.btcAddr ? `${btc === null ? "?" : pt(fmtBtc(btc.c))} BTC` : "" };
  renderChip();
  const name = W.ckbName && W.evmName && W.ckbName !== W.evmName ? `${W.ckbName} + ${W.evmName}` : W.ckbName ?? W.evmName;
  W.name = name;
  // One row per coin: what there is, on which network, and the address to receive it (the full one is
  // copied). ETH has no address of its own (the USDC one): it is shown as the fee it pays, and when there
  // is too little to give USDC, the row says so. The three <code> are the addresses, CKB, Base, Bitcoin.
  const coinRow = (icon, amount, sym, net, addr) => `<div class="cr"><i class="coin ${icon}"></i>
      <div class="cr-main"><span class="cr-amt"><b class="num">${esc(amount)}</b> ${sym}</span><span class="cr-net">${esc(net)}</span>
        ${addr ? `<code class="cr-addr" title="${esc(addr)}">${esc(short(addr, 6))}</code>` : ""}</div>
      ${addr ? `<button class="btn btn-small" data-copy="${esc(addr)}" type="button">${tr("Copiar")}</button>` : ""}</div>`;
  const amt = (t) => (t ? t.replace(/\s?(CKB|USDC|BTC)$/, "") : "?");
  const lowEth = W.evmAddr && eth !== null && eth < MIN_GAS;
  el.innerHTML = `<div class="mywallet"><div class="mw-head"><span class="mw-name">${esc(name)}</span></div>
    <div class="coins">
      ${W.ckbAddr ? coinRow("coin-ckb", amt(W.balText.ckb), "CKB", "CKB testnet", W.ckbAddr) : ""}
      ${W.evmAddr ? coinRow("coin-usdc", amt(W.balText.usd), "USDC", "Base Sepolia", W.evmAddr) : ""}
      ${W.evmAddr ? `<div class="cr"><i class="coin coin-eth"></i><div class="cr-main"><span class="cr-amt"><b class="num">${eth === null ? "?" : esc(pt(Number(ethers.formatEther(eth)).toFixed(5)))}</b> ETH</span><span class="cr-net">${tr("paga a taxa da rede na Base")}</span>
        ${lowEth ? `<span class="cr-warn">${tr('Sem ETH não consegues dar USDC. <a href="https://faucet.zalalena.com/base" target="_blank" rel="noopener">Pede ETH de teste</a>.')}</span>` : ""}</div></div>` : ""}
      ${W.btcAddr ? coinRow("coin-btc", amt(W.balText.btc), "BTC", "Bitcoin testnet3", W.btcAddr) : ""}
    </div>
    <div class="mw-faucets"><span class="lbl">${tr("Moedas de teste")}</span>
      <div class="row">${[["CKB", "https://faucet.nervos.org/"], ["USDC", "https://faucet.circle.com/"], ["ETH", "https://faucet.zalalena.com/base"], ["BTC", "https://coinfaucet.eu/en/btc-testnet/"]]
        .map(([c, u]) => `<a class="btn btn-small" href="${u}" target="_blank" rel="noopener">${c}</a>`).join("")}</div>
      <span class="small muted">${tr("No USDC, escolhe Base Sepolia.")}</span></div>
  </div>`;
  if ($("#swapbox")) renderQuote();
}
/** The header's chip: CKB and the coin of the pair on screen (USDC or BTC), or the other if that one has no address. */
function renderChip() {
  const chip = $("#connect");
  if (!W.balText || !chip.classList.contains("on")) return;
  chip.innerHTML = `<i class="dot"></i><span>${tr("Carteira")}</span>`;
  chip.setAttribute("aria-label", tr("Carteira: {balances}", { balances: [W.balText.ckb, W.balText.usd, W.balText.btc].filter(Boolean).join(", ") }));
}
/** The header's connect button: on Trocar, before a wallet is connected, the big button says it. */
function showConnect() {
  const h = location.hash.slice(1);
  // Hidden but in its place, so the header keeps its height on every screen.
  const away = !W.evmAddr && !W.ckbAddr && !W.likely && (h === "" || h === "swap");
  $("#connect").classList.toggle("away", away);
  $("#connect").tabIndex = away ? -1 : 0;
  $("#connect").setAttribute("aria-hidden", String(away));
}

document.addEventListener("click", async (ev) => {
  const c = ev.target.closest("[data-copy]");
  if (!c) return;
  try { await navigator.clipboard.writeText(c.dataset.copy); c.textContent = tr("Copiado"); setTimeout(() => (c.textContent = tr("Copiar")), 1500); } catch { c.textContent = tr("Copia à mão"); }
});

// ------------------------------------------------------------------ chain actions
async function lockCkb({ hashlock, recipientLockHash, timeoutSec, amount, onSent }) {
  const lock = htlcScript({ hashlock, recipientLockHash, senderLockHash: W.ckbLockHash, timeoutSec });
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: BigInt(amount) }], outputsData: ["0x"] });
  await tx.completeInputsByCapacity(W.ckb);
  await tx.completeFeeBy(W.ckb, 1000);
  note(tr("Confirma na carteira."));
  const h = await W.ckb.sendTransaction(tx);
  onSent?.({ txHash: h, index: 0 });
  note(tr("Enviado. A rede está a confirmar, demora uns segundos…"));
  await client.waitTransaction(h, 0, 300000);
  return { txHash: h, index: 0 };
}

async function lockUsdc({ hashlock, recipient, timelockDelta, amount, dstAmount, token = NET.usdc }) {
  const s = await signerEvm();
  const eth = token === ethers.ZeroAddress;
  if (eth) {
    // ETH goes into the lock as the call's value: one signature, and the fee comes from the same ETH.
    const have = await pub.getBalance(W.evmAddr);
    if (have < BigInt(amount) + ETH_FEE) throw new Error(tr("Precisas de {need} ETH e um pouco para a taxa; tens {have}.", { need: pt(fmtEth(amount)), have: pt(fmtEth(have)) }));
    note(tr("Confirma na carteira: pôr os teus ETH no cofre da troca."));
    const args = trainLockParams({ token, hashlock, amount, recipient, refundTo: W.evmAddr, timelockDelta, dstAddress: W.ckbAddr, dstAmount });
    return (await (await train(s).solverLock(...args, { value: BigInt(amount) })).wait()).hash;
  }
  const t = usdc(s);
  const [have, gas] = await Promise.all([usdc(pub).balanceOf(W.evmAddr), pub.getBalance(W.evmAddr)]);
  if (have < BigInt(amount)) throw new Error(tr("Precisas de {need} USDC e tens {have}.", { need: fmtUsdc(amount), have: fmtUsdc(have) }));
  if (gas < ethers.parseEther("0.00001")) throw new Error(NO_ETH);
  if ((await usdc(pub).allowance(W.evmAddr, NET.train)) < BigInt(amount)) {
    note(tr("Confirma na carteira (1 de 2): autorizar o cofre da troca a receber os teus USDC."));
    await (await t.approve(NET.train, BigInt(amount))).wait();
    // A public RPC node can still answer with the old allowance for a few seconds, and then the
    // wallet's gas estimate for the lock reverts. Wait until the allowance is visible.
    for (let i = 0; i < 20 && (await usdc(pub).allowance(W.evmAddr, NET.train)) < BigInt(amount); i++) await sleep(1500);
  }
  note(tr("Confirma na carteira (2 de 2): pôr os teus USDC no cofre da troca."));
  const args = trainLockParams({ hashlock, amount, recipient, refundTo: W.evmAddr, timelockDelta, dstAddress: W.ckbAddr, dstAmount });
  for (let i = 0; ; i++) {
    try { return (await (await train(s).solverLock(...args)).wait()).hash; }
    catch (e) {
      if (/user rejected|denied|ACTION_REJECTED/i.test(e?.shortMessage ?? e?.message ?? "") || i >= 4) throw e;
      note(tr("A rede ainda não viu a autorização; a tentar outra vez ({n})…", { n: i + 1 })); await sleep(3000);
    }
  }
}

/**
 * A swap's BTC lock from the Cellula wallet: the wallet signs the funding and the refund ahead in
 * one touch; this page sends the funding and reports both. `seconds` count on Bitcoin's own clock.
 */
async function lockBtc(o, key, { hashlock, recipientPub, seconds, sats }) {
  const kept = store.get(o.id)?.[key]?.btc;
  if (kept) return { btc: kept };
  const locktime = (await btcMedianTime()) + seconds;
  const terms = { hashlock, recipientPub, senderPub: W.btcPub, locktime };
  const a = await W.cellula.askBtc({ kind: "btc-lock", sats: Number(sats), hashlock, recipientPub, locktime });
  const vout = fundingVout(a.tx, terms, sats);
  if (vout < 0 || !a.refund) throw new Error(tr("A carteira devolveu outra transacção: nada foi enviado."));
  note(tr("Enviado. A rede Bitcoin está a confirmar…"));
  try { await btcBroadcast(a.tx); } catch (e) { if (!/already|known/i.test(String(e.message))) throw e; }
  const btc = { txid: txidOf(a.tx), vout, locktime, refund: a.refund };
  store.set(o.id, { ...store.get(o.id), [key]: { btc } });
  return { btc };
}

/** Locks this side's funds at most once: a retry after a failed report re-sends the report only. */
async function ensureLocked(o, key, chain, params) {
  if (chain === "btc") return lockBtc(o, key, params);
  if (chain === "evm") {
    const l = await train(pub).getSolverLock(params.hashlock, W.evmAddr);
    if (Number(l.status) !== 0) return { tx: store.get(o.id)?.[key]?.tx ?? null };
    const tx = await lockUsdc(params);
    store.set(o.id, { ...store.get(o.id), [key]: { tx } });
    return { tx };
  }
  const known = store.get(o.id)?.[key]?.outPoint;
  if (known && (await client.getTransaction(known.txHash))) return { outPoint: known };
  const outPoint = await lockCkb({ ...params, onSent: (op) => store.set(o.id, { ...store.get(o.id), [key]: { outPoint: op } }) });
  return { outPoint };
}

// ------------------------------------------------------------------ taking pieces
/**
 * Takes the chosen pieces one after the other. Each piece is its own swap: a fill with its own
 * secret, kept in this browser before anything leaves the page, then the taker's lock.
 */
async function takePieces(parts) {
  busy = true;
  if ($("#go")) { $("#go").disabled = true; $("#go").innerHTML = `<span class="spin" aria-hidden="true"></span> ${tr("A tratar da troca…")}`; }
  const taken = [];
  let err = null;
  try {
    const giveUsdc = parts[0].offer.makerGives === "CKB";
    const asset = assetOf(parts[0].offer);
    if (giveUsdc && asset === "BTC") {
      const total = parts.reduce((s, p) => s + p.usdc, 0n);
      const have = (await btcCoins(W.btcAddr)).filter((c) => c.confirmed).reduce((a, c) => a + BigInt(c.value), 0n);
      if (have < total + 1000n * BigInt(parts.length)) throw new Error(tr("Precisas de {need} e um pouco para a taxa; tens {have}.", { need: pt(fmtOther(parts[0].offer, total)), have: pt(fmtOther(parts[0].offer, have)) }));
    } else if (giveUsdc && asset === "ETH") {
      const total = parts.reduce((s, p) => s + p.usdc, 0n);
      const have = await pub.getBalance(W.evmAddr);
      if (have < total + ETH_FEE * BigInt(parts.length)) throw new Error(tr("Precisas de {need} ETH e um pouco para a taxa; tens {have}.", { need: pt(fmtEth(total)), have: pt(fmtEth(have)) }));
    } else if (giveUsdc) {
      // One approval for all the pieces, so each lock asks for one signature only.
      const total = parts.reduce((s, p) => s + p.usdc, 0n);
      const s = await signerEvm();
      const [have, gas] = await Promise.all([usdc(pub).balanceOf(W.evmAddr), pub.getBalance(W.evmAddr)]);
      if (have < total) throw new Error(tr("Precisas de {need} USDC e tens {have}.", { need: fmtUsdc(total), have: fmtUsdc(have) }));
      if (gas < ethers.parseEther("0.00001") * BigInt(parts.length)) throw new Error(NO_ETH);
      if ((await usdc(pub).allowance(W.evmAddr, NET.train)) < total) {
        note(tr("Confirma na carteira: autorizar {amount} USDC para esta troca.", { amount: fmtUsdc(total) }));
        await (await usdc(s).approve(NET.train, total)).wait();
        for (let i = 0; i < 20 && (await usdc(pub).allowance(W.evmAddr, NET.train)) < total; i++) await sleep(1500);
      }
    }
    for (const [i, p] of parts.entries()) {
      const tf = timingsFor(p.offer.window, asset);
      const secret = ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
      const hashlock = sha256hex(secret);
      const res = await api("POST", `/api/offers/${p.offer.id}/fills`, { taker: meFor(asset), hashlock, ckb: fmtCkb(p.ckb) });
      const f = res.fill;
      store.set(f.id, { role: "taker", token: res.token, secret, hashlock, at: now() });
      taken.push(f.id);
      const amount = giveUsdc ? pt(fmtOther(f, f.usdcAmount)) : pt(fmtCkb(f.ckbAmount)) + " CKB";
      note(parts.length > 1
        ? tr("Parte {i} de {n}: confirma na carteira: pôr {amount} no cofre da troca.", { i: i + 1, n: parts.length, amount })
        : tr("confirma na carteira: pôr {amount} no cofre da troca.", { amount }));
      const ref = giveUsdc && asset === "BTC"
        ? await ensureLocked(f, "takerLock", "btc", { hashlock, recipientPub: f.maker.btcPub, seconds: tf.takerLock, sats: f.usdcAmount })
        : giveUsdc
        ? await ensureLocked(f, "takerLock", "evm", { token: tokenOf(f), hashlock, recipient: f.maker.evm, timelockDelta: tf.takerLock, amount: f.usdcAmount, dstAmount: f.ckbAmount })
        : await ensureLocked(f, "takerLock", "ckb", { hashlock, recipientLockHash: f.maker.ckbLockHash, timeoutSec: now() + tf.takerLock, amount: f.ckbAmount });
      await postUntilOk(`/api/fills/${f.id}/taker-lock`, { token: res.token, ...ref });
    }
  } catch (e) { err = e; } finally {
    busy = false;
    renderWallet();
    if (taken.length) {
      // The swap's own page says where it is; an error there is said after the page changes.
      if (err) sayAfterRoute(() => fail(err));
      location.hash = taken.length === 1 ? `fill-${taken[0]}` : "mine";
    } else {
      // Nothing was taken: stay on the swap box and say why, there.
      if (err) fail(err);
      renderQuote();
    }
  }
}

/** Repeats a lock check while it only waits for confirmations, showing the wait (`waiting`). */
async function confirmed(check, waiting) {
  for (;;) {
    const c = await check();
    if (!c.pending) return c;
    note(waiting);
    await sleep(8000);
  }
}

/** The maker's side of one fill: check the taker's lock on chain, then lock for the pair's shortest window. */
async function makerLock(f) {
  const mine = store.get(f.offerId);
  if (!mine?.token) return fail(new Error(tr("Esta oferta não foi publicada neste browser.")));
  store.set(f.id, { role: "maker", offerId: f.offerId, ...store.get(f.id) });
  const { makerChain, takerChain } = legs(f);
  const t = timingsFor(f.window, assetOf(f));
  busy = true;
  try {
    note(tr("A verificar a parte de quem aceitou…"));
    let takerTimeout, btcClaim;
    if (takerChain === "btc") {
      // The taker's BTC pays me: checked on Bitcoin's clock, then my claim of it signed ahead.
      const left = await checkBtcLockForMe(f, f.takerLock, { senderPub: f.taker.btcPub, minLeft: t.makerMinLeft + t.makerBeforeTaker - 600 });
      takerTimeout = now() + left;
      note(tr("Confirma na carteira: assinar já o levantamento dos BTC."));
      btcClaim = await askBtcClaim(f, f.takerLock);
      store.set(f.id, { ...store.get(f.id), btcClaim });
    } else if (makerChain === "ckb") {
      const c = await confirmed(() => checkTrainLock(pub, { token: tokenOf(f), hashlock: f.hashlock, solver: f.taker.evm, amount: f.usdcAmount, recipient: f.maker.evm, minTimelock: now() + t.makerMinLeft + t.makerBeforeTaker, confirmations: CONF.evm }), tr("A rede está a confirmar a parte de quem aceitou…"));
      if (!c.ok) throw new Error(tr("O lock no Train não está como combinado: {why}", { why: c.why }));
      takerTimeout = c.timelock;
    } else {
      const c = await confirmed(() => checkHtlcCell(client, f.takerLock.outPoint, { hashlock: f.hashlock, amount: f.ckbAmount, recipientLockHash: f.maker.ckbLockHash, senderLockHash: f.taker.ckbLockHash, minTimeout: now() + t.makerMinLeft + t.makerBeforeTaker, confirmations: CONF.ckb }), tr("A rede está a confirmar a parte de quem aceitou…"));
      if (!c.ok) throw new Error(tr("A célula na CKB não está como combinado: {why}", { why: c.why }));
      takerTimeout = c.timeoutSec;
    }
    const mt = makerTimeout(now(), takerTimeout, t);
    if (mt - now() < t.makerMinLeft) throw new Error(tr("O tempo para trancares já passou. Não tranques; quem aceitou recebe a devolução."));
    const evmNow = Number((await pub.getBlock("latest")).timestamp);
    const ref = makerChain === "btc"
      ? await ensureLocked(f, "makerLock", "btc", { hashlock: f.hashlock, recipientPub: f.taker.btcPub, seconds: mt - now(), sats: f.usdcAmount })
      : makerChain === "ckb"
      ? await ensureLocked(f, "makerLock", "ckb", { hashlock: f.hashlock, recipientLockHash: f.taker.ckbLockHash, timeoutSec: mt, amount: f.ckbAmount })
      : await ensureLocked(f, "makerLock", "evm", { token: tokenOf(f), hashlock: f.hashlock, recipient: f.taker.evm, timelockDelta: mt - evmNow, amount: f.usdcAmount, dstAmount: f.ckbAmount });
    await postUntilOk(`/api/fills/${f.id}/maker-lock`, { token: mine.token, ...ref, ...(btcClaim ? { btcClaim } : {}) });
    note(tr("Trancado. Quando quem aceitou levantar a parte dele, o segredo fica público e a tua parte é levantada para ti."));
  } catch (e) { fail(e); } finally { busy = false; route(); }
}

const NO_ETH_WHY = tr("Para dar dólares digitais (USDC) precisas de um pouco de ETH, a moeda que paga a taxa da rede Base (menos de um cêntimo). Nesta versão de teste é grátis.");
const NO_ETH = tr("{why} Pede ETH de teste e tenta outra vez.", { why: NO_ETH_WHY });
/**
 * Checks a BTC lock that pays this wallet: unspent, BTC.conf deep, for my key and from the other
 * party's, with at least `minLeft` seconds left on Bitcoin's own clock. Returns the seconds left.
 */
async function checkBtcLockForMe(f, leg, { senderPub, minLeft }) {
  if (leg.terms.recipientPub !== W.btcPub || leg.terms.senderPub !== senderPub || leg.terms.hashlock !== f.hashlock) throw new Error(tr("O cofre BTC da outra pessoa não está como combinado. Não continuo: o teu dinheiro volta para ti no fim do prazo."));
  for (;;) {
    const st = await btcLockState({ txid: leg.txid, vout: leg.vout, sats: f.usdcAmount, terms: leg.terms });
    if (st.status !== "Pending") throw new Error(tr("O cofre BTC da outra pessoa não está como combinado ({why}).", { why: st.why ?? st.status }));
    if (st.confirmations >= BTC.conf) break;
    note(tr("A rede Bitcoin está a confirmar a parte da outra pessoa (cerca de 10 minutos)…"));
    await sleep(20000);
  }
  const left = leg.terms.locktime - (await btcMedianTime());
  if (left < minLeft) throw new Error(tr("Já é tarde para concluir com segurança: o teu dinheiro volta para ti no fim do prazo."));
  return left;
}
const askBtcClaim = (f, leg) => W.cellula.askBtc({ kind: "btc-claim", txid: leg.txid, vout: leg.vout, sats: Number(f.usdcAmount), hashlock: leg.terms.hashlock, senderPub: leg.terms.senderPub, locktime: leg.terms.locktime }).then((a) => a.tx);

const revealing = new Set();
// Enough for one claim on Base (about 100 000 gas at a few hundredths of a gwei), with room.
const MIN_GAS = ethers.parseEther("0.000005");
async function reveal(f) {
  const me = store.get(f.id);
  if (!me?.secret || revealing.has(f.id)) return;
  revealing.add(f.id);
  busy = true;
  const { makerChain } = legs(f);
  try {
    const already = await legOnChain(f, f.makerLock);
    if (already?.status === "Redeemed") { store.set(f.id, { ...store.get(f.id), claimed: true }); return; }
    note(tr("A verificar a parte da outra pessoa…"));
    const t = timingsFor(f.window, assetOf(f));
    const maxT = f.takerLock.timeoutSec - t.makerBeforeTaker + 120;
    if (makerChain === "btc") {
      const left = await checkBtcLockForMe(f, f.makerLock, { senderPub: f.maker.btcPub, minLeft: t.revealMargin + 300 });
      if (now() + left > maxT + 1800) throw new Error(tr("O cofre BTC da outra pessoa dura mais do que o combinado. Não continuo: o teu dinheiro volta para ti no fim do prazo."));
      note(tr("Confirma na carteira para receberes os BTC."));
      const btcClaim = await askBtcClaim(f, f.makerLock);
      // Sent from here, so the BTC never waits for the book; the book gets it too, to send it again.
      const txid = await sendBtc(claimWithSecret(btcClaim, me.secret));
      store.set(f.id, { ...store.get(f.id), btcClaim, claimed: txid });
      await api("POST", `/api/fills/${f.id}/reveal`, { token: me.token, secret: me.secret, btcClaim }).catch(() => {});
      note(tr("Enviado. Os BTC chegam quando a rede Bitcoin confirmar."));
      return;
    }
    if (makerChain === "ckb") {
      const c = await confirmed(() => checkHtlcCell(client, f.makerLock.outPoint, { hashlock: me.hashlock, amount: f.ckbAmount, recipientLockHash: f.taker.ckbLockHash, senderLockHash: f.maker.ckbLockHash, maxTimeout: maxT, confirmations: CONF.ckb }), tr("A rede está a confirmar a parte da outra pessoa…"));
      if (!c.ok) throw new Error(tr("A parte da outra pessoa não está como combinado ({why}). Não continuo: o teu dinheiro volta para ti no fim do prazo.", { why: c.why }));
      if (now() >= c.timeoutSec - t.revealMargin) throw new Error(tr("Já é tarde para concluir com segurança: o teu dinheiro volta para ti no fim do prazo."));
      // Claim myself: no signature, the secret is the key and the fee comes from the cell.
      const h = await client.sendTransaction(htlcSpendTx(c.cell, { secret: me.secret, toLock: ccc.Script.from(f.taker.ckbLock) }));
      store.set(f.id, { ...store.get(f.id), claimed: h });
      note(tr("Recebeste os CKB."));
    } else {
      const c = await confirmed(() => checkTrainLock(pub, { token: tokenOf(f), hashlock: me.hashlock, solver: f.maker.evm, amount: f.usdcAmount, recipient: f.taker.evm, maxTimelock: maxT, confirmations: CONF.evm }), tr("A rede está a confirmar a parte da outra pessoa…"));
      if (!c.ok) throw new Error(tr("A parte da outra pessoa não está como combinado ({why}). Não continuo: o teu dinheiro volta para ti no fim do prazo.", { why: c.why }));
      if (now() >= c.timelock - t.revealMargin) throw new Error(tr("Já é tarde para concluir com segurança: o teu dinheiro volta para ti no fim do prazo."));
      if (W.evm && (W.bal?.eth ?? 0n) >= MIN_GAS) {
        // Redeem myself. Simulate first: a redeem that reverts would still put the secret on chain.
        const s = await signerEvm();
        await train(s).redeemSolver.staticCall(me.hashlock, f.maker.evm, BigInt(me.secret));
        note(tr("Confirma na carteira para receberes os {coin}.", { coin: assetOf(f) }));
        const tx = await train(s).redeemSolver(me.hashlock, f.maker.evm, BigInt(me.secret));
        store.set(f.id, { ...store.get(f.id), claimed: tx.hash });
        const r = await tx.wait();
        note(tr("Recebeste os {coin}.", { coin: assetOf(f) }));
      } else {
        note(tr("O livro entrega-te os {coin} e paga ele a taxa. Não precisas de fazer nada.", { coin: assetOf(f) }));
      }
    }
    await api("POST", `/api/fills/${f.id}/reveal`, { token: me.token, secret: me.secret });
  } catch (e) { fail(e); revealing.delete(f.id); } finally { busy = false; route(); }
}

async function retryTakerLock(f) {
  const me = store.get(f.id);
  const { takerChain } = legs(f);
  const tf = timingsFor(f.window, assetOf(f));
  busy = true;
  try {
    const ref = takerChain === "btc"
      ? await ensureLocked(f, "takerLock", "btc", { hashlock: me.hashlock, recipientPub: f.maker.btcPub, seconds: tf.takerLock, sats: f.usdcAmount })
      : takerChain === "evm"
      ? await ensureLocked(f, "takerLock", "evm", { token: tokenOf(f), hashlock: me.hashlock, recipient: f.maker.evm, timelockDelta: tf.takerLock, amount: f.usdcAmount, dstAmount: f.ckbAmount })
      : await ensureLocked(f, "takerLock", "ckb", { hashlock: me.hashlock, recipientLockHash: f.maker.ckbLockHash, timeoutSec: now() + tf.takerLock, amount: f.ckbAmount });
    await postUntilOk(`/api/fills/${f.id}/taker-lock`, { token: me.token, ...ref });
  } catch (e) { fail(e); } finally { busy = false; route(); }
}

// ------------------------------------------------------------------ doing it without the book
// Every claim and refund below can be done by anyone; the page does them itself so that a swap
// never depends on the book being up. CKB ones need no signature; Base ones need a little ETH.
async function legOnChain(o, leg) {
  if (!leg) return null;
  if (leg.chain === "btc") return btcLockState({ txid: leg.txid, vout: leg.vout, sats: o.usdcAmount, terms: leg.terms });
  return leg.chain === "ckb" ? htlcState(client, leg.outPoint, leg.lock) : trainLockState(pub, o.hashlock, leg.solver);
}

const selfDone = new Set();
async function selfService(o, role) {
  if (!role || !o.takerLock || ["done", "refunded"].includes(o.status)) return "";
  const [mk, tk] = await Promise.all([legOnChain(o, o.makerLock), legOnChain(o, o.takerLock)]);
  const me = store.get(o.id);
  const secret = me?.secret ?? mk?.secret ?? null; // the taker knows it; the maker learns it from the taker's claim
  const median = await ckbMedianTime(client).catch(() => 0);
  const evmNow = Number((await pub.getBlock("latest")).timestamp);
  const btcNow = [o.makerLock, o.takerLock].some((l) => l?.chain === "btc") ? await btcMedianTime().catch(() => 0) : 0;
  const due = (leg, st) => (leg.chain === "ckb" ? median >= leg.timeoutSec : leg.chain === "btc" ? btcNow > 0 && btcNow >= leg.terms.locktime : evmNow > st.timelock);
  // A BTC claim or refund this browser signed ahead goes out from here with no new signature.
  const myRefund = store.get(o.id)?.[role === "taker" ? "takerLock" : "makerLock"]?.btc?.refund ?? null;
  const acts = [];
  // My incoming leg: the maker's lock pays the taker, the taker's lock pays the maker (only after the first claim).
  const incoming = role === "taker" ? [o.makerLock, mk, "taker"] : [o.takerLock, tk, "maker"];
  const outgoing = role === "taker" ? [o.takerLock, tk, "taker"] : [o.makerLock, mk, "maker"];
  const [inLeg, inSt, inTo] = incoming;
  const takerMayRetry = role === "taker" && !revealing.has(o.id) && !me?.claimed && o.status !== "maker-locked";
  if (inLeg && inSt?.status === "Pending" && secret && (role === "maker" ? mk?.status === "Redeemed" : takerMayRetry)) {
    acts.push({ id: "self-claim", label: tr("Levantar {amount} eu mesmo", { amount: role === "taker" ? gives(o, "maker") : gives(o, "taker") }), run: () => claimMyself(o, inLeg, inSt, inTo, secret),
      auto: (inLeg.chain === "ckb" && role === "maker") || (inLeg.chain === "btc" && !!me?.btcClaim), chain: inLeg.chain });
  }
  const [outLeg, outSt, outFrom] = outgoing;
  if (outLeg && outSt?.status === "Pending" && due(outLeg, outSt) && !(role === "maker" && tk?.status === "Redeemed") && (outLeg.chain !== "btc" || myRefund)) {
    acts.push({ id: "self-refund", label: tr("Recuperar {amount}", { amount: role === "taker" ? gives(o, "taker") : gives(o, "maker") }), run: () => refundMyself(o, outLeg, outSt, outFrom, myRefund), auto: outLeg.chain === "ckb" || outLeg.chain === "btc", chain: outLeg.chain });
  }
  // Base needs the wallet that pays the fee; a BTC claim not kept here needs the Cellula wallet to sign it.
  const usable = acts.filter((a) => !(a.chain === "evm" && !W.evm) && !(a.chain === "btc" && !a.auto && !W.cellula));
  acts.length = 0; acts.push(...usable);
  for (const a of acts) if (a.auto && !selfDone.has(o.id + a.id) && !busy) { selfDone.add(o.id + a.id); setTimeout(() => a.run(), 30000); }
  window.__self = acts;
  window.__chain = { mk: mk?.status, tk: tk?.status };
  return acts.length ? `<div class="row">${acts.map((a, i) => `<button class="btn btn-small" data-self="${i}" type="button" ${busy ? "disabled" : ""}>${esc(a.label)}</button>`).join("")}
    <span class="small muted">${tr("Não precisas de esperar pelo vigia.")}</span></div>` : "";
}

/** Sends a BTC transaction; one the network already has counts as sent. Returns its id. */
async function sendBtc(hex) {
  try { await btcBroadcast(hex); } catch (e) { if (!/already|known|missingorspent/i.test(String(e?.message))) throw e; }
  return txidOf(hex);
}

async function claimMyself(o, leg, st, toParty, secret) {
  busy = true;
  try {
    if (leg.chain === "btc") {
      let hex = store.get(o.id)?.btcClaim;
      if (!hex) { note(tr("Confirma na carteira para receberes os BTC.")); hex = await askBtcClaim(o, leg); store.set(o.id, { ...store.get(o.id), btcClaim: hex }); }
      const txid = await sendBtc(claimWithSecret(hex, secret));
      note(tr("Levantado na Bitcoin (transacção {tx}).", { tx: short(txid) }));
    } else if (leg.chain === "ckb") {
      const h = await client.sendTransaction(htlcSpendTx(st.cell, { secret, toLock: ccc.Script.from(o[toParty].ckbLock) }));
      note(tr("Levantado na CKB (transacção {tx}).", { tx: short(h) }));
    } else {
      const s = await signerEvm();
      await train(s).redeemSolver.staticCall(o.hashlock, leg.solver, BigInt(secret));
      const r = await (await train(s).redeemSolver(o.hashlock, leg.solver, BigInt(secret))).wait();
      note(tr("Levantado na Base (transacção {tx}).", { tx: short(r.hash) }));
    }
  } catch (e) { if (!/Dead|Unknown\(OutPoint|LockNotPending|already/i.test(String(e?.message))) fail(e); } finally { busy = false; route(); }
}

async function refundMyself(o, leg, st, fromParty, btcRefund) {
  busy = true;
  try {
    if (leg.chain === "btc") {
      const txid = await sendBtc(btcRefund);
      note(tr("Recuperado na Bitcoin (transacção {tx}).", { tx: short(txid) }));
    } else if (leg.chain === "ckb") {
      const h = await client.sendTransaction(htlcSpendTx(st.cell, { toLock: ccc.Script.from(o[fromParty].ckbLock), timeoutSec: leg.timeoutSec }));
      note(tr("Recuperado na CKB (transacção {tx}).", { tx: short(h) }));
    } else {
      const s = await signerEvm();
      await train(s).refundSolver.staticCall(o.hashlock, leg.solver);
      const r = await (await train(s).refundSolver(o.hashlock, leg.solver)).wait();
      note(tr("Recuperado na Base (transacção {tx}).", { tx: short(r.hash) }));
    }
  } catch (e) { if (!/Dead|Unknown\(OutPoint|LockNotPending|already/i.test(String(e?.message))) fail(e); } finally { busy = false; route(); }
}

// ------------------------------------------------------------------ data the views share
/** A number on screen as Portugal writes it (0,29), in Portuguese only; inputs and the API keep the point. */
/**
 * A typed amount as the parsers read it. Spaces never count. In Portuguese "," is the decimal mark.
 * In English and Chinese a comma groups thousands only where it looks like it ("1,000", "12,500";
 * "1,000.5" too); anywhere else it is the decimal mark, so "0,01" stays 0.01 and never becomes 1.
 */
const typed = (x) => {
  const v = String(x).replace(/\s/g, "");
  if (LANG === "pt") return v.replace(",", ".");
  return /^[1-9]\d{0,2}(,\d{3})+(\.\d*)?$/.test(v) ? v.replace(/,/g, "") : v.replace(",", ".");
};
const pt = (x) => (LANG === "pt" ? String(x).replace(/(\d)\.(\d)/g, "$1,$2") : String(x));
const gives = (o, who) => pt((who === "maker") === (o.makerGives === "CKB") ? `${fmtCkb(o.ckbAmount)} CKB` : fmtOther(o, o.usdcAmount));
const STATUS = { taken: tr("a começar"), "taker-locked": tr("à espera da outra pessoa"), "maker-locked": tr("a concluir"), revealed: tr("a concluir"),
  done: tr("concluída"), refunding: tr("a devolver"), refunded: tr("devolvida"), abandoned: tr("não começou"), open: tr("aberta"), cancelled: tr("parada"), closed: tr("fechada") };
const chipOf = (s) => (s === "done" ? "chip-ok" : ["refunding", "refunded", "abandoned", "cancelled"].includes(s) ? "chip-no" : "chip-wait");
/** A wait as people say it: "6 h", "30 min" (the book's windows are whole hours or minutes). */
const fmtWindow = (s) => (s % 3600 === 0 ? tr("{n} h", { n: s / 3600 }) : tr("{n} min", { n: Math.round(s / 60) }));
/** How long the taker has to reveal once the maker locks: the maker's lock less the reveal margin, rounded down to 10 min. */
const ago = (s) => { const d = now() - (s ?? 0); return d < 3600 ? tr("há {n} min", { n: Math.max(1, Math.round(d / 60)) }) : d < 86400 ? tr("há {n} h", { n: Math.round(d / 3600) }) : tr("há {n} d", { n: Math.round(d / 86400) }); };
const record = (o) => {
  const done = o.stats.done === 1 ? tr("{n} troca", { n: o.stats.done }) : tr("{n} trocas", { n: o.stats.done });
  const failed = o.stats.failed;
  return !failed ? done : failed > 1 ? tr("{done}, {n} falhadas", { done, n: failed }) : tr("{done}, {n} falhada", { done, n: failed });
};
const whoLine = (o) => `<span><code>${esc(short(o.maker.evm, 4))}</code></span><span>${esc(record(o))}</span><span><i class="live${o.online ? " on" : ""}"></i>${o.online ? tr("online") : esc(tr("visto {ago}", { ago: ago(o.seenAt) }))}</span><span>${esc(tr("volta em até {w}", { w: fmtWindow(o.window) }))}</span>`;
const isMine = (o) => store.get(o.id)?.role === "maker" || (W.evmAddr && o.maker.evm.toLowerCase() === W.evmAddr.toLowerCase()) || (W.ckbLockHash && o.maker.ckbLockHash === W.ckbLockHash);
/** When `sec` falls, from today: the day (0 today, 1 tomorrow), the hour, and the weekday's name. */
const dayAt = (sec) => {
  const d = new Date(sec * 1000), t = d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return { diff: Math.round((day(d) - day(new Date())) / 86400000), t, weekday: d.toLocaleDateString(LOCALE, { weekday: "long" }) };
};
/** "hoje às 14:05", "amanhã às 09:30", or the weekday. */
const fmtAt = (sec) => {
  const { diff, t, weekday } = dayAt(sec);
  return diff === 0 ? tr("hoje às {t}", { t }) : diff === 1 ? tr("amanhã às {t}", { t }) : tr("{day} às {t}", { day: weekday, t });
};
/** "a partir das 17:01", "a partir de amanhã às 09:30". */
const fmtFrom = (sec) => {
  const { diff, t, weekday } = dayAt(sec);
  return diff === 0 ? tr("a partir das {t}", { t }) : diff === 1 ? tr("a partir de amanhã às {t}", { t }) : tr("a partir de {day} às {t}", { day: weekday, t });
};
/** Time left, for a time that has not passed yet. */
const fmtLeft = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? tr("{h} h {m} min", { h, m }) : tr("{n} min", { n: m }); };
const txLink = (l) => !l.tx ? "" : ` · <a href="${explorerOf(l.chain)}${esc(l.tx)}" target="_blank" rel="noopener">${l.chain === "evm" ? "Base" : l.chain === "btc" ? "Bitcoin" : "CKB"} <code>${esc(short(l.tx, 4))}</code></a>`;
const usd = (n) => n.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// On a computer the swap box and the book stand side by side (design pass, 2026-11-10).
const WIDE = matchMedia("(min-width: 1080px)");
const ICON = {
  people: `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" shape-rendering="crispEdges"><rect x="3" y="3" width="4" height="4"/><rect x="13" y="3" width="4" height="4"/><path d="M2 16v-5h7v5M11 16v-5h7v5"/></svg>`,
  lock: `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" shape-rendering="crispEdges"><rect x="4" y="9" width="12" height="8"/><path d="M7 9V4h6v5"/></svg>`,
  clock: `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" shape-rendering="crispEdges"><rect x="3" y="3" width="14" height="14"/><path d="M10 6v5h4"/></svg>`,
  fuel: `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" shape-rendering="crispEdges"><rect x="3" y="4" width="9" height="13"/><path d="M5 8h5M12 10h3v5h2V8l-2-3"/></svg>`,
  key: `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" shape-rendering="crispEdges"><rect x="2" y="7" width="6" height="6"/><path d="M8 10h10M14 10v3M17 10v3"/></svg>`,
};
/** Under the swap button: what the person is trusting, said where the button asks for it. */
const trustHtml = (asset) => `<li>${ICON.people}<b>${tr("Pessoa a pessoa")}</b><span>${tr("sem exchange pelo meio")}</span></li>
  <li>${ICON.lock}<b>${tr("Cofres")}</b><span>${tr("o livro nunca toca no dinheiro")}</span></li>
  <li>${ICON.clock}<b>${asset === "BTC" ? tr("Até uma hora") : tr("Uns minutos")}</b><span>${tr("podes fechar e voltar")}</span></li>`;
/** A running clock, 4:05 or 1:02:09. */
const fmtClock = (sec) => { const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
/** How long a swap took, as people say it. */
const fmtTook = (sec) => { const s = Math.max(0, Math.round(sec)); return s < 60 ? tr("{s} s", { s }) : s < 3600 ? tr("{m} min {s} s", { m: Math.floor(s / 60), s: s % 60 }) : tr("{h} h {m} min", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) }); };
const netOf = (c) => (c === "evm" ? tr("na Base") : c === "btc" ? tr("no Bitcoin") : tr("na CKB"));
const explorerOf = (c) => (c === "evm" ? NET.evmExplorer : c === "btc" ? BTC.explorer : NET.ckbExplorer);
const ckbNum = (shannons) => Number(BigInt(shannons)) / 1e8;

let OFFERS = []; // open offers, from the book
// What has come from the book at least once: until then the views show the shape of what loads.
const LOADED = { offers: false, mine: false, price: false };
let MY = { offers: [], fills: [] }; // my offers (full) and the fills I took
let lastBeat = 0;
const myRecords = () => store.ids().map((id) => [id, store.get(id)]).filter(([, r]) => r);
async function refreshData() {
  try { OFFERS = await api("GET", "/api/offers"); LOADED.offers = true; } catch {}
  const recs = myRecords();
  const offerIds = recs.filter(([, r]) => r.role === "maker" && !r.offerId).map(([id]) => id);
  const fillIds = recs.filter(([, r]) => r.role === "taker").map(([id]) => id);
  const [offs, fills] = await Promise.all([
    Promise.all(offerIds.map((id) => api("GET", `/api/offers/${id}`).catch(() => null))),
    Promise.all(fillIds.map((id) => api("GET", `/api/fills/${id}`).catch(() => null))),
  ]);
  MY = { offers: offs.filter(Boolean), fills: fills.filter(Boolean) };
  LOADED.mine = true;
  renderTicker();
  // While this page is open, my open offers count as online.
  const tokens = MY.offers.filter((o) => o.status === "open").map((o) => store.get(o.id)?.token).filter(Boolean);
  if (tokens.length && now() - lastBeat > 55) { lastBeat = now(); api("POST", "/api/heartbeat", { tokens }).catch(() => {}); }
}
const myTurn = () => MY.offers.flatMap((o) => o.fills.filter((f) => f.status === "taker-locked").map((f) => ({ o, f })));

function drawBanner() {
  const turn = myTurn().filter(({ f }) => location.hash !== `#fill-${f.id}`); // the fill on screen says it itself
  const when = turn.length ? esc(fmtAt(Math.min(...turn.map(({ f }) => makerDeadline(f.takerLock.timeoutSec, timingsFor(f.window, assetOf(f))))))) : "";
  $("#banner").innerHTML = turn.length ? `<div class="action"><p>${turn.length === 1
    ? tr("<strong>É a tua vez.</strong> Alguém aceitou parte da tua oferta e já pôs a sua parte no cofre. Põe a tua até {when}.", { when })
    : tr("<strong>É a tua vez.</strong> {n} pessoas aceitaram parte da tua oferta e já puseram a sua parte no cofre. Põe a tua até {when}.", { n: turn.length, when })}</p>
    <div class="row">${turn.map(({ f }) => `<a class="btn btn-secret btn-small" href="#fill-${f.id}">${tr("{amount} CKB: ver e confirmar", { amount: esc(fmtCkb(f.ckbAmount)) })}</a>`).join("")}</div></div>` : "";
}

// ------------------------------------------------------------------ Trocar: the swap box
// Starts empty, on the other coin for CKB.
// giveUsdc: the person gives the pair's other coin (USDC or BTC) and gets CKB. The box always opens
// that way, the other coin for CKB (his call, 2026-11-10); the arrows turn it round.
const SWAP = { giveUsdc: true, amount: "", online: true, touched: false, asset: "USDC" };
const tokenPill = (t) => t === "CKB" ? `<i class="coin coin-ckb"></i><span>CKB<small>Nervos</small></span>`
  : t === "BTC" ? `<i class="coin coin-btc"></i><span>BTC<small>Bitcoin</small></span>`
  : t === "ETH" ? `<i class="coin coin-eth"></i><span>ETH<small>Ether</small></span>` : `<i class="coin coin-usdc"></i><span>USDC<small>${tr("dólar digital")}</small></span>`;
// The pair's other coin, by default the one on screen.
const fmtO = (units, asset = SWAP.asset) => ASSETS[asset].fmt(units);
/** What one has, as said beside the box: ETH cut (never rounded up) to 6 decimals, not its 18. */
const fmtHave = (units, asset = SWAP.asset) => {
  if (asset !== "ETH") return fmtO(units, asset);
  const u = BigInt(units);
  return fmtEth(u - (u % 10n ** 12n));
};
const parseO = (str, asset = SWAP.asset) => ASSETS[asset].parse(str);
const numO = (units, asset = SWAP.asset) => Number(BigInt(units)) / 10 ** ASSETS[asset].decimals;
/** Dollars for one whole coin of the pair's other side (USDC is one). */
const usdO = (asset = SWAP.asset) => (asset === "BTC" ? MKT?.usdPerBtc ?? null : asset === "ETH" ? MKT?.usdPerEth ?? null : 1);
/** The unit a price per CKB is written in: USDC, sats (1e-8 BTC) or gwei (1e-9 ETH): long rows of zeros otherwise. */
const UNIT = { USDC: { mul: 1, name: "USDC" }, BTC: { mul: 1e8, name: "sats" }, ETH: { mul: 1e9, name: "gwei" } };
/** What a lock of ETH keeps back for its own fee on Base. */
const ETH_FEE = ethers.parseEther("0.00002");
/** The market price of CKB in the pair's other coin. */
const mktO = (asset = SWAP.asset) => (MKT && usdO(asset) ? MKT.usdPerCkb / usdO(asset) : null);
const otherForCkb = (sh, price, asset = SWAP.asset) => BigInt(Math.floor(ckbNum(sh) * price * 10 ** ASSETS[asset].decimals));
const ckbForOther = (units, price, asset = SWAP.asset) => BigInt(Math.floor((numO(units, asset) / price) * 100)) * 1_000_000n;
/** A price as people read it: USDC per CKB, or sats per CKB (BTC per CKB is a long row of zeros). */
const priceText = (p, asset = SWAP.asset) => (asset === "BTC" ? tr("{p} sats por CKB", { p: pt(fmtPrice(p * 1e8)) }) : asset === "ETH" ? tr("{p} gwei por CKB", { p: pt(fmtPrice(p * 1e9)) }) : tr("{p} USDC por CKB", { p: pt(fmtPrice(p)) }));
const priceShort = (p, asset = SWAP.asset) => pt(fmtPrice(p * UNIT[asset].mul));
const balO = (asset = SWAP.asset) => (asset === "BTC" ? W.bal?.btc : asset === "ETH" ? W.bal?.eth : W.bal?.usd);
/** A big amount that would not fit its row (0,00025127 BTC on a small phone) gets smaller, never cut. */
function fit(el) {
  el.style.fontSize = "";
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > el.clientWidth + 1 && size > 20) { size -= 2; el.style.fontSize = `${size}px`; }
}
/** What the person gives and gets, each in dollars at the market price, and whether they gain or lose. */
function verdict(giveUsdc, giveUnits, getUnits, asset = SWAP.asset) {
  if (!MKT || !usdO(asset)) return null;
  const a = giveUsdc ? numO(giveUnits, asset) * usdO(asset) : ckbNum(giveUnits) * MKT.usdPerCkb;
  const b = giveUsdc ? ckbNum(getUnits) * MKT.usdPerCkb : numO(getUnits, asset) * usdO(asset);
  if (!(a > 0) || !(b > 0)) return null;
  const d = (b - a) / a, pct = `${Math.round(Math.abs(d) * 100)}%`;
  // 3%, not 2%: the market maker sells and buys 2% from the market and reprices at 1%, so its own
  // offers sat in "Careful" whenever the market moved a little (seen while recording the video).
  const kind = d >= 0.03 ? "good" : d <= -0.03 ? "bad" : "even";
  const head = kind === "even" ? tr("Preço justo, perto do preço de mercado.")
    : kind === "good" ? (d > 0.25 ? tr("Preço muito acima do de mercado, a teu favor.") : tr("Recebes cerca de {pct} mais do que ao preço de mercado.", { pct }))
    : tr("Atenção: recebes cerca de {pct} menos do que ao preço de mercado.", { pct });
  return { kind, html: `<div class="verdict ${kind}" id="verdict"><strong>${esc(head)}</strong></div>` };
}
let QUOTE = null;

const swapHtml = () => `<h1 class="headline" id="headline">${tr("Troca CKB por <b>USDC</b>, <b>ETH</b> ou <b>Bitcoin</b> com outra pessoa.")}</h1>
    <section class="box" id="swapbox">
      <div class="pairs" role="tablist" aria-label="${tr("Par")}">${Object.keys(ASSETS).map((a) => `<button role="tab" type="button" data-asset="${a}" aria-selected="${SWAP.asset === a}">${a} · CKB</button>`).join("")}</div>
      <div class="leg"><div class="leghead"><label for="pay">${tr("Dás")}</label><span class="legbal" id="payBal"></span></div>
        <div class="legrow"><input id="pay" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(SWAP.amount)}"><span class="token" id="payTok"></span></div>
        <div class="legfoot"><span id="payFiat"></span></div></div>
      <button class="flip" id="flip" type="button" aria-label="${tr("Trocar os lados")}">⇅</button>
      <div class="leg"><div class="leghead"><span class="lbl">${tr("Recebes")}</span></div>
        <div class="legrow"><output id="get" class="num">0</output><span class="token" id="getTok"></span></div>
        <div class="legfoot"><span id="getFiat"></span></div></div>
      <button class="rate" id="rate" type="button" hidden></button>
      <div class="deal" id="deal"></div>
      <div class="quote" id="quote"></div>
      <div id="nomatch"></div>
      <button class="go" id="go" type="button">${tr("Trocar")}</button>
      <p class="note" id="goNote"></p>
      <ul class="trust" id="trust" data-asset="${SWAP.asset}">${trustHtml(SWAP.asset)}</ul>
      <details class="more settings" id="opts"><summary>${tr("Detalhes e opções")}</summary>
        <label class="toggle"><input type="checkbox" id="online" ${SWAP.online ? "checked" : ""}> ${tr("Só quem pode trocar já (fica feito em minutos)")}</label>
        <div id="detailRows"></div>
        <details class="route" id="route"><summary id="routeSum"></summary><div class="offers" id="routeList"></div></details>
      </details>
    </section>`;
function bindSwap() {
    $("#pay").addEventListener("input", (e) => { SWAP.amount = e.target.value; SWAP.touched = true; fit(e.target); renderQuote(); });
    document.querySelectorAll("#swapbox [data-asset]").forEach((b) => b.addEventListener("click", () => {
      if (SWAP.asset === b.dataset.asset) return;
      setPair(b.dataset.asset);
      if (WIDE.matches) { $("#view").innerHTML = ""; return viewDuo(); }
      $("#pay").value = "";
      document.querySelectorAll("#swapbox [data-asset]").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.asset === SWAP.asset)));
      renderQuote();
    }));
    $("#online").addEventListener("change", (e) => { SWAP.online = e.target.checked; renderQuote(); });
    $("#rate").addEventListener("click", () => { SWAP.invert = !SWAP.invert; renderQuote(); });
    $("#flip").addEventListener("click", () => {
      const f = $("#flip"); f.classList.remove("spun"); void f.offsetWidth; f.classList.add("spun");
      SWAP.giveUsdc = !SWAP.giveUsdc; SWAP.touched = true; SWAP.amount = ""; $("#pay").value = ""; renderQuote(); $("#pay").focus();
    });
    $("#go").addEventListener("click", () => {
      if (!ready() || $("#go").dataset.act === "wallet") return openWallets();
      if ($("#go").dataset.act === "type") return $("#pay").focus();
      if (QUOTE?.parts.length) confirmPieces(QUOTE.parts);
    });
    // Máx: all of it; for CKB, less what the wallet keeps for its change cell and the fee.
    $("#payBal").addEventListener("click", (e) => {
      if (!e.target.closest("#max") || !W.bal) return;
      const keep = 62n * 100_000_000n;
      // BTC: less a little for the network fee of the lock.
      const other = balO(), v = SWAP.giveUsdc ? (SWAP.asset === "BTC" ? (other > 2000n ? other - 2000n : 0n) : SWAP.asset === "ETH" ? (other > ETH_FEE ? other - ETH_FEE : 0n) : other) : W.bal.ckb !== null && W.bal.ckb > keep ? W.bal.ckb - keep : 0n;
      if (!v) return;
      SWAP.amount = SWAP.giveUsdc ? fmtO(v) : String(Math.floor(ckbNum(v))); SWAP.touched = true; $("#pay").value = SWAP.amount; renderQuote();
    });
}
function viewSwap() {
  if (WIDE.matches) return viewDuo();
  if (!$("#swapbox")) { $("#view").innerHTML = swapHtml(); bindSwap(); }
  renderQuote();
}
/** A computer's screen: the swap box on the left, the book on the right, both live. */
function viewDuo() {
  if (!$("#swapbox") || !$("#bookbox")) {
    $("#view").innerHTML = `<div class="duo"><div class="duo-l">${swapHtml()}</div><div class="duo-r">${bookHtml()}</div></div>`;
    bindSwap(); bindBook();
  }
  renderQuote(); renderBook();
}

function renderQuote() {
  const giveUsdc = SWAP.giveUsdc;
  const asset = SWAP.asset;
  $("#payTok").innerHTML = tokenPill(giveUsdc ? asset : "CKB");
  $("#getTok").innerHTML = tokenPill(giveUsdc ? "CKB" : asset);
  const has = W.bal ? (giveUsdc ? balO() : W.bal.ckb) : null;
  const pending = giveUsdc && asset === "BTC" && W.bal?.btcPending > 0n ? ` <span class="muted">${tr("(+{amount} a confirmar)", { amount: esc(pt(fmtO(W.bal.btcPending))) })}</span>` : "";
  const balWait = W.likely || (ready() && has == null && !W.balRead);
  const balHtml = has != null ? `${tr("Tens {amount}", { amount: esc(pt(giveUsdc ? fmtHave(has) : fmtCkbShort(has))) })}${pending} <button class="max" id="max" type="button">${tr("Máx")}</button>`
    : balWait ? `<span class="sktext">${tr("Tens {amount}", { amount: "000 000" })} ${tr("Máx")}</span>` : "";
  if ($("#payBal").dataset.v !== balHtml) { $("#payBal").dataset.v = balHtml; if (has != null && $("#payBal .sktext")) showIn($("#payBal"), balHtml); else $("#payBal").innerHTML = balHtml; }
  let units = 0n;
  try { units = giveUsdc ? parseO(typed(SWAP.amount) || "0") : parseCkb(typed(SWAP.amount) || "0"); } catch { units = 0n; }
  const filter = (o) => (!SWAP.online || o.online) && !isMine(o);
  const pool = OFFERS.filter((o) => assetOf(o) === asset && (o.makerGives === "CKB") === giveUsdc && filter(o));
  // More than the connected wallet holds: no quote, the box says what there is (a DEX's "not enough").
  const can = ready() && canGive(giveUsdc ? ASSETS[asset].chain : "ckb");
  const have = giveUsdc ? (asset === "ETH" && balO() != null ? (balO() > ETH_FEE ? balO() - ETH_FEE : 0n) : balO()) : W.bal?.ckb;
  const short_ = ready() && can && units > 0n && have != null && have < units;
  // More than the public test lets one swap move: said at the amount, like "more than you have", with no
  // quote of a part (255 396 CKB showed "you get 10 USDC", for 11 052 of them, marked fair; 2026-11-10).
  const capUsd = LIMITS ? (asset === "BTC" ? LIMITS.takeUsdBtc : LIMITS.takeUsd) : 0;
  const unitUsd = giveUsdc ? usdO() : MKT?.usdPerCkb;
  const typedUsd = unitUsd && units > 0n ? (giveUsdc ? numO(units) : ckbNum(units)) * unitUsd : 0;
  const overTest = !short_ && capUsd > 0 && typedUsd > capUsd * 1.05;
  // The most one swap may give in the test, rounded down (whole CKB; six places of the other coin).
  const places = Math.min(6, ASSETS[asset].decimals);
  const capGive = overTest ? (giveUsdc ? BigInt(Math.floor((capUsd / unitUsd) * 10 ** places)) * 10n ** BigInt(ASSETS[asset].decimals - places) : BigInt(Math.floor(capUsd / unitUsd)) * 100_000_000n) : null;
  $("#pay").closest(".leg").classList.toggle("over", short_ || overTest);
  const q0 = units > 0n && !short_ && !overTest ? quoteFills(OFFERS, { give: giveUsdc ? asset : "CKB", asset, amount: units, maxPieces: 5, filter }) : { parts: [], left: 0n };
  // Only part of the amount has someone to take it now: the box quotes nothing rather than a different amount
  // than the one typed (255 396 CKB showed "you get 10 USDC", for 11 052 of them; his phone, 2026-11-10).
  // The alert offers that part as its own swap, or an offer for the rest.
  const partGive = q0.parts.length && (giveUsdc ? q0.left >= 1000n : q0.left >= 100_000_000n) ? units - q0.left : null;
  const capped = q0.parts.length === 5 && pool.length > 5;
  const q = partGive !== null ? { parts: [], left: units } : q0;
  QUOTE = q;
  const ckb = q.parts.reduce((s, p) => s + p.ckb, 0n), usdc = q.parts.reduce((s, p) => s + p.usdc, 0n);
  const usdCkb = MKT?.usdPerCkb, mkt = mktO();
  // No offer for this amount: the market's price says about how much, shown as an estimate, never as a quote.
  let est = null;
  try { est = !q.parts.length && units > 0n && !short_ && !overTest && mkt ? (giveUsdc ? ckbForOther(units, mkt) : otherForCkb(units, mkt)) : null; } catch { est = null; }
  const g = $("#get");
  const getText = short_ || overTest ? "0" : pt(est !== null ? `≈ ${giveUsdc ? fmtCkbShort(est) : fmtO(est)}` : giveUsdc ? fmtCkbShort(ckb) : fmtO(usdc));
  g.classList.toggle("est", est !== null || short_ || overTest);
  g.classList.toggle("zero", units === 0n);
  if (!LOADED.offers && units > 0n) { g.innerHTML = SK("big"); g.dataset.v = ""; }
  else if (g.dataset.v !== getText) {
    g.dataset.v = getText; g.textContent = getText; fit(g);
    // The new amount drops in: what changed is what the eye sees.
    if (units > 0n) { g.classList.remove("tick"); void g.offsetWidth; g.classList.add("tick"); }
  }
  if (short_) $("#payFiat").innerHTML = `<span class="overmsg">${tr("Mais do que tens: {amount}", { amount: esc(pt(giveUsdc ? fmtO(have) + " " + asset : fmtCkbShort(have) + " CKB")) })}</span>`;
  else if (overTest) $("#payFiat").innerHTML = `<span class="overmsg">${tr("Acima do limite do teste: {n} $ por troca", { n: capUsd })}</span>`;
  else if (usdCkb && usdO() && units > 0n) $("#payFiat").textContent = `≈ ${usd(giveUsdc ? numO(units) * usdO() : ckbNum(units) * usdCkb)} USD`;
  else $("#payFiat").innerHTML = units > 0n && !LOADED.price ? SK() : "";
  const getUsd = usdCkb && usdO() && q.parts.length ? usd(giveUsdc ? ckbNum(ckb) * usdCkb : numO(usdc) * usdO()) : null;
  $("#getFiat").textContent = est !== null ? tr("preço de mercado")
    : getUsd !== null ? `≈ ${getUsd} USD` : "";
  const avg = q.parts.length ? numO(usdc) / ckbNum(ckb) : 0;
  const vs = mkt && q.parts.length ? vsMarket(avg, mkt) : null;
  const allOnline = q.parts.every((p) => p.offer.online);
  const slowest = q.parts.reduce((m, p) => Math.max(m, p.offer.window), 0);
  // One line of exchange rate, the way a DEX says it; a tap turns it round.
  const rate = q.parts.length ? avg : est !== null ? mkt : null;
  const r = $("#rate");
  r.hidden = !rate;
  if (rate) r.innerHTML = `${SWAP.invert ? `1 ${asset} = ${esc(pt(Math.round(1 / rate).toLocaleString(LOCALE)))} CKB` : `1 CKB = ${esc(priceShort(rate, asset))} ${UNIT[asset].name}`}${est !== null ? ` <small>${tr("mercado")}</small>` : ""} <span aria-hidden="true">⇄</span>`;
  const v = q.parts.length ? verdict(giveUsdc, units - q.left, giveUsdc ? ckb : usdc) : null;
  if ($("#trust").dataset.asset !== asset) { $("#trust").dataset.asset = asset; $("#trust").innerHTML = trustHtml(asset); }
  // The public test caps each swap (the book refuses more): the swap box says so, and the button stops above it.
  const worthUsd = MKT && q.parts.length ? ckbNum(q.parts.reduce((s, p) => s + p.ckb, 0n)) * MKT.usdPerCkb : 0;
  const overCap = capUsd > 0 && worthUsd > capUsd * 1.05;
  // The deal in a line under the rate; before a wallet is connected, that giving USDC takes a little ETH.
  const needEth = !ready() && giveUsdc && asset === "USDC" && units > 0n && !short_ && !overTest;
  const dealHtml = `${q.parts.length && vs !== null && v ? dealTag(vs, v.kind) : ""}${needEth ? `<p class="need">${ICON.fuel}<span>${tr("Para trancar o USDC precisas de um pouco de ETH na Base.")}</span></p>` : ""}`;
  if ($("#deal").dataset.v !== dealHtml) { $("#deal").dataset.v = dealHtml; $("#deal").innerHTML = dealHtml; }
  // A price that loses money keeps its full warning; a slow offer says how slow; the test's limit in one line.
  $("#quote").innerHTML = q.parts.length ? `${v?.kind === "bad" ? v.html : ""}${allOnline ? "" : `<p class="note">${tr("Pode demorar até {w}, se a outra pessoa não estiver disponível. Podes fechar a página e voltar.", { w: esc(fmtWindow(slowest)) })}</p>`}${capUsd > 0 ? `<p class="limit">${tr("Teste público: até {n} $ por troca e por dia, em cada sentido.", { n: `<b>${capUsd}</b>` })}</p>` : ""}` : "";
  $("#detailRows").innerHTML = q.parts.length ? `
      <div class="qrow"><span>${tr("Preço")}</span><span class="num">${esc(priceText(avg))}</span></div>
      ${vs === null ? "" : `<div class="qrow"><span>${tr("Preço de mercado")}</span><span class="num">${esc(priceText(mkt))}</span></div>`}
      <div class="qrow"><span>${tr("Com quem")}</span><span>${q.parts.length === 1 ? tr("uma pessoa") : tr("{n} pessoas, cada uma é uma troca à parte", { n: q.parts.length })}</span></div>` : "";
  const partText = partGive !== null ? esc(pt(giveUsdc ? `${fmtO(partGive)} ${asset}` : `${fmtCkbShort(partGive)} CKB`)) : "";
  // Less than the smallest piece any offer here takes: say how much it takes, and offer to use that.
  const minOf = (o) => { const rem = remainingCkb(o), c = BigInt(o.minCkb) < rem ? BigInt(o.minCkb) : rem;
    return giveUsdc ? (c * BigInt(o.usdcAmount) + BigInt(o.ckbAmount) - 1n) / BigInt(o.ckbAmount) : c; };
  const least = !q.parts.length && units > 0n && !short_ && pool.length ? pool.map(minOf).reduce((m, x) => (x < m ? x : m)) : null;
  const tooSmall = least !== null && units < least;
  const leastText = tooSmall ? esc(pt(giveUsdc ? fmtO(least) + " " + asset : fmtCkbShort(least) + " CKB")) : "";
  const capText = overTest ? esc(pt(giveUsdc ? `${fmtO(capGive)} ${asset}` : `${fmtCkbShort(capGive)} CKB`)) : "";
  $("#nomatch").innerHTML = LOADED.offers && units > 0n && !short_ && (overTest || !q.parts.length) ? `<div class="alert"><span>${overTest
    ? tr('No teste público, cada troca vai até {n} $: uns <b class="num">{amount}</b>.', { n: capUsd, amount: capText })
    : partGive !== null
    ? (capped ? tr('Cada troca junta até 5 pessoas: desta vez dá para <b class="num">{part}</b>.', { part: partText })
      : SWAP.online ? tr('Entre as pessoas disponíveis agora, só há quem troque <b class="num">{part}</b> disto.', { part: partText })
      : tr('Só há quem troque <b class="num">{part}</b> disto.', { part: partText }))
    : tooSmall ? tr('As ofertas que há trocam a partir de <b class="num">{min}</b>. Troca isso, ou publica a tua oferta para esta quantia.', { min: leastText })
    : SWAP.online ? tr('Publica a tua oferta e espera que alguém aceite, ou <a class="linkbtn" href="#swap" id="allOffers">vê também quem não está disponível agora</a>.')
    : tr("Publica a tua oferta e espera que alguém aceite.")}</span>
    ${overTest ? `<button class="btn-ghost" type="button" id="useCap">${tr("Trocar {min}", { min: capText })}</button>` : partGive !== null ? `<button class="btn-ghost" type="button" id="usePart">${tr("Trocar {min}", { min: partText })}</button>` : tooSmall ? `<button class="btn-ghost" type="button" id="useLeast">${tr("Trocar {min}", { min: leastText })}</button>` : ""}
    <button class="btn-ghost" type="button" id="pubRest">${partGive !== null ? tr("Publicar a minha oferta para o resto") : tr("Publicar a minha oferta")}</button></div>` : "";
  $("#pubRest")?.addEventListener("click", () => openPublish({ giveUsdc, amount: partGive !== null ? q0.left : units }));
  $("#usePart")?.addEventListener("click", () => { SWAP.amount = giveUsdc ? fmtO(partGive) : String(ckbNum(partGive)); SWAP.touched = true; $("#pay").value = pt(SWAP.amount); renderQuote(); });
  $("#useCap")?.addEventListener("click", () => { SWAP.amount = giveUsdc ? fmtO(capGive) : String(ckbNum(capGive)); SWAP.touched = true; $("#pay").value = pt(SWAP.amount); renderQuote(); });
  $("#useLeast")?.addEventListener("click", () => { SWAP.amount = giveUsdc ? fmtO(least) : String(ckbNum(least)); SWAP.touched = true; $("#pay").value = pt(SWAP.amount); renderQuote(); });
  $("#allOffers")?.addEventListener("click", (e) => { e.preventDefault(); SWAP.online = false; $("#online").checked = false; renderQuote(); });
  $("#route").hidden = !q.parts.length;
  $("#routeSum").innerHTML = `<span>${q.parts.length === 1 ? tr("A oferta escolhida") : tr("As {n} ofertas escolhidas", { n: q.parts.length })}</span>`;
  $("#routeList").innerHTML = q.parts.map((p) => `<div class="offer"><span class="amt num">${esc(pt(`${fmtCkbShort(p.ckb)} CKB ⇄ ${fmtO(p.usdc)} ${asset}`))}</span><span class="px num">${esc(priceShort(offerPrice(p.offer)))}</span><div class="who">${whoLine(p.offer)}</div></div>`).join("");
  // The button says what is missing, and does the next thing (DEX practice): never a grey button with no reason.
  const go = $("#go");
  const noEth = ready() && can && giveUsdc && asset === "USDC" && units > 0n && W.bal?.eth != null && W.bal.eth < ethers.parseEther("0.00001") * BigInt(Math.max(1, q.parts.length));
  let label, act = "swap", off = false;
  if (busy) { label = null; off = true; }
  else if (W.likely) { label = null; off = true; act = "type"; }
  else if (!ready()) { label = tr("Ligar carteira"); act = "wallet"; }
  else if (!can) { label = giveUsdc && asset === "BTC" ? tr("Liga a carteira Cellula para dar BTC") : tr("Liga uma carteira para dar {coin}", { coin: giveUsdc ? asset : "CKB" }); act = "wallet"; }
  else if (units === 0n) { label = tr("Escreve um valor"); act = "type"; }
  else if (!LOADED.offers) { label = tr("A procurar ofertas…"); off = true; }
  else if (short_) { label = tr("Tens só {amount}", { amount: pt(giveUsdc ? fmtHave(have) + " " + asset : fmtCkbShort(have) + " CKB") }); off = true; }
  else if (overTest) { label = tr("Acima do limite do teste: {n} $ por troca", { n: capUsd }); off = true; }
  else if (partGive !== null) { label = tr("Só há quem troque {part} agora", { part: pt(giveUsdc ? `${fmtO(partGive)} ${asset}` : `${fmtCkbShort(partGive)} CKB`) }); off = true; }
  else if (!q.parts.length) { label = tr("Ninguém troca isto agora"); off = true; }
  else if (overCap) { label = tr("Acima do limite do teste: {n} $ por troca", { n: capUsd }); off = true; }
  else if (noEth) { label = tr("Falta ETH para a taxa"); off = true; }
  else label = q.parts.length > 1 ? tr("Trocar com {n} pessoas", { n: q.parts.length }) : tr("Trocar");
  go.dataset.act = act;
  go.disabled = off;
  go.classList.toggle("idle", act === "type");
  if (busy) go.innerHTML = `<span class="spin" aria-hidden="true"></span> ${tr("A tratar da troca…")}`;
  else if (W.likely) go.innerHTML = `<span class="sktext">${tr("Escreve um valor")}</span>`;
  else if (go.querySelector(".sktext")) { go.textContent = label; if (!REDUCED) { go.classList.remove("wfade"); void go.offsetWidth; go.classList.add("wfade"); } }
  else go.textContent = label;
  const asks = q.parts.length + (giveUsdc && asset === "USDC" ? 1 : 0);
  $("#goNote").innerHTML = noEth && !short_ && q.parts.length
    ? `<span class="alert blocker">${esc(NO_ETH_WHY)} <a class="btn btn-small" href="https://faucet.zalalena.com/base" target="_blank" rel="noopener">${tr("Pedir ETH de teste")}</a> <button class="btn btn-small" data-copy="${esc(W.evmAddr ?? "")}" type="button">${tr("Copiar o meu endereço")}</button></span>`
    : q.parts.length && can && !short_ ? esc(asks === 1
      ? tr("Confirmas uma vez na carteira.")
      : tr("Confirmas {n} vezes na carteira.", { n: asks })) : "";
}
const fmtCkbShort = (shannons) => { const n = ckbNum(shannons); return n >= 100 ? Math.floor(n).toLocaleString(LOCALE) : fmtCkb(shannons); };
/** The deal in a line, under the rate: how far from the market, and the verdict in a word. */
function dealTag(vs, kind) {
  const pct = `${pt(Math.abs(vs).toFixed(1))}%`;
  const side = Math.abs(vs) < 0.05 ? tr("ao preço de mercado") : vs > 0 ? tr("{pct} acima do mercado", { pct }) : tr("{pct} abaixo do mercado", { pct });
  const word = kind === "good" ? tr("a teu favor") : kind === "bad" ? tr("atenção") : tr("justo");
  return `<p class="dealtag k-${kind}"><span>${esc(side)} · ${esc(word)}</span></p>`;
}

function confirmPieces(parts) {
  const giveUsdc = parts[0].offer.makerGives === "CKB";
  const totalGive = parts.reduce((s, p) => s + (giveUsdc ? p.usdc : p.ckb), 0n);
  const totalGet = parts.reduce((s, p) => s + (giveUsdc ? p.ckb : p.usdc), 0n);
  const longest = parts.reduce((m, p) => Math.max(m, timingsFor(p.offer.window, assetOf(p.offer)).takerLock), 0);
  const asset = assetOf(parts[0].offer);
  const v = verdict(giveUsdc, totalGive, totalGet, asset);
  const give = pt(giveUsdc ? fmtOther(parts[0].offer, totalGive) : `${fmtCkb(totalGive)} CKB`);
  const get = pt(giveUsdc ? `${fmtCkb(totalGet)} CKB` : fmtOther(parts[0].offer, totalGet));
  const inUsd = (u, isOther) => (MKT && usdO(asset) ? `≈ ${usd(isOther ? numO(u, asset) * usdO(asset) : ckbNum(u) * MKT.usdPerCkb)} USD` : "");
  sheet(`<h3 id="m-t">${tr("Confirmar a troca")}</h3>
    <div class="sum"><div class="sumrow"><span class="lbl">${tr("Pagas")}</span><b class="num">${esc(give)}</b><small>${esc(inUsd(totalGive, giveUsdc))}</small></div>
      <div class="sumarrow" aria-hidden="true">↓</div>
      <div class="sumrow"><span class="lbl">${tr("Recebes")}</span><b class="num">${esc(get)}</b><small>${esc(inUsd(totalGet, !giveUsdc))}</small></div></div>
    ${v?.html ?? ""}
    <p class="small">${tr("O teu dinheiro fica num cofre até a outra pessoa pôr a parte dela. Se não puser, volta para ti {when}.", { when: esc(fmtFrom(now() + longest)) })}</p>
    <details class="more"><summary>${tr("Como funciona?")}</summary>
      <p class="small">${asset === "BTC"
        ? tr("O cofre está na blockchain, não com a outra pessoa nem com o livro. Só sai de lá para ela quando tu receberes a tua parte. Com Bitcoin pode demorar até uma hora; podes fechar esta página e voltar depois, neste telemóvel. Não apagues os dados deste site até a troca acabar: é aqui que fica guardada a chave da tua troca.")
        : tr("O cofre está na blockchain, não com a outra pessoa nem com o livro. Só sai de lá para ela quando tu receberes a tua parte. Demora uns minutos; podes fechar esta página e voltar depois, neste telemóvel. Não apagues os dados deste site até a troca acabar: é aqui que fica guardada a chave da tua troca.")}</p>
      ${parts.length > 1 ? `<div class="offers">${parts.map((p, i) => `<div class="offer"><span class="amt num">${i + 1}. ${esc(pt(`${fmtCkbShort(p.ckb)} CKB ⇄ ${fmtOther(p.offer, p.usdc)}`))}</span><span class="px"></span><div class="who">${whoLine(p.offer)}</div></div>`).join("")}</div>` : ""}
    </details>
    <div class="row"><button class="btn btn-primary" id="m-ok" type="button">${tr("Confirmar na carteira")}</button><button class="btn" data-close type="button">${tr("Voltar")}</button></div>`);
  $("#m-ok").onclick = () => { closeSheet(); takePieces(parts); };
}

// ------------------------------------------------------------------ Livro: the book by price level
const BOOKF = { online: false, w1: false, big: false, trusted: false, shown: 8 };
// One pair for the whole page: the one picked last, on Trocar, on Livro or when publishing.
const bookAsset = () => SWAP.asset;
function setPair(asset) {
  if (SWAP.asset === asset) return;
  SWAP.asset = asset; SWAP.amount = ""; SWAP.invert = false; SWAP.giveUsdc = true; SWAP.touched = false;
  renderChip();
}
function bookLevels(sellsCkb) {
  const m = new Map();
  for (const o of OFFERS) {
    if ((o.makerGives === "CKB") !== sellsCkb || assetOf(o) !== bookAsset()) continue;
    if (BOOKF.online && !o.online) continue;
    if (BOOKF.w1 && o.window > 3600) continue;
    if (BOOKF.big && BigInt(o.remainingCkb) < 500_000_000_000n) continue;
    if (BOOKF.trusted && o.stats.done < 10) continue;
    const key = Number(offerPrice(o).toPrecision(3));
    const l = m.get(key) ?? { price: key, ckb: 0n, list: [] };
    l.ckb += BigInt(o.remainingCkb); l.list.push(o); m.set(key, l);
  }
  return [...m.values()].sort((a, b) => (sellsCkb ? a.price - b.price : b.price - a.price));
}
const bookHtml = () => {
  const plabel = bookAsset() === "USDC" ? tr("Preço USDC") : `${UNIT[bookAsset()].name}/CKB`;
  const lhead = `<div class="lhead v2"><span></span><span class="plabel">${plabel}</span><span>${tr("vs mercado")}</span><span>CKB</span></div>`;
  return `<section class="book" id="bookbox">
        <div class="pairs" role="tablist" aria-label="${tr("Par")}">${Object.keys(ASSETS).map((a) => `<button role="tab" type="button" data-bookasset="${a}" aria-selected="${bookAsset() === a}">${a} · CKB</button>`).join("")}</div>
        <div class="bookhead"><h2 id="bookTitle">${tr("Ofertas")}</h2><span class="note" id="bookCount"></span></div>
        <div class="filters row1" role="group" aria-label="${tr("Filtros")}">
          <button class="chip" aria-pressed="${BOOKF.online}" data-f="online" type="button">${tr("Online agora")}</button>
          <button class="chip" aria-pressed="${BOOKF.w1}" data-f="w1" type="button">${tr("Responde em 1 h")}</button>
          <button class="chip" aria-pressed="${BOOKF.big}" data-f="big" type="button">${tr("≥ 5 000 CKB")}</button>
          <button class="chip" aria-pressed="${BOOKF.trusted}" data-f="trusted" type="button">${tr("10+ trocas")}</button>
        </div>
        <p class="legend"><span><i class="lg-on"></i>${tr("online, troca já")}</span><span><i class="lg-off"></i>${tr("offline, pode demorar")}</span></p>
        <div class="side sell"><h3><span>${tr("Vendem CKB")}</span><span id="sellWant">${tr("querem {coin}", { coin: bookAsset() })}</span></h3>${lhead}<div class="levels" id="asks"></div></div>
        <div class="mid num" id="mid"></div>
        <div class="side buy"><h3><span>${tr("Compram CKB")}</span><span id="buyGive">${tr("dão {coin}", { coin: bookAsset() })}</span></h3>${lhead}<div class="levels" id="bids"></div></div>
        <p class="note">${tr("Toca numa linha para levar uma parte.")}</p>
      </section>
      <button class="go wide" id="publish" type="button">${tr("Publicar a minha oferta")}</button>`;
};
function bindBook() {
  document.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => { BOOKF[b.dataset.f] = !BOOKF[b.dataset.f]; b.setAttribute("aria-pressed", String(BOOKF[b.dataset.f])); renderBook(); }));
  $("#publish").addEventListener("click", () => openPublish({ giveUsdc: SWAP.giveUsdc, asset: bookAsset() }));
  document.querySelectorAll("[data-bookasset]").forEach((b) => b.addEventListener("click", () => {
    setPair(b.dataset.bookasset);
    if (WIDE.matches) { $("#view").innerHTML = ""; return viewDuo(); }
    $("#bookbox")?.remove(); viewBook();
  }));
}
function viewBook() {
  if (WIDE.matches) return viewDuo();
  if (!$("#bookbox")) { $("#view").innerHTML = bookHtml(); bindBook(); }
  renderBook();
}
function renderBook() {
  const shapeKey = `book2:${bookAsset()}`;
  if (!LOADED.offers) {
    let last = null;
    try { last = JSON.parse(SHAPE.get(shapeKey) ?? "null"); } catch {}
    const fake = (side) => `<button class="level v2 ${side}" type="button"><span class="fill" style="width:40%"></span><span class="on-dot"></span><span class="p num">0,000000</span><span class="vs num">+0,0%</span><span class="q num">10 000</span></button>`;
    $("#asks").innerHTML = ghost(last?.asks ?? [1, 2, 3].map(() => fake("sell")).join(""));
    $("#bids").innerHTML = ghost(last?.bids ?? [1, 2, 3].map(() => fake("buy")).join(""));
    $("#mid").innerHTML = `<span class="sktext">${esc(last?.mid ?? tr("Mercado {price}", { price: "0,0000000 USDC por CKB" }))}</span>`;
    $("#bookCount").innerHTML = `<span class="sktext">${esc(last?.count ?? tr("{n} neste par", { n: 0 }))}</span>`;
    return;
  }
  const asks = bookLevels(true), bids = bookLevels(false);
  const top = [...asks.slice(0, BOOKF.shown), ...bids.slice(0, BOOKF.shown)];
  const max = top.reduce((m, l) => (l.ckb > m ? l.ckb : m), 1n);
  // The best row someone online will trade now, on each side: the one the swap box takes first.
  const bestOf = (levels) => levels.find((l) => l.list.some((o) => o.online && !isMine(o)));
  const bestAsk = bestOf(asks), bestBid = bestOf(bids);
  const mk = mktO(bookAsset());
  // Until the market answers, the column keeps its waiting shape, so the number fades in.
  const vsOf = (l) => (!LOADED.price ? `<span class="sktext">+0,0%</span>` : mk ? esc(pt(fmtPct(vsMarket(l.price, mk)))) : "");
  const row = (l, side, best) => {
    const on = l.list.some((o) => o.online);
    return `<button class="level v2 ${side}${on ? " isonline" : " isoff"}${best ? " best" : ""}" type="button" data-p="${l.price}" data-s="${side}"><span class="fill" style="width:${Number((l.ckb * 1000n) / max) / 10}%"></span><span class="on-dot" title="${on ? tr("online, troca já") : tr("offline, pode demorar")}"></span><span class="p num">${esc(pt((l.price * UNIT[bookAsset()].mul).toPrecision(3)))}</span><span class="vs num">${vsOf(l)}</span><span class="q num">${esc(fmtCkbShort(l.ckb))}${l.list.length > 1 ? `<small class="x">×${l.list.length}</small>` : ""}</span>${best ? `<span class="besttag">${tr("melhor online")}</span>` : ""}</button>`;
  };
  const asksHtml = asks.length ? asks.slice(0, BOOKF.shown).reverse().map((l) => row(l, "sell", l === bestAsk)).join("") : `<p class="empty">${tr("Ninguém vende CKB agora.")}</p>`;
  const bidsHtml = (bids.length ? bids.slice(0, BOOKF.shown).map((l) => row(l, "buy", l === bestBid)).join("") : `<p class="empty">${tr("Ninguém compra CKB agora.")}</p>`)
    + (asks.length > BOOKF.shown || bids.length > BOOKF.shown ? `<button class="more" type="button" id="more">${tr("Mostrar mais níveis")}</button>` : "");
  const n = [...asks, ...bids].reduce((s, l) => s + l.list.length, 0);
  const count = tr("{n} neste par", { n });
  const mid = !LOADED.price ? null : mktO(bookAsset()) ? tr("Mercado {price}", { price: priceText(mktO(bookAsset()), bookAsset()) }) : tr("Sem preço de mercado agora");
  showIn($("#asks"), asksHtml); showIn($("#bids"), bidsHtml);
  showIn($("#bookCount"), esc(count));
  if (mid !== null) showIn($("#mid"), esc(mid)); // until the market answers, the line keeps its waiting shape
  SHAPE.save(shapeKey, JSON.stringify({ asks: asksHtml, bids: bidsHtml, count, mid: mid ?? undefined }));
  document.querySelectorAll(".level").forEach((b) => b.addEventListener("click", () => {
    const l = (b.dataset.s === "sell" ? asks : bids).find((x) => x.price === Number(b.dataset.p));
    if (l) openLevel(l);
  }));
  $("#more")?.addEventListener("click", () => { BOOKF.shown += 8; renderBook(); });
}
function openLevel(l) {
  const list = [...l.list].sort((a, c) => (c.online - a.online) || (c.stats.done - a.stats.done));
  const price = esc(priceText(l.price, bookAsset()));
  sheet(`<h3 id="m-t">${list.length === 1 ? tr("{n} oferta a {price}", { n: list.length, price }) : tr("{n} ofertas a {price}", { n: list.length, price })}</h3>
    <div class="offers">${list.map((o) => `<div class="offer"><span class="amt num">${o.makerGives === "CKB" ? tr("{amount} CKB à venda", { amount: esc(fmtCkbShort(o.remainingCkb)) }) : tr("{amount} CKB pedidos", { amount: esc(fmtCkbShort(o.remainingCkb)) })}</span><span class="px num">${tr("mín. {amount}", { amount: esc(fmtCkbShort(o.minCkb)) })}</span><div class="who">${whoLine(o)}</div>
      ${isMine(o) ? `<a class="small" href="#offer-${o.id}">${tr("É tua")}</a>` : `<button class="btn btn-small" data-take="${o.id}" type="button">${tr("Levar uma parte")}</button>`}</div>`).join("")}</div>
    <p class="small muted">${tr("Online e com mais trocas primeiro. Na caixa Trocar, a escolha é automática.")}</p>
    <div class="row"><button class="btn" data-close type="button">${tr("Fechar")}</button></div>`);
  document.querySelectorAll("[data-take]").forEach((b) => b.addEventListener("click", () => openTake(list.find((o) => o.id === b.dataset.take))));
}
function openTake(o) {
  const left = BigInt(o.remainingCkb), min = BigInt(o.minCkb) < left ? BigInt(o.minCkb) : left;
  const asset = assetOf(o);
  const price = esc(priceText(offerPrice(o), asset));
  const whole = (x) => (x / 100_000_000n) * 100_000_000n;
  const capUsd = LIMITS ? (asset === "BTC" ? LIMITS.takeUsdBtc : LIMITS.takeUsd) : 0;
  const capCkb = capUsd > 0 && MKT?.usdPerCkb ? BigInt(Math.floor(capUsd / MKT.usdPerCkb)) * 100_000_000n : null;
  const half = whole(left / 2n);
  const presets = [[min, tr("mín.")], ...(half > min && half < left ? [[half, ""]] : []), ...(left > min ? [[left, tr("tudo")]] : [])];
  // It opens on what can be taken: all of it, or as much as the public test lets one swap take.
  const start = capCkb !== null && capCkb < left ? (whole(capCkb) > min ? whole(capCkb) : min) : left;
  sheet(`<h3 id="m-t">${tr("Levar uma parte")}</h3>
    <p class="small">${o.makerGives === "CKB" ? tr("Recebes CKB e dás {coin}, a {price}.", { coin: asset, price }) : tr("Dás CKB e recebes {coin}, a {price}.", { coin: asset, price })}</p>
    <div class="presets" role="group" aria-label="CKB">${presets.map(([v, l]) => `<button type="button" data-v="${v}">${esc(fmtCkbShort(v))}${l ? `<small>${esc(l)}</small>` : ""}</button>`).join("")}</div>
    <label class="field" for="t-ckb" id="t-field">${tr("CKB, entre {min} e {max}", { min: esc(fmtCkbShort(min)), max: esc(fmtCkbShort(left)) })}<input id="t-ckb" inputmode="decimal" value="${esc(fmtCkb(start))}"></label>
    <p class="fieldmsg" id="t-msg" role="status" hidden></p>
    <p class="small num" id="t-sum"></p>
    <div class="row"><button class="btn btn-primary" id="t-ok" type="button">${tr("Continuar")}</button><button class="btn" data-close type="button">${tr("Voltar")}</button></div>`);
  /** What is wrong with the amount typed, said while typing; "" when it can go. */
  const why = (c) => (c === null || c === 0n ? tr("Escreve uma quantia de CKB.")
    : c < min ? tr("O mínimo desta oferta é {min} CKB.", { min: fmtCkbShort(min) })
    : c > left ? tr("Esta oferta só tem {max} CKB.", { max: fmtCkbShort(left) })
    : !pieceOk(o, c) ? tr("A parte tem de ser entre {min} e {max} CKB.", { min: fmtCkb(min), max: fmtCkb(left) })
    : capUsd > 0 && MKT?.usdPerCkb && ckbNum(c) * MKT.usdPerCkb > capUsd * 1.05 ? tr("Acima do limite do teste: {n} $ por troca", { n: capUsd })
    : "");
  const read = () => { try { return parseCkb($("#t-ckb").value || "0"); } catch { return null; } };
  const check = () => {
    const c = read(), msg = why(c);
    $("#t-sum").textContent = c ? pt(`${fmtCkb(c)} CKB ⇄ ${fmtOther(o, fillUsdc(o, c))}`) : "";
    $("#t-msg").textContent = msg; $("#t-msg").hidden = !msg;
    $("#t-field").classList.toggle("under", !!msg);
    $("#t-ok").disabled = !!msg;
  };
  $("#t-ckb").addEventListener("input", check);
  document.querySelectorAll(".presets [data-v]").forEach((b) => b.addEventListener("click", () => { $("#t-ckb").value = fmtCkb(BigInt(b.dataset.v)); check(); }));
  check();
  $("#t-ok").onclick = () => {
    const c = read();
    if (why(c)) return check();
    if (!readyFor(asset)) { closeSheet(); return openWallets(); }
    if (!canGive(o.makerGives === "CKB" ? ASSETS[asset].chain : "ckb")) return fail(new Error(tr("Para dar {coin}, liga a carteira Cellula.", { coin: o.makerGives === "CKB" ? asset : "CKB" })));
    confirmPieces([{ offer: o, ckb: c, usdc: fillUsdc(o, c) }]);
  };
}

// ------------------------------------------------------------------ Publicar
function openPublish({ giveUsdc = true, amount = null, asset = SWAP.asset }) {
  // giveUsdc here is the publisher's side: giving the other coin (USDC or BTC) means buying CKB.
  if (!readyFor(asset)) return openWallets();
  const A = ASSETS[asset];
  const other0 = amount === null ? ({ BTC: "0.0001", ETH: "0.001" }[asset] ?? "5") : giveUsdc ? A.fmt(amount) : null;
  const ckb0 = amount !== null && !giveUsdc ? fmtCkb(amount) : null;
  // The price as typed: USDC per CKB, or sats per CKB; `coin` turns it into the coin per CKB.
  const coin = (typed) => Number(typed) / UNIT[asset].mul;
  const typedOf = (perCkb) => fmtPrice(perCkb * UNIT[asset].mul);
  const wins = windowsFor(asset);
  sheet(`<h3 id="m-t">${tr("Publicar oferta")}</h3>
    <p class="small muted">${tr("Quando alguém aceitar, voltas aqui e confirmas na carteira.")}</p>
    <form id="new" class="form" data-asset="${asset}">
      <div class="pairs" role="tablist" aria-label="${tr("Par")}">${Object.keys(ASSETS).map((a) => `<button role="tab" type="button" data-pubasset="${a}" aria-selected="${asset === a}">${a} · CKB</button>`).join("")}</div>
      <fieldset class="seg"><input type="radio" name="gives" id="g-usdc" value="${asset}" ${giveUsdc ? "checked" : ""}><label for="g-usdc">${tr("Compro CKB")}</label>
        <input type="radio" name="gives" id="g-ckb" value="CKB" ${giveUsdc ? "" : "checked"}><label for="g-ckb">${tr("Vendo CKB")}</label></fieldset>
      <div class="field"><label for="f-price">${tr("Preço por CKB, em {unit}", { unit: UNIT[asset].name })}</label><input id="f-price" type="text" inputmode="decimal" autocomplete="off" required>
        <div class="seg" role="group" aria-label="${tr("Preço face ao mercado")}">${[-2, -1, 0, 1, 2].map((x) => `<button class="chip" type="button" data-pct="${x}">${x === 0 ? tr("Mercado") : (x > 0 ? "+" : "−") + Math.abs(x) + "%"}</button>`).join("")}</div>
        <p id="f-mkt" class="small muted">${marketLine(asset)}</p></div>
      <div class="row2"><label class="field" for="f-usdc">${asset}<input id="f-usdc" type="text" inputmode="decimal" autocomplete="off" value="${esc(other0 ?? "")}"></label>
        <label class="field" for="f-ckb">CKB<input id="f-ckb" type="text" inputmode="decimal" autocomplete="off" value="${esc(ckb0 ?? "")}"></label></div>
      <details class="more" id="f-more"><summary>${tr("Mais opções")}</summary><div class="form">
      <label class="field" for="f-min">${tr("Mínimo por troca, em CKB")}<input id="f-min" type="text" inputmode="decimal" autocomplete="off"></label>
      <p class="small muted">${tr("Cada parte aceite é uma troca à parte.")}</p>
      <div class="win"><span class="lbl" id="f-win-l">${tr("Quanto podes demorar a voltar")}</span>
        <fieldset class="seg" aria-labelledby="f-win-l">${wins.map((w, i) => `<input type="radio" name="win" id="w-${w}" value="${w}" ${i === 0 ? "checked" : ""}><label for="w-${w}">${esc(fmtWindow(w))}</label>`).join("")}</fieldset>
</div>
      </div></details>
      <p id="f-sum" class="small"></p>
      <div class="row"><button class="btn btn-primary" type="submit">${tr("Publicar")}</button><button class="btn" data-close type="button">${tr("Voltar")}</button></div>
    </form>`);
  document.querySelectorAll("[data-pubasset]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.pubasset === asset) return;
    setPair(b.dataset.pubasset);
    if (location.hash === "#book") { $("#bookbox")?.remove(); viewBook(); }
    openPublish({ giveUsdc, asset: b.dataset.pubasset });
  }));
  const f = $("#new");
  let anchor = ckb0 ? "ckb" : "usdc";
  const follow = () => {
    const pr = coin(typed($("#f-price").value));
    if (!(pr > 0)) return;
    try {
      if (anchor === "usdc") $("#f-ckb").value = fmtCkb(ckbForOther(A.parse(typed($("#f-usdc").value) || "0"), pr, asset));
      else $("#f-usdc").value = A.fmt(otherForCkb(parseCkb(typed($("#f-ckb").value) || "0"), pr, asset));
    } catch {}
    if (!$("#f-min").dataset.touched) {
      // A piece is worth at least the coin's minimum (5000 sats for BTC), with a CKB of room for rounding.
      const lo = (() => { const fl = ckbForOther(A.parse(A.min), pr, asset) + 100_000_000n; return fl > MIN_CKB ? fl : MIN_CKB; })();
      // An input keeps digits only: the group separators of any language go (12 500, 12,500).
      try { const c = parseCkb($("#f-ckb").value || "0"); const m = c / 4n > lo ? c / 4n : lo; $("#f-min").value = fmtCkbShort(m > c ? c : m).replace(/[\s.,]/g, ""); } catch {}
    }
  };
  const sum = () => {
    const g = f.gives.value, c = $("#f-ckb").value, u = $("#f-usdc").value, pr = coin(typed($("#f-price").value));
    const v = { ckb: c, other: u, coin: asset };
    if (mktO(asset) && pr > 0) v.pct = fmtPct(vsMarket(pr, mktO(asset)));
    $("#f-sum").textContent = pt(g === "CKB"
      ? (v.pct ? tr("Dás {ckb} CKB e recebes {other} {coin}, {pct} em relação ao preço de mercado.", v) : tr("Dás {ckb} CKB e recebes {other} {coin}.", v))
      : (v.pct ? tr("Dás {other} {coin} e recebes {ckb} CKB, {pct} em relação ao preço de mercado.", v) : tr("Dás {other} {coin} e recebes {ckb} CKB.", v)));
  };
  f.addEventListener("input", (ev) => {
    if (ev.target.id === "f-usdc") anchor = "usdc";
    if (ev.target.id === "f-ckb") anchor = "ckb";
    if (ev.target.id === "f-min") { ev.target.dataset.touched = "1"; return sum(); }
    if (ev.target.id !== (anchor === "usdc" ? "f-ckb" : "f-usdc")) follow();
    sum();
  });
  f.querySelectorAll("[data-pct]").forEach((b) => b.addEventListener("click", () => {
    if (!mktO(asset)) return;
    $("#f-price").value = typedOf(mktO(asset) * (1 + Number(b.dataset.pct) / 100));
    follow(); sum();
  }));
  if (mktO(asset)) $("#f-price").value = typedOf(mktO(asset));
  follow(); sum();
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const g = f.gives.value;
      const c = typed($("#f-ckb").value), u = typed($("#f-usdc").value), m = $("#f-min").value.replace(/\s/g, "").replace(",", ".");
      parseCkb(c); A.parse(u); parseCkb(m);
      if (!canGive(g === "CKB" ? "ckb" : A.chain)) throw new Error(tr("Para dar {coin}, liga a carteira Cellula.", { coin: g === "CKB" ? "CKB" : asset }));
      const win = Number(f.win.value);
      const r = await api("POST", "/api/offers", { asset, makerGives: g, ckb: c, [amountKey(asset)]: u, minCkb: m, window: win, maker: meFor(asset) });
      store.set(r.offer.id, { role: "maker", kind: "offer", token: r.token, at: now() });
      closeSheet();
      sayAfterRoute(() => note(tr("Oferta publicada. Podes fechar a página: quando alguém aceitar, tens {w} para voltar e confirmar a tua parte.", { w: fmtWindow(win) })));
      location.hash = `offer-${r.offer.id}`;
    } catch (e) { fail(e); }
  });
}

// ------------------------------------------------------------------ As minhas
function viewMine() {
  if (!LOADED.mine && myRecords().length) {
    const last = SHAPE.get("mine");
    $("#view").innerHTML = last ? ghost(last) : ghost(`<section class="card"><h2>${tr("Em curso")}</h2><div class="offers">${myRecords().slice(0, 4).map(() => `<a class="offer link"><span class="amt num">10 000 CKB → 10 USDC</span><span class="chip">${tr("a concluir")}</span><div class="who"><span>${tr("aceitaste uma oferta")}</span></div></a>`).join("")}</div></section>
      <section class="card"><h2>${tr("As tuas ofertas")}</h2><p class="empty">${tr("Não tens ofertas. Publica uma no Livro.")}</p></section>`);
    return;
  }
  const fills = [
    ...MY.fills.map((f) => ({ f, role: "taker", give: gives(f, "taker"), get: gives(f, "maker") })),
    ...MY.offers.flatMap((o) => o.fills.filter((f) => f.status !== "abandoned").map((f) => ({ f, role: "maker", give: gives(f, "maker"), get: gives(f, "taker") }))),
  ].sort((a, b) => (b.f.createdAt ?? 0) - (a.f.createdAt ?? 0));
  const offs = [...MY.offers].sort((a, b) => b.createdAt - a.createdAt);
  const moving = fills.filter(({ f }) => !["done", "refunded", "abandoned"].includes(f.status));
  const ended = fills.filter(({ f }) => ["done", "refunded"].includes(f.status));
  const stepOf = (st) => (st === "done" ? 3 : st === "taken" ? 1 : st === "taker-locked" ? 2 : 3);
  const item = ({ f, role, give, get }, live) => `<a class="offer link" href="#fill-${f.id}">
        <span class="amt num">${esc(give)} → ${esc(get)}</span><span class="chip ${chipOf(f.status)}">${esc(STATUS[f.status] ?? f.status)}</span>
        ${live ? `<span class="minibar" aria-hidden="true">${[1, 2, 3].map((k) => `<i class="${k < stepOf(f.status) ? "on" : k === stepOf(f.status) ? "now" : ""}"></i>`).join("")}</span>` : ""}
        <div class="who"><span>${role === "taker" ? tr("aceitaste uma oferta") : tr("da tua oferta")}</span>${f.createdAt ? `<span>${esc(ago(f.createdAt))}</span>` : ""}</div></a>`;
  const mineHtml = `
    ${moving.length ? `<section class="card"><h2>${tr("Em curso")}</h2><div class="offers">${moving.map((x) => item(x, true)).join("")}</div></section>` : ""}
    <section class="card"><h2>${moving.length ? tr("Concluídas") : tr("As tuas trocas")}</h2>${ended.length ? `<div class="offers">${ended.map((x) => item(x, false)).join("")}</div>` : `<p class="empty">${moving.length ? tr("Ainda nenhuma concluída.") : tr("Ainda não trocaste nada. Começa em Trocar.")}</p>`}</section>
    <section class="card"><h2>${tr("As tuas ofertas")}</h2>${offs.length ? `<div class="offers">${offs.map((o) => `<a class="offer link" href="#offer-${o.id}">
        <span class="amt num">${o.makerGives === "CKB" ? tr("Vendes {amount} CKB", { amount: esc(pt(fmtCkbShort(o.ckbAmount))) }) : tr("Compras {amount} CKB", { amount: esc(pt(fmtCkbShort(o.ckbAmount))) })}</span><span class="chip ${o.status === "open" ? "chip-wait" : "chip-no"}">${esc(STATUS[o.status] ?? o.status)}</span>
        <div class="who"><span class="num">${esc(priceText(offerPrice(o), assetOf(o)))}</span><span>${tr("{amount} CKB por levar", { amount: esc(pt(fmtCkbShort(o.remainingCkb))) })}</span><span>${tr("{n} partes trocadas", { n: o.fills.filter((f) => f.status === "done").length })}</span></div></a>`).join("")}</div>` : `<p class="empty">${tr("Não tens ofertas. Publica uma no Livro.")}</p>`}</section>`;
  if ($("#view").dataset.v !== mineHtml) { $("#view").dataset.v = mineHtml; showIn($("#view"), mineHtml); }
  SHAPE.save("mine", mineHtml);
}

async function viewOffer(id) {
  const run = ROUTE;
  let o;
  try { o = await api("GET", `/api/offers/${id}`); } catch { if (run === ROUTE) $("#view").innerHTML = `<div class="card"><p>${tr("Oferta não encontrada.")}</p><a href="#book">${tr("Voltar ao livro")}</a></div>`; return; }
  await PRICE_READY;
  if (run !== ROUTE) return;
  const mine = store.get(id)?.role === "maker" || isMine(o);
  const fills = [...o.fills].reverse();
  const amount = esc(fmtCkbShort(o.ckbAmount));
  const title = mine ? (o.makerGives === "CKB" ? tr("Vendes {amount} CKB", { amount }) : tr("Compras {amount} CKB", { amount }))
    : o.makerGives === "CKB" ? tr("Quem publicou vende {amount} CKB", { amount }) : tr("Quem publicou compra {amount} CKB", { amount });
  const offerHtml = `<p>${mine ? `<a class="back" href="#mine">${tr("← As minhas")}</a>` : `<a class="back" href="#book">${tr("← Livro")}</a>`}</p>
    <section class="card"><div class="row spread"><h2>${title}</h2><span class="chip ${o.status === "open" ? "chip-wait" : "chip-no"}">${esc(STATUS[o.status] ?? o.status)}</span></div>
      <dl class="kv"><dt>${tr("Preço")}</dt><dd class="num">${esc(priceText(offerPrice(o), assetOf(o)))}${mktO(assetOf(o)) ? ` · ${tr("{pct} face ao mercado", { pct: esc(fmtPct(vsMarket(offerPrice(o), mktO(assetOf(o))))) })}` : ""}</dd>
        <dt>${tr("Total")}</dt><dd class="num">${esc(pt(`${fmtCkb(o.ckbAmount)} CKB ⇄ ${fmtOther(o, o.usdcAmount)}`))}</dd>
        <dt>${tr("Por levar")}</dt><dd class="num">${esc(fmtCkb(o.remainingCkb))} CKB</dd>
        <dt>${tr("Parte mínima")}</dt><dd class="num">${esc(fmtCkb(o.minCkb))} CKB</dd>
        <dt>${mine ? tr("Voltas em até") : tr("Responde em até")}</dt><dd>${esc(fmtWindow(o.window))}</dd>
        <dt>${mine ? tr("O teu historial") : tr("Historial")}</dt><dd>${esc(record(o))}</dd></dl>
      ${mine && o.status === "open" ? `<div class="row"><button class="btn btn-small" id="stop" type="button">${tr("Parar a oferta")}</button><span class="small muted">${tr("As partes já levadas continuam.")}</span></div>` : ""}
    </section>
    <section class="card"><h2>${tr("Partes")}</h2>${fills.length ? `<div class="offers">${fills.map((f) => `<a class="offer link" href="#fill-${f.id}"><span class="amt num">${esc(pt(`${fmtCkbShort(f.ckbAmount)} CKB ⇄ ${fmtOther(f, f.usdcAmount)}`))}</span><span class="chip ${chipOf(f.status)}">${esc(STATUS[f.status] ?? f.status)}</span>
      ${mine && f.status === "taker-locked" ? `<div class="who"><span>${tr("<strong>É a tua vez</strong>: confirma a tua parte até {when}", { when: esc(fmtAt(makerDeadline(f.takerLock.timeoutSec, timingsFor(f.window, assetOf(f))))) })}</span></div>` : ""}</a>`).join("")}</div>` : `<p class="empty">${tr("Ainda ninguém levou nenhuma parte.")}</p>`}</section>`;
  showIn($("#view"), offerHtml);
  SHAPE.save("offer", offerHtml);
  $("#stop")?.addEventListener("click", async () => { try { await api("POST", `/api/offers/${id}/cancel`, { token: store.get(id)?.token }); route(); } catch (e) { fail(e); } });
}

// ------------------------------------------------------------------ one fill, step by step
const FILL_SEEN = new Map();
async function viewFill(id) {
  const run = ROUTE;
  let f;
  try { f = await api("GET", `/api/fills/${id}`); } catch { if (run === ROUTE) $("#view").innerHTML = `<div class="card"><p>${tr("Troca não encontrada.")}</p><a href="#mine">${tr("Voltar")}</a></div>`; return; }
  if (run !== ROUTE) return;
  const rec = store.get(id);
  const role = rec?.role === "taker" ? "taker" : rec?.role === "maker" || store.get(f.offerId)?.role === "maker" ? "maker" : null;
  const { takerChain, makerChain } = legs(f);
  const chainName = (c) => (c === "evm" ? NET.evmName : c === "btc" ? "Bitcoin" : "CKB");
  const selfHtml = role ? await selfService(f, role).catch(() => "") : "";
  if (run !== ROUTE) return;
  const order = ["taken", "taker-locked", "maker-locked", "revealed", "done"];
  const at = order.indexOf(f.status);
  const refundPath = ["refunding", "refunded"].includes(f.status);
  const ended = ["done", "refunded"].includes(f.status);
  // A lock's way back, while the swap runs: in how long, or that its time has come.
  const backTaker = (sec) => (sec > 0 ? tr("volta para quem aceitou daqui a {left}, se ninguém levantar", { left: fmtLeft(sec) }) : tr("volta para quem aceitou daqui a já passou, se ninguém levantar"));
  const backMaker = (sec) => (sec > 0 ? tr("volta para quem publicou daqui a {left}, se ninguém levantar", { left: fmtLeft(sec) }) : tr("volta para quem publicou daqui a já passou, se ninguém levantar"));
  const steps = [
    [tr("Parte reservada"), pt(`${fmtCkb(f.ckbAmount)} CKB ⇄ ${fmtOther(f, f.usdcAmount)}`)],
    [tr("Quem aceitou trancou {amount} na {chain}", { amount: gives(f, "taker"), chain: chainName(takerChain) }), f.takerLock && !ended ? backTaker(f.takerLock.timeoutSec - now()) : ""],
    [tr("Quem publicou trancou {amount} na {chain}", { amount: gives(f, "maker"), chain: chainName(makerChain) }), f.makerLock && !ended ? backMaker(f.makerLock.timeoutSec - now()) : ""],
    [tr("Segredo revelado: {amount} para quem aceitou", { amount: gives(f, "maker") }), ""],
    [tr("{amount} para quem publicou", { amount: gives(f, "taker") }), tr("o livro usa o segredo, que já é público")],
  ];
  // Where it is, said once and plainly, above the details: step, what happens now, and whether the
  // person has anything to do.
  const n = Math.max(0, Math.min(3, f.status === "done" ? 3 : at === 0 ? 1 : at === 1 ? 2 : at >= 2 ? 3 : 0));
  const deadline = f.takerLock ? fmtFrom(f.takerLock.timeoutSec) : "";
  let hero = "", vaults = "", receipt = "";
  if (role === "taker" && !refundPath && f.status !== "abandoned") {
    const inWallet = makerChain === "evm" ? tr("Já está na tua carteira, na Base.") : makerChain === "btc" ? tr("Já está na tua carteira, no Bitcoin.") : tr("Já está na tua carteira, na CKB.");
    const [big, sub] = f.status === "done" ? [tr("Troca concluída. Recebeste {amount}.", { amount: gives(f, "maker") }), inWallet]
      : f.status === "taken" ? [tr("O teu dinheiro vai para o cofre da troca."), tr("Confirma na carteira, se ainda não o fizeste.")]
      : f.status === "taker-locked" ? [tr("À espera de que a outra pessoa ponha a parte dela."), ""]
      : [tr("A entregar-te {amount}.", { amount: gives(f, "maker") }), (W.evm && (W.bal?.eth ?? 0n) >= MIN_GAS && makerChain === "evm") || (makerChain === "btc" && !store.get(id)?.claimed) ? tr("Confirma na carteira quando ela pedir.") : tr("Não precisas de fazer nada.")];
    const blocks = [1, 2, 3].map((k) => `<i class="${f.status === "done" || k < n ? "on" : k === n ? "now" : ""}"></i>`).join("");
    // Pixels burst once, when this page sees the swap become done.
    const justDone = f.status === "done" && FILL_SEEN.has(id) && FILL_SEEN.get(id) !== "done";
    if (justDone) navigator.vibrate?.([30, 60, 30]);
    const burst = justDone
      ? `<div class="burst" aria-hidden="true">${Array.from({ length: 16 }, (_, k) => { const a = (k / 16) * 2 * Math.PI, r = 70 + (k % 3) * 22; return `<i style="--x:${Math.round(Math.cos(a) * r)}px;--y:${Math.round(Math.sin(a) * r)}px"></i>`; }).join("")}</div>` : "";
    // A clock from the moment the swap began, so a wait is seen to move.
    const clock = f.status === "done" ? "" : `<div class="clock"><span class="el num" data-since="${Number(f.takenAt)}">${fmtClock(now() - f.takenAt)}</span><span class="us">${tr("desde que começaste")} · ${assetOf(f) === "BTC" ? tr("costuma demorar até uma hora") : tr("costuma demorar uns minutos")}</span></div>`;
    hero = `<div class="hero${f.status === "done" ? " ok" : ""}"><div class="bar" aria-hidden="true">${blocks}</div>${burst}
      ${f.status === "done" ? "" : `<p class="stepn">${tr("Passo {n} de 3", { n })}</p>`}<p class="big"><strong>${esc(big)}</strong></p>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}${clock}</div>`;
    const lockedAt = (leg) => f.log.find((l) => leg?.tx && l.tx === leg.tx)?.at;
    const hhmm = (sec) => new Date(sec * 1000).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
    const vault = (who, amount, chain, st, text) => `<div class="vault v-${st}"><span class="who">${who}</span><span class="amt num">${esc(amount)}</span><span class="net">${netOf(chain)}</span><span class="st">${st === "waiting" ? `<i class="pulse" aria-hidden="true"></i>` : st === "locked" ? ICON.lock : "✓"}<span>${esc(text)}</span></span></div>`;
    const lockText = (leg) => (lockedAt(leg) ? tr("trancado {t}", { t: hhmm(lockedAt(leg)) }) : tr("trancado"));
    if (f.status !== "done") {
      const mine = f.takerLock ? vault(tr("O teu cofre"), gives(f, "taker"), takerChain, "locked", lockText(f.takerLock)) : vault(tr("O teu cofre"), gives(f, "taker"), takerChain, "waiting", tr("à espera"));
      const theirs = f.status === "revealed" ? vault(tr("Cofre da outra pessoa"), gives(f, "maker"), makerChain, "claimed", tr("a chegar a ti"))
        : f.makerLock ? vault(tr("Cofre da outra pessoa"), gives(f, "maker"), makerChain, "locked", lockText(f.makerLock))
        : vault(tr("Cofre da outra pessoa"), gives(f, "maker"), makerChain, "waiting", tr("à espera"));
      vaults = `<div class="vaults">${mine}${theirs}</div>
        ${f.status === "revealed" ? "" : `<p class="secretline">${ICON.key}<span>${tr("Os dois cofres abrem com o mesmo segredo, e ele está só neste navegador.")}</span></p>`}
        ${f.takerLock && ["taker-locked", "maker-locked"].includes(f.status) ? `<p class="safe">${tr("Se ela não aparecer, os teus {amount} voltam para ti {when}. Não precisas de fazer nada.", { amount: esc(gives(f, "taker")), when: esc(deadline) })}</p>` : ""}`;
    } else {
      const doneAt = f.log.at(-1)?.at ?? now();
      // One link per transaction: the book's log can name the same one twice (the claim, then its outcome).
      const seen = new Set();
      const proofs = f.log.filter((l) => l.tx && !seen.has(l.tx) && seen.add(l.tx)).map((l) => `<a href="${explorerOf(l.chain)}${esc(l.tx)}" target="_blank" rel="noopener"><b>${l.chain === "evm" ? "Base" : l.chain === "btc" ? "BTC" : "CKB"}</b><code>${esc(short(l.tx, 4))}</code> ↗</a>`).join("");
      receipt = `<div class="receipt">
          <div class="dr"><span>${tr("Deste")}</span><span class="big num">${esc(gives(f, "taker"))}</span></div>
          <div class="dr"><span>${tr("Recebeste")}</span><span class="big num">${esc(gives(f, "maker"))}</span></div>
          <div class="dr"><span>${tr("Feita em")}</span><span class="big num">${esc(fmtTook(doneAt - f.takenAt))}</span></div>
          <div class="dr"><span>${tr("Preço")}</span><span class="num">${esc(priceText(offerPrice(f), assetOf(f)))}</span></div>
          ${proofs ? `<div class="dr"><span>${tr("Na blockchain")}</span><span class="proofs">${proofs}</span></div>` : ""}
        </div>
        <a class="go wide" href="#swap" id="again">${tr("Fazer outra troca")}</a>`;
    }
  }
  // A note from a step that has passed (sent, confirming, "the book delivers") goes when the swap
  // moves on; an error stays.
  if (FILL_SEEN.get(id) !== f.status) { if (FILL_SEEN.has(id) && !$("#notice").classList.contains("err")) note(""); FILL_SEEN.set(id, f.status); }
  const stepHtml = steps.map(([t, s], i) => {
    const st = f.status === "done" || i < at ? "done" : i === at && !refundPath ? "now" : "pending";
    return `<li class="step ${st}"><span class="dot">${st === "done" ? "✓" : i + 1}</span><div><div class="t">${esc(t)}</div>${s ? `<div class="s">${esc(s)}</div>` : ""}</div></li>`;
  }).join("");
  const isMaker = role === "maker", isTaker = role === "taker";
  let action = "";
  if (f.status === "done") action = isMaker ? `<div class="action ok"><p>${tr("<strong>Troca concluída.</strong> Recebeste {amount}.", { amount: esc(gives(f, "taker")) })}</p></div>` : !role ? `<div class="action ok"><p><strong>${tr("Troca concluída.")}</strong></p></div>` : "";
  else if (refundPath) action = `<div class="action"><p>${f.status === "refunded"
    ? tr("<strong>Devolvido.</strong> A troca não chegou ao fim a tempo, por isso cada um recebe de volta o que pôs no cofre, quando o seu prazo passar. O livro devolve-o sozinho.")
    : tr("<strong>A devolver.</strong> A troca não chegou ao fim a tempo, por isso cada um recebe de volta o que pôs no cofre, quando o seu prazo passar. O livro devolve-o sozinho, e esta página também, se estiver aberta.")}</p></div>`;
  else if (f.status === "abandoned") action = `<div class="action"><p>${tr("Esta troca não chegou a começar. Nada saiu de nenhuma carteira.")}</p></div>`;
  else if (isMaker && f.status === "taken") action = `<div class="action"><p>${tr("Alguém aceitou esta parte e está a pôr a parte dele no cofre. A seguir é a tua vez.")}</p></div>`;
  else if (isMaker && f.status === "taker-locked") action = `<div class="action"><p>${tr("<strong>É a tua vez.</strong> Quem aceitou pôs {taker} no cofre. Esta página verifica isso e depois pede-te para pores os teus {maker}. Tens até {when}.",
      { taker: esc(gives(f, "taker")), maker: esc(gives(f, "maker")), when: esc(fmtAt(makerDeadline(f.takerLock.timeoutSec, timingsFor(f.window, assetOf(f))))) })}</p>
    ${canGive(makerChain) ? `<div class="row"><button class="btn btn-secret" id="do-lock" type="button" ${busy ? "disabled" : ""}>${tr("Verificar e confirmar")}</button></div>` : `<p class="small">${tr("Liga a carteira com que publicaste.")}</p>`}</div>`;
  else if (isMaker && ["maker-locked", "revealed"].includes(f.status)) action = `<div class="action"><p>${tr("A tua parte está no cofre. Quando quem aceitou receber a dele, recebes {amount}: o livro trata disso, e esta página também, se estiver aberta.", { amount: esc(gives(f, "taker")) })}</p></div>`;
  else if (isTaker && f.status === "taken") action = `<div class="action"><p>${tr("O livro ainda não viu o teu envio. Se já confirmaste na carteira, este botão só volta a avisar o livro; não envia outra vez.")}</p>${W.evmAddr || W.ckbAddr ? `<div class="row"><button class="btn btn-secret" id="do-retry" type="button" ${busy ? "disabled" : ""}>${tr("Continuar")}</button></div>` : ""}</div>`;
  else if (isTaker && f.status === "maker-locked") action = `<div class="row"><button class="btn btn-secret" id="do-reveal" type="button" ${busy ? "disabled" : ""}>${tr("Receber agora")}</button></div>`;
  else if (!role) action = `<div class="action"><p>${tr("Estás a ver a troca de outras pessoas.")}</p></div>`;
  const mineGive = isMaker ? gives(f, "maker") : gives(f, "taker"), mineGet = isMaker ? gives(f, "taker") : gives(f, "maker");
  const fillHtml = `<p>${role ? `<a class="back" href="#mine">${tr("← As minhas")}</a>` : `<a class="back" href="#book">${tr("← Livro")}</a>`}</p>
    <section class="card"><div class="row spread"><h2 class="num">${role ? `${esc(mineGive)} → ${esc(mineGet)}` : `${esc(gives(f, "maker"))} ⇄ ${esc(gives(f, "taker"))}`}</h2><span class="chip ${chipOf(f.status)}">${esc(STATUS[f.status] ?? f.status)}</span></div>
      ${hero}
      ${vaults}
      ${action}
      ${receipt}
      ${selfHtml}
      <details class="more"><summary>${tr("Detalhes da troca")}</summary>
        <dl class="kv"><dt>${tr("Preço")}</dt><dd class="num">${esc(priceText(offerPrice(f), assetOf(f)))}</dd><dt>${tr("Tu")}</dt><dd>${isMaker ? tr("publicaste a oferta") : isTaker ? tr("aceitaste uma oferta") : tr("não participas")}</dd>
          <dt>${tr("Quem publicou")}</dt><dd><code>${esc(short(f.maker.evm, 6))}</code> · <code>${esc(short(f.maker.ckbAddress, 8))}</code></dd>
          <dt>${tr("Quem aceitou")}</dt><dd><code>${esc(short(f.taker.evm, 6))}</code> · <code>${esc(short(f.taker.ckbAddress, 8))}</code></dd>
          <dt>${tr("Oferta")}</dt><dd><a href="#offer-${esc(f.offerId)}">${esc(f.offerId)}</a></dd></dl>
        <ol class="steps">${stepHtml}</ol>
        <details><summary>${tr("Registo e transacções")}</summary><ul class="log">${f.log.map((l) => `<li><span class="muted">${new Date(l.at * 1000).toLocaleTimeString(LOCALE)}</span> ${esc(l.text)}${txLink(l)}</li>`).join("")}</ul></details>
      </details>
    </section>`;
  showIn($("#view"), fillHtml);
  SHAPE.save("fill", fillHtml);
  $("#do-lock")?.addEventListener("click", () => makerLock(f));
  $("#do-reveal")?.addEventListener("click", () => reveal(f));
  $("#do-retry")?.addEventListener("click", () => retryTakerLock(f));
  document.querySelectorAll("[data-self]").forEach((b) => b.addEventListener("click", () => window.__self?.[Number(b.dataset.self)]?.run()));
  if (isTaker && f.status === "maker-locked" && readyFor(assetOf(f)) && !busy && document.visibilityState === "visible") reveal(f);
}

// ------------------------------------------------------------------ sheet, tabs, routing and polling
function sheet(html) {
  const m = $("#modal");
  m.innerHTML = `<div class="card" role="dialog" aria-modal="true" aria-labelledby="m-t">${html}</div>`;
  m.hidden = false;
  m.querySelector("button, input")?.focus();
}
function closeSheet() { $("#modal").hidden = true; }
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal" || e.target.closest("[data-close]")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

function setTabs(h) {
  showConnect();
  const tab = h.startsWith("fill-") || h.startsWith("offer-") || h === "mine" ? "mine" : h === "book" ? "book" : "swap";
  document.documentElement.dataset.tab = tab;
  document.querySelectorAll(".tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.tab === tab ? "page" : "false"));
  const n = myTurn().length;
  $("#tab-mine span").textContent = $("#deskMine").textContent = n ? tr("As minhas ({n})", { n }) : tr("As minhas");
}
let SHOWN = "";
// Each route has a number: one that finishes loading after a newer one began draws nothing, so a
// slow answer never paints an old page over the one the person opened.
let ROUTE = 0;
/** The page being opened, as a key: a new key draws its shape at once and comes in. */
const viewKey = (h) => (h.startsWith("fill-") || h.startsWith("swap-") ? `fill:${h.slice(5)}` : h.startsWith("offer-") ? `offer:${h.slice(6)}` : h === "book" && !WIDE.matches ? "book" : h === "mine" ? "mine" : "swap");
function shapeOf(key) {
  if (key === "swap") return viewSwap();
  if (key === "book") return viewBook();
  if (key === "mine") return viewMine();
  const last = SHAPE.get(location.hash.startsWith("#offer-") ? "offer" : "fill");
  $("#view").innerHTML = last ? ghost(last) : `<p><a class="back" href="#mine">${tr("← As minhas")}</a></p><section class="card"><div class="row spread">${SK("big")}${SK()}</div>${SK("block")}${SK("line")}${SK("line")}</section>`;
}
async function route() {
  if (busy) return;
  const run = ++ROUTE;
  const h = location.hash.slice(1);
  const key = viewKey(h);
  if (key !== SHOWN) {
    SHOWN = key;
    setTabs(h);
    shapeOf(key);
    const v = $("#view"); v.classList.remove("pagein"); void v.offsetWidth; v.classList.add("pagein");
  }
  await refreshData();
  if (run !== ROUTE) return;
  setTabs(h);
  drawBanner();
  if (h.startsWith("fill-")) return viewFill(h.slice(5));
  if (h.startsWith("offer-")) return viewOffer(h.slice(6));
  if (h.startsWith("swap-")) return viewFill(h.slice(5)); // links from before fills
  if (h === "book") return viewBook();
  if (h === "mine") return viewMine();
  return viewSwap();
}
window.addEventListener("hashchange", () => { note(""); for (const id of ["swapbox", "bookbox"]) document.getElementById(id)?.remove(); route(); });
$("#connect").addEventListener("click", openWallets);
// Crossing the computer's width redraws Trocar and Livro in the other layout at once, from the data the
// page has (a blank view while the book answered showed for a moment, e.g. turning a tablet).
WIDE.addEventListener("change", () => {
  setTabs(location.hash.slice(1));
  if (document.documentElement.dataset.tab === "mine") return;
  for (const id of ["swapbox", "bookbox"]) document.getElementById(id)?.remove();
  SHOWN = ""; route();
});

/** index.html's own words, written there in Portuguese, in the page's language (a test checks each is there). */
function translateShell() {
  document.title = tr("Livro de swaps CKB ↔ USDC, ETH e BTC");
  document.querySelector('meta[name="description"]')?.setAttribute("content", tr("Troca CKB por USDC, ETH ou Bitcoin com outras pessoas, sem intermediário, na testnet. O dinheiro de cada lado fica num cofre até a troca acontecer, ou volta."));
  $(".brand .bn").firstChild.textContent = tr("Livro de swaps");
  $("#connect").textContent = tr("Ligar carteira");
  $(".tabs").setAttribute("aria-label", tr("Secções"));
  $('.tabs [data-tab="swap"] span').textContent = tr("Trocar");
  $('.tabs [data-tab="book"] span').textContent = tr("Livro");
  $('.tabs [data-tab="mine"] span').textContent = tr("As minhas");
  $("#foot-about").textContent = tr("Versão de teste: as moedas não valem dinheiro.");
  $("#deskMine").textContent = tr("As minhas");
  $("#foot-by").innerHTML = tr('Livro de swaps, by <a href="https://lusocryptolabs.com">LusoCryptoLabs</a>.');
  $("#langs").setAttribute("aria-label", tr("Língua"));
  document.querySelectorAll("#langs [data-lang]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.lang === LANG));
    b.addEventListener("click", () => { if (b.dataset.lang !== LANG) setLang(b.dataset.lang); });
  });
}

(async () => {
  translateShell();
  // What this browser connected last decides the header's first state (see restore()).
  W.likely = pref.get().ckb === "cellula";
  renderWallet();
  $("#connect").classList.remove("unset");
  if (!REDUCED) $("#connect").classList.add("wfade");
  // The page's shape at once, before the book or the market answer; the footer under it.
  SHOWN = viewKey(location.hash.slice(1)); setTabs(location.hash.slice(1)); shapeOf(SHOWN); renderTicker();
  if (!REDUCED) $("#view").classList.add("wfade"); // the first screen fades in from nothing, opacity only
  $(".foot").classList.remove("later");
  if (!REDUCED) $(".foot").classList.add("wfade");
  const restored = restore();
  const config = api("GET", "/api/config").then((cfg) => { setTimings({ ...cfg.timings, maxFee: undefined }); setWindows(cfg.windows); LIMITS = cfg.limits ?? null; }).catch(() => {});
  await Promise.all([loadPrice(), config.then(route), restored]);
  setInterval(() => { if (document.visibilityState === "visible") loadPrice(); }, 60000);
  setInterval(() => { if (document.visibilityState === "visible" && $("#modal").hidden) route(); }, 6000);
  setInterval(() => { if ((W.evmAddr || W.ckbAddr) && document.visibilityState === "visible") renderWallet(); }, 30000);
  setInterval(() => { for (const e of document.querySelectorAll("[data-since]")) if (!e.closest(".ghost")) e.textContent = fmtClock(now() - Number(e.dataset.since)); }, 1000);
})();
