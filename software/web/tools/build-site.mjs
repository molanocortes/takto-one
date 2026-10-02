// build-site.mjs - the deployable takto.one: software/web, bundled and minified.
//
//   node software/web/tools/build-site.mjs [outDir]      (default ~/Desktop/takto-site)
//   ESBUILD=/path/to/esbuild node ...                    (else esbuild on PATH, else npx)
//
// The source stays as it is (plain ES modules, served as-is on this machine
// and the lab LAN). The public build differs in four ways:
//   1. JavaScript is bundled and minified by esbuild, split per route: the
//      product page loads only its own code; each console surface is a chunk
//      fetched the first time someone opens it (main.js imports them lazily).
//   2. The four stylesheets become one minified file.
//   3. Every built file carries a content hash in its name and is served as
//      immutable for a year (_headers), so a returning visitor revalidates
//      nothing; a new deploy changes the names.
//   4. index.html loses its inline import map (three.js is bundled), so the
//      Content-Security-Policy needs no script hash at all.
// Dev-only pages, the build tools and the full-size hand model (the site
// loads zero_hand.web.glb, see tools/bake-web-glb.mjs) are left out.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] || join(homedir(), "Desktop/takto-site"));
const TMP = mkdtempSync(join(tmpdir(), "takto-site-"));
const BUILD = "build";                       // hashed JS + CSS live here (immutable)
const SKIP = new Set(["src", "styles", "vendor", "tools", "device_screen_preview.html", "imu_axis_cal.html", ".DS_Store"]);
const SKIP_ASSETS = new Set(["assets/zero_hand.glb"]);   // the site ships zero_hand.web.glb

function esbuild(args, input) {
  const bin = process.env.ESBUILD || "esbuild";
  try {
    return execFileSync(bin, args, { cwd: WEB, input, stdio: [input ? "pipe" : "ignore", "pipe", "inherit"] });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return execFileSync("npx", ["--yes", "esbuild@0.21.5", ...args], { cwd: WEB, input, stdio: [input ? "pipe" : "ignore", "pipe", "inherit"] });
  }
}
const hash8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);
const kb = (n) => (n / 1024).toFixed(1) + " KB";

// ---- 1. static files ----
for (const name of readdirSync(WEB)) {
  if (SKIP.has(name) || name.startsWith(".")) continue;
  cpSync(join(WEB, name), join(TMP, name), { recursive: true,
    filter: (src) => !src.endsWith(".DS_Store") && !SKIP_ASSETS.has(relative(WEB, src)) });
}

// ---- 2. JavaScript: one entry, a chunk per lazy route ----
mkdirSync(join(TMP, BUILD), { recursive: true });
esbuild(["src/main.js", "--bundle", "--splitting", "--format=esm", "--minify", "--log-level=warning",
  `--outdir=${join(TMP, BUILD)}`, "--entry-names=[name]-[hash]", "--chunk-names=c-[hash]",
  "--alias:three=./vendor/three.module.js", "--legal-comments=eof", `--metafile=${join(TMP, "meta.json")}`]);
const meta = JSON.parse(readFileSync(join(TMP, "meta.json"), "utf8"));
rmSync(join(TMP, "meta.json"));
const outputs = Object.entries(meta.outputs).filter(([f]) => f.endsWith(".js"));
const [mainPath, mainOut] = outputs.find(([, o]) => o.entryPoint === "src/main.js");
const mainFile = relative(TMP, resolve(WEB, mainPath));
// the chunks the entry needs at once, so the browser fetches them in parallel
const preload = mainOut.imports.filter((i) => i.kind === "import-statement").map((i) => relative(TMP, resolve(WEB, i.path)));

// ---- 3. CSS: the page's four sheets as one; the legal pages keep theirs ----
const sheets = ["tokens.css", "base.css", "surfaces.css", "site.css"].map((f) => readFileSync(join(WEB, "styles", f), "utf8"));
const css = esbuild(["--loader=css", "--minify", "--log-level=warning"], sheets.join("\n"));
const cssFile = `${BUILD}/app-${hash8(css)}.css`;
writeFileSync(join(TMP, cssFile), css);
mkdirSync(join(TMP, "styles"), { recursive: true });
for (const f of ["tokens.css", "base.css"]) writeFileSync(join(TMP, "styles", f), esbuild(["--loader=css", "--minify", "--log-level=warning"], readFileSync(join(WEB, "styles", f))));

