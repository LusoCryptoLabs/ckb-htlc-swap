// The page's words in three languages. The Portuguese in main.js is the source and the key of
// tr(); these tests read main.js as text and check the dictionaries against it. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EN, ZH } from "../web/src/i18n-dict.js";

const SRC = readFileSync(new URL("../web/src/main.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

/**
 * `src` with its comments turned into spaces, newlines kept so line numbers hold. Strings,
 * template literals (nested ones too) and regular expressions are copied as they are, so a
 * "//" in a URL or a quote in a regex does not fool it.
 */
export function stripComments(src) {
  let out = "", i = 0;
  const keyword = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|else|delete|throw|new|yield|await)$/;
  function code(inside) {
    let depth = 0, last = "";
    while (i < src.length) {
      const c = src[i], d = src[i + 1];
      if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
      if (c === "/" && d === "*") {
        const e = src.indexOf("*/", i + 2), end = e < 0 ? src.length : e + 2;
        out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; continue;
      }
      if (c === '"' || c === "'") {
        const s = i++;
        while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
        out += src.slice(s, ++i); last = c; continue;
      }
      if (c === "`") { out += c; i++; template(); last = c; continue; }
      if (c === "/" && (/^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || keyword.test(out.trimEnd()))) {
        const s = i++;
        let cls = false;
        while (i < src.length && src[i] !== "\n") {
          const x = src[i];
          if (x === "\\") { i += 2; continue; }
          if (x === "[") cls = true; else if (x === "]") cls = false; else if (x === "/" && !cls) break;
          i++;
        }
        i++;
        while (/[a-z]/i.test(src[i] ?? "")) i++;
        out += src.slice(s, i); last = ")"; continue;
      }
      if (inside) { if (c === "{") depth++; else if (c === "}") { if (depth === 0) return; depth--; } }
      out += c; i++;
      if (!/\s/.test(c)) last = c;
    }
  }
  function template() {
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { out += c; i++; return; }
      if (c === "$" && src[i + 1] === "{") { out += "${"; i += 2; code(true); out += "}"; i++; continue; }
      out += c; i++;
    }
  }
  code(false);
  return out;
}

const unescape = (s) => s.replace(/\\(.)/gs, (_, x) => ({ n: "\n", t: "\t" })[x] ?? x);

/** Every tr() call in `src`: its literal key and where it sits, or why its key is not a literal. */
export function trCalls(src) {
  const calls = [], bad = [];
  for (const m of src.matchAll(/\btr\(\s*/g)) {
    const at = m.index + m[0].length, q = src[at];
    const line = src.slice(0, m.index).split("\n").length;
    if (!['"', "'", "`"].includes(q)) { bad.push(`${line}: the key is not a literal`); continue; }
    let j = at + 1;
    while (j < src.length && src[j] !== q) j += src[j] === "\\" ? 2 : 1;
    const raw = src.slice(at + 1, j);
    const next = src.slice(j + 1).match(/^\s*(.)/)?.[1];
    if (q === "`" && raw.includes("${")) { bad.push(`${line}: the key is a template with \${}`); continue; }
    if (next !== "," && next !== ")") { bad.push(`${line}: the key is built, not a literal`); continue; }
    calls.push({ key: unescape(raw), start: at, end: j + 1, line });
  }
  return { calls, bad };
}

const CODE = stripComments(SRC);
const { calls, bad } = trCalls(CODE);
const KEYS = new Set(calls.map((c) => c.key));
const DICTS = { EN, ZH };
const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...s.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)].map((m) => m[0].replace(/\s+/g, " ")).sort();
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`); // the en dash and the em dash

test("i18n: tr() keys in main.js are literals", () => {
  assert.deepEqual(bad, []);
  assert.ok(KEYS.size > 100, `only ${KEYS.size} keys found: the scan is broken`);
});

test("i18n: every key has an English and a Chinese entry", () => {
  for (const [name, dict] of Object.entries(DICTS)) {
    const missing = [...KEYS].filter((k) => typeof dict[k] !== "string" || !dict[k].trim());
    assert.deepEqual(missing, [], `${name} lacks these keys`);
  }
});

test("i18n: each translation keeps its key's placeholders and markup", () => {
  const wrong = [];
  for (const [name, dict] of Object.entries(DICTS)) {
    for (const k of KEYS) {
      if (typeof dict[k] !== "string") continue;
      if (holes(dict[k]).join() !== holes(k).join()) wrong.push(`${name} placeholders: ${k}`);
      if (tags(dict[k]).join() !== tags(k).join()) wrong.push(`${name} markup: ${k}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("i18n: no em dash or en dash in a key or a translation", () => {
  const found = [...KEYS, ...Object.keys(EN), ...Object.values(EN), ...Object.keys(ZH), ...Object.values(ZH)].filter((s) => DASHES.test(s));
  assert.deepEqual(found, []);
});

