// sheet.mjs - lay a design's stills side by side as one composite, in the
// same Chromium the stills came from.
//
//   NODE_PATH=/tmp/cap/node_modules node tools/sheet.mjs <stills-dir> <out.png> [chromium-path] [names...]
//
// Names default to the five gallery stills. The composite is 1x so the
// gallery index stays light; the stills themselves carry the resolution.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const IN = process.argv[2] ?? 'tools/out';
const OUT = process.argv[3] ?? 'composite.png';
const EXE = process.argv[4];
const SHOTS = process.argv.length > 5 ? process.argv.slice(5) : ['welcome', 'live', 'live-fingers', 'replay', 'data'];
const GAP = 16, PAD = 24;

const imgs = await Promise.all(SHOTS.map(async (n) =>
  `data:image/png;base64,${(await readFile(resolve(IN, `screen-${n}.png`))).toString('base64')}`));

const html = `<!doctype html><body style="margin:0;background:#141414">
<div style="display:flex;gap:${GAP}px;padding:${PAD}px;align-items:flex-start">
${imgs.map((src) => `<img src="${src}" style="width:390px;height:844px;border-radius:24px;
  box-shadow:0 0 0 1px rgba(255,255,255,.10)">`).join('')}
</div></body>`;

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({
  viewport: { width: 390 * SHOTS.length + GAP * (SHOTS.length - 1) + PAD * 2, height: 844 + PAD * 2 },
  deviceScaleFactor: 1,
});
await page.setContent(html);
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();
console.log('wrote', OUT);
