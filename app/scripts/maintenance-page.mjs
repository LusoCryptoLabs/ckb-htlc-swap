// Builds the page nginx shows while the book is down for a deploy (the platform serves
// /var/www/maintenance/<host>.html on a 502, 503 or 504). The book's own files are down then too,
// so the page carries its font inline. Usage: node scripts/maintenance-page.mjs > swapbook.html
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(APP, "maintenance", "page.src.html"), "utf8");
const font = fs.readFileSync(path.join(APP, "web", "public", "fonts", "vt323-400.woff2")).toString("base64");
process.stdout.write(src.replace("__VT323__", font));