test("i18n: the dictionaries hold no key that main.js does not use", () => {
  for (const [name, dict] of Object.entries(DICTS)) {
    assert.deepEqual(Object.keys(dict).filter((k) => !KEYS.has(k)), [], `${name} has unused keys`);
  }
});

test("i18n: the words main.js translates for index.html are in index.html", () => {
  const body = CODE.match(/function translateShell\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "translateShell() not found");
  const keys = trCalls(body).calls.map((c) => c.key);
  assert.ok(keys.length >= 10);
  assert.deepEqual(keys.filter((k) => !HTML.includes(k)), []);
});

/**
 * Portuguese left on screen: a line of main.js, outside comments, with a Portuguese accented letter
 * outside a tr() key and outside the SDK_PT map. A heuristic: unaccented Portuguese passes it.
 */
export function leftovers(src) {
  const code = stripComments(src).split("");
  for (const c of trCalls(code.join("")).calls) for (let k = c.start; k < c.end; k++) if (code[k] !== "\n") code[k] = " ";
  const text = code.join("");
  const from = text.indexOf("const SDK_PT = new Map([");
  const to = from < 0 ? -1 : text.indexOf("]);", from);
  const lines = (from < 0 ? text : text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, " ") + text.slice(to)).split("\n");
  return lines.map((l, n) => [n + 1, l]).filter(([, l]) => /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(l)).map(([n, l]) => `${n}: ${l.trim()}`);
}

test("i18n: no Portuguese accented text in main.js outside tr() and SDK_PT", () => {
  assert.deepEqual(leftovers(SRC), []);
});

test("i18n: the leftover check catches a string outside tr(), and not one in a comment", () => {
  const sample = [
    'const a = tr("Trocar já");',
    "// já, à, ç in a comment",
    "/* também */",
    'const b = "Não traduzido";',
    "const c = `<p>${tr('Olá')} e atenção</p>`;",
    "const d = x.replace(/[\"']/g, \"\"); // já: the quote in the regex opens no string",
    'const e = "https://x.pt/" + "não";',
    'const SDK_PT = new Map([["Cancel", "Cancelar à mão"]]);',
    'const f = tr("Olá " + name);',
  ].join("\n");
  assert.deepEqual(leftovers(sample).map((l) => l.split(":")[0]), ["4", "5", "7", "9"]);
  assert.deepEqual(trCalls(stripComments(sample)).bad, ["9: the key is built, not a literal"]);
});

test("i18n: tr() picks the stored language, fills placeholders, and falls back to the key", async () => {
  const saved = { localStorage: globalThis.localStorage, document: globalThis.document };
  globalThis.localStorage = { getItem: (k) => (k === "book:lang" ? "zh" : null), setItem() {} };
  globalThis.document = { documentElement: {} };
  try {
    const m = await import("../web/src/i18n.js?zh");
    assert.equal(m.LANG, "zh");
    assert.equal(m.LOCALE, "zh-CN");
    assert.equal(globalThis.document.documentElement.lang, "zh-CN");
    assert.equal(m.tr("<b>{n}</b> oferta aberta", { n: 3 }), "<b>3</b> oferta aberta"); // not a key: falls back, filled
    assert.equal(m.tr("Confirmas {n} vezes na carteira.", { n: 3 }), ZH["Confirmas {n} vezes na carteira."].replace("{n}", "3"));
    assert.equal(m.tr("{n} min", { n: "$&" }), ZH["{n} min"].replace("{n}", () => "$&"));
    assert.equal(m.tr("not a key {x}", { x: 1 }), "not a key 1");
  } finally {
    globalThis.localStorage = saved.localStorage;
    globalThis.document = saved.document;
  }
});
