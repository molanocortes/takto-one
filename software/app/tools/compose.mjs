// compose.mjs - lay the stills out as one docs image, in the same Chromium.
//
//   NODE_PATH=/tmp/cap/node_modules node tools/compose.mjs tools/out ../../docs/media/app-screens.png [chromium-path]
//
// The loop is tools/gif.mjs, from the frames capture.mjs wrote.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const IN = process.argv[2] ?? 'tools/out';
const OUT = process.argv[3] ?? '../../docs/media/app-screens.png';
const EXE = process.argv[4];
const SHOTS = ['welcome', 'live', 'replay', 'data'];

const imgs = await Promise.all(SHOTS.map(async (n) =>
  `data:image/png;base64,${(await readFile(resolve(IN, `screen-${n}.png`))).toString('base64')}`));

const html = `<!doctype html><body style="margin:0;background:#0A0A0B">
<div style="display:flex;gap:28px;padding:36px;align-items:flex-start">
${imgs.map((src) => `<img src="${src}" style="width:390px;height:844px;border-radius:44px;
  box-shadow:0 30px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08)">`).join('')}
</div></body>`;

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 390 * 4 + 28 * 3 + 72, height: 844 + 72 }, deviceScaleFactor: 2 });
await page.setContent(html);
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();
console.log('wrote', OUT);
