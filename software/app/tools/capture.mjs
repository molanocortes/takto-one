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
//   NODE_PATH=/tmp/cap/node_modules node tools/capture.mjs http://localhost:8099 tools/out all [chromium-path]
//
// Then `node tools/gif.mjs tools/out/frames` turns the frames into
// docs/media/app-live.gif: the three surfaces side by side, all on one clock.
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const BASE = process.argv[2] ?? 'http://localhost:8099';
const OUT = process.argv[3] ?? 'tools/out';
const MODE = process.argv[4] ?? 'all';        // all | stills | gif
const EXE = process.argv[5];                  // optional Chromium executable
const W = 393, H = 895;                      // the reference screen, in points

/** stills: every surface, each at a moment worth looking at */
const STILLS = [
  { name: 'overview', q: 'screen=overview&t=2.0' },
  { name: 'analytics', q: 'screen=analytics&t=21.4', noTwin: true },
  { name: 'logs', q: 'screen=logs&t=2.0', noTwin: true },
];

/**
 * The loop: all three surfaces at once, running the same clock.
 *
 * One image does the whole job the docs used to split between a still sheet
 * and a single-screen clip. The three panels are pinned to the same t and
 * shot together, so what you see is one instant of the app across every
 * surface, not three screens photographed at three different moments.
 *
 * The window is ONE wave period, 20.6 to 22.6. The choreography's pulses sit
 * 2.0 s apart, so the pose at 22.6 is the pose at 20.6 to within 2.7 deg on
 * the worst joint: the loop closes on itself and there is no seam to hide.
 *
 * `part=hand` reframes Overview's hero twin for the loop only. The screen
 * ships the whole device, which is right for a product hero and wrong for
 * this: normalising the model to the forearm's length shrinks the fingers
 * until 50 deg of curl is a few pixels.
 *
 * Logs holds still by nature - it is a source, a session list and four rates
 * - and that is the honest picture of it. The motion in the frame is the
 * motion the app actually has.
 */
const GIF = {
  from: 20.6, to: 22.6, frames: 50, scale: 2,
  panels: [
    { screen: 'overview', params: 'part=hand&dist=1.5', twin: true },
    { screen: 'analytics', params: '', twin: false },
    { screen: 'logs', params: '', twin: false },
  ],
  // the contact-sheet language the still sheet used, at loop scale
  panelW: 300, gap: 20, pad: 24, radius: 34, bg: '#E9E9E9',
};

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
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 3 });
  for (const s of STILLS) {
    const p = `${OUT}/screen-${s.name}.png`;
    const page = await open(ctx, `${BASE}/?${s.q}`, !s.noTwin, s.scroll);
    await page.screenshot({ path: p, timeout: 180000 });
    await page.close();
    console.log('still', p);
  }
  await ctx.close();
}

// Three pages held open for the whole sequence: the clock is stepped in place,
// so each model uploads once and every frame is the same instant on all three
// surfaces. A fourth page lays the panels out, so the frame the encoder sees
// is already the finished picture.
if (MODE !== 'stills') {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: GIF.scale });
  const pages = [];
  for (const p of GIF.panels) {
    const q = `screen=${p.screen}&t=${GIF.from}${p.params ? `&${p.params}` : ''}`;
    pages.push(await open(ctx, `${BASE}/?${q}`, p.twin));
  }

  // Warm-up, discarded. Every trace on these screens is a rolling buffer, and
  // a screen seeds its buffer once from simFrame at its own resting cadence -
  // a quarter-second a sample. The capture steps 0.04 s a frame, so without
  // this the seeded past scrolls out during the clip and the traces visibly
  // change time-scale: the transition from seeded data to captured data,
  // happening inside the loop. Running one full period first flushes every
  // buffer and refills it at the capture's own cadence, so frame 0 already
  // holds a period of history and the traces scroll continuously through the
  // wrap like everything else.
  for (let i = -GIF.frames; i < 0; i++) {
    const t = GIF.from + (GIF.to - GIF.from) * (i / GIF.frames);
    for (const page of pages) {
      await page.evaluate((tt) => window.__taktoSession.pin(tt), t);
      await page.evaluate(() => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r))));
    }
  }
  console.log('warm-up done, buffers filled at capture cadence');

  const panelH = Math.round(GIF.panelW * (H / W));
  const sheetW = GIF.panelW * pages.length + GIF.gap * (pages.length - 1) + GIF.pad * 2;
  const sheet = await ctx.newPage();
  await sheet.setViewportSize({ width: sheetW, height: panelH + GIF.pad * 2 });

  for (let i = 0; i < GIF.frames; i++) {
    const t = GIF.from + (GIF.to - GIF.from) * (i / GIF.frames);
    const shots = [];
    for (const page of pages) {
      await page.evaluate((tt) => window.__taktoSession.pin(tt), t);
      // two animation frames: one to apply the pose, one to draw it
      await page.evaluate(() => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r))));
      shots.push((await page.screenshot({ timeout: 180000 })).toString('base64'));
    }
    await sheet.setContent(
      `<!doctype html><body style="margin:0;background:${GIF.bg}">` +
      `<div style="display:flex;gap:${GIF.gap}px;padding:${GIF.pad}px;align-items:flex-start">` +
      shots.map((b64) => `<img src="data:image/png;base64,${b64}" style="width:${GIF.panelW}px;` +
        `height:${panelH}px;border-radius:${GIF.radius}px;` +
        `box-shadow:0 14px 34px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06)">`).join('') +
      `</div></body>`);
    await sheet.screenshot({ path: `${OUT}/frames/f${String(i).padStart(4, '0')}.png`, timeout: 180000 });
    if (i % 10 === 0) console.log('frame', i, 'of', GIF.frames);
  }

  await sheet.close();
  for (const page of pages) await page.close();
  await ctx.close();
}

await browser.close();
console.log('done ->', OUT);
