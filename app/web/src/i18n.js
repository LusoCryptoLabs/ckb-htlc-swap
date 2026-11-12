// The page's language. The Portuguese text in main.js is the source and the key: tr() returns it
// as is in Portuguese, or its English or Chinese entry from i18n-dict.js. A change of language
// reloads the page, so everything reads LANG once.
import { EN, ZH } from "./i18n-dict.js";

const LANGS = ["pt", "en", "zh"];

function pick() {
  try { const l = localStorage.getItem("book:lang"); if (LANGS.includes(l)) return l; } catch {}
  for (const x of navigator.languages ?? [navigator.language]) {
    const l = String(x ?? "").slice(0, 2).toLowerCase();
    if (LANGS.includes(l)) return l;
  }
  return "en";
}

export const LANG = pick();
export const LOCALE = { pt: "pt-PT", en: "en-US", zh: "zh-CN" }[LANG];
const DICT = { en: EN, zh: ZH }[LANG] ?? null;

/** `s` in this page's language; `{name}` takes vars.name. Values go in as given: escape them first. */
export function tr(s, vars) {
  const t = DICT && Object.hasOwn(DICT, s) ? DICT[s] : s;
  return vars ? t.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : t;
}

export function setLang(l) {
  if (!LANGS.includes(l)) return;
  try { localStorage.setItem("book:lang", l); } catch {}
  location.reload();
}

document.documentElement.lang = { pt: "pt", en: "en", zh: "zh-CN" }[LANG];
