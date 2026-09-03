// capture.mjs - render the app's media deterministically.
//
// The synthetic feed is a pure function of time and the app accepts ?t=,
// ?screen= and ?take=, so every frame this produces is reproducible: run it
// again and you get the same pixels. That is the same rule the project's
// Blender renders are held to, and it is why the images in docs/ can be
// regenerated rather than hoarded.
//
// Needs a served web export (or the dev server) and a Chromium. Playwright is
// deliberately NOT a dependency of this app; install playwright-core wherever
// you like and point NODE_PATH at it:
//
//   npm --prefix /tmp/cap install playwright-core
//   npx expo export --platform web --output-dir /tmp/webdist
//   python3 -m http.server 8099 --directory /tmp/webdist
//   NODE_PATH=/tmp/cap/node_modules node tools/capture.mjs http://localhost:8099 tools/out all [chromium-path] [design] [scale]
//
// The sixth argument picks a design from src/designs (?design=NN); the
// seventh is the device scale factor (3 by default, 2 for the exploration
// gallery). The live-fingers still opens the design's detail state with
// ?detail=1 rather than scrolling, since every design keeps its detail
// somewhere different.
//
// Then `node tools/compose.mjs tools/out` writes docs/media/app-screens.png,
// and `node tools/gif.mjs tools/out/frames` turns the frames into app-live.gif.
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const BASE = process.argv[2] ?? 'http://localhost:8099';
const OUT = process.argv[3] ?? 'tools/out';
const MODE = process.argv[4] ?? 'all';        // all | stills | gif
const EXE = process.argv[5];                  // optional Chromium executable
const DESIGN = process.argv[6];               // optional design id, ?design=NN
const SCALE = Number(process.argv[7] ?? 3);   // device scale factor of the stills
const withDesign = (q) => (DESIGN ? `${q}&design=${DESIGN}` : q);
const W = 390, H = 844;                      // iPhone 14 points

/** stills: every surface, each at a moment worth looking at */
const STILLS = [
  { name: 'welcome', q: 'screen=welcome&t=2.0' },
  { name: 'live', q: 'screen=live&t=2.0' },
  { name: 'live-fingers', q: 'screen=live&t=21.4&detail=1' },
  { name: 'replay-library', q: 'screen=replay&t=6.2', noTwin: true },
  { name: 'replay', q: 'screen=replay&take=take_demo_signature&t=6.2' },
  { name: 'data', q: 'screen=data&t=2.0', noTwin: true },
];

/** the loop: the travelling wave, index to pinky, which is the clearest
 *  demonstration that twelve joints are being driven independently */
const GIF = { from: 18.4, to: 25.2, frames: 44, scale: 1.5, screen: 'live' };

async function open(ctx, url, needsTwin = true, scroll = 0) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  // Never shoot before the model is rigged. Screens without a twin do not wait.
  if (needsTwin) await page.waitForFunction('window.__taktoTwinReady === true', null, { timeout: 90000 });
  if (scroll) {
    await page.evaluate((y) => {
      for (const d of document.querySelectorAll('div')) {
        if (d.scrollHeight > d.clientHeight + 50 && getComputedStyle(d).overflowY !== 'visible') d.scrollTop = y;
      }
    }, scroll);
  }
  // let the renderer settle: the first frames upload buffers and compile shaders
  await new Promise((r) => setTimeout(r, 1500));
  return page;
}

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});

await mkdir(OUT, { recursive: true });
await mkdir(`${OUT}/frames`, { recursive: true });

if (MODE !== 'gif') {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  for (const s of STILLS) {
    const p = `${OUT}/screen-${s.name}.png`;
    const page = await open(ctx, `${BASE}/?${withDesign(s.q)}`, !s.noTwin, s.scroll);
    await page.screenshot({ path: p, timeout: 180000 });
    await page.close();
    console.log('still', p);
  }
  await ctx.close();
}

// One page for the whole sequence: the clock is stepped in place, so the model
// uploads once and every frame is the same scene at a different time.
if (MODE !== 'stills') {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: GIF.scale });
  const page = await open(ctx, `${BASE}/?${withDesign(`screen=${GIF.screen}&t=${GIF.from}`)}`);
  for (let i = 0; i < GIF.frames; i++) {
    const t = GIF.from + (GIF.to - GIF.from) * (i / GIF.frames);
    await page.evaluate((tt) => window.__taktoSession.pin(tt), t);
    // two animation frames: one to apply the pose, one to draw it
    await page.evaluate(() => new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: `${OUT}/frames/f${String(i).padStart(4, '0')}.png`, timeout: 180000 });
    if (i % 10 === 0) console.log('frame', i, 'of', GIF.frames);
  }
  await page.close();
  await ctx.close();
}

await browser.close();
console.log('done ->', OUT);