// ---- 4. index.html ----
let html = readFileSync(join(WEB, "index.html"), "utf8");
const sheetLinks = /(?:<link rel="stylesheet" href="styles\/[a-z]+\.css">\s*){4}/;
if (!sheetLinks.test(html)) throw new Error("index.html: the four stylesheet links moved; update build-site.mjs");
html = html.replace(sheetLinks, `<link rel="stylesheet" href="${cssFile}">\n`);
const importMap = /<script type="importmap">[\s\S]*?<\/script>\s*/;
if (!importMap.test(html)) throw new Error("index.html: no import map found; update build-site.mjs");
html = html.replace(importMap, "");
const entry = '<script type="module" src="src/main.js"></script>';
if (!html.includes(entry)) throw new Error("index.html: entry script moved; update build-site.mjs");
html = html.replace(entry, `<script type="module" src="${mainFile}"></script>`);
html = html.replace("</head>", preload.map((p) => `<link rel="modulepreload" href="${p}">\n`).join("") + "</head>");
html = html.replace(/<!--[\s\S]*?-->\s*/g, "");       // the source keeps its notes; the visitor needs none
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) throw new Error("index.html: an inline script survived (the CSP allows none)");
writeFileSync(join(TMP, "index.html"), html);

// ---- 5. _headers: no inline-script hash any more; hashed files are immutable ----
let headers = readFileSync(join(WEB, "_headers"), "utf8");
headers = headers.replace(/ 'sha256-[A-Za-z0-9+/=]+'/g, "");
headers = headers.replace(/\n\/vendor\/\*\n  Cache-Control: [^\n]*\n/, "\n");
headers += `\n# content-hashed build output (tools/build-site.mjs): a new deploy renames it\n/${BUILD}/*\n  Cache-Control: public, max-age=31536000, immutable\n`;
if (/'sha256-/.test(headers)) throw new Error("_headers: a script hash survived");
writeFileSync(join(TMP, "_headers"), headers);

// ---- 6. licences of the bundled third-party code (MIT asks for its notice) ----
writeFileSync(join(TMP, BUILD, "LICENSES.txt"), `Third-party code bundled in this directory (all MIT License):

three.js r160 (three.module.js, GLTFLoader, BufferGeometryUtils)
  Copyright 2010-2023 Three.js Authors
meshoptimizer 1.3 decoder (meshopt_decoder)
  Copyright (C) 2016-2026, by Arseny Kapoulkine (arseny.kapoulkine@gmail.com)
qrcode-generator
  Copyright (c) 2009 Kazuhiko Arase

MIT License: Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to
whom the Software is furnished to do so, subject to the following conditions: The above
copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR
A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
`);

// ---- 7. swap into place ----
mkdirSync(OUT, { recursive: true });
execFileSync("rsync", ["-a", "--delete", TMP + "/", OUT + "/"]);
rmSync(TMP, { recursive: true, force: true });

// ---- report ----
let files = 0, bytes = 0;
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else { files++; bytes += s.size; } } };
walk(OUT);
const sz = (f) => { const b = readFileSync(join(OUT, f)); return `${kb(b.length)} (${kb(gzipSync(b, { level: 9 }).length)} gz)`; };
const firstLoad = [mainFile, ...preload].reduce((acc, f) => acc + gzipSync(readFileSync(join(OUT, f)), { level: 9 }).length, 0);
console.log(`built ${OUT}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`  entry ${mainFile} ${sz(mainFile)} + ${preload.length} preloaded chunk(s); product page JS ${kb(firstLoad)} gz`);
console.log(`  css   ${cssFile} ${sz(cssFile)}`);
console.log(`  lazy chunks: ${outputs.length - 1 - preload.length}`);
