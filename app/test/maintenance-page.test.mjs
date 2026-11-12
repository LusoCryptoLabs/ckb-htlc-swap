// The page nginx shows while the book is down for a deploy: it must carry its font inline (the
// book's /fonts are down too), speak the book's three languages, and come back through /api/price.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the maintenance page is self-contained and checks the book by itself", () => {
  const html = execFileSync(process.execPath, [path.join(APP, "scripts", "maintenance-page.mjs")], { encoding: "utf8" });
  assert.ok(!html.includes("__VT323__"), "the font placeholder was replaced");
  assert.match(html, /url\(data:font\/woff2;base64,[A-Za-z0-9+/]{1000,}={0,2}\)/);
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//, "nothing loads from elsewhere");
  assert.doesNotMatch(html, /url\(\/fonts/, "nothing loads from the book itself");
  for (const s of ["Swapping parts.", "A trocar de peças.", "正在更换零件。"]) assert.ok(html.includes(s), s);
  assert.match(html, /fetch\("\/api\/price", \{ cache: "no-store" \}\)/);
  assert.match(html, /location\.reload\(\)/);
  // after 5 minutes it stops promising minutes
  assert.match(html, /fails === 30\) \{ document\.querySelector\("\.lead"\)\.textContent = T\.long/);
  for (const s of ["taking longer than usual", "demorar mais do que o costume", "这次比平时久"]) assert.ok(html.includes(s), s);
});
