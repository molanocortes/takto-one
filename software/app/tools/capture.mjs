// capture.mjs - render the app's media deterministically.
//
// The synthetic feed is a pure function of time and the app accepts ?t= and
// ?screen=, so every frame this produces is reproducible: run it again and you
// get the same pixels. That is the same rule the project's Blender renders are
// held to, and it is why the images in docs/ can be regenerated rather than
// hoarded.
//
// Needs a running dev server and puppeteer. Puppeteer is deliberately NOT a
// dependency of this app - install it wherever you like and point NODE_PATH at
// it, so the shipped project stays free of a 170 MB browser download:
//
//   npm --prefix /tmp/cap install puppeteer
//   npx expo start --web --port 8099
//   NODE_PATH=/tmp/cap/node_modules node tools/capture.mjs http://localhost:8099
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const BASE = process.argv[2] ?? 'http://localhost:8099';
const OUT = process.argv[3] ?? 'tools/out';
const MODE = process.argv[4] ?? 'all';        // all | stills | gif
const W = 390, H = 844;                      // iPhone 14 points

/** stills: the three surfaces, each at a moment worth looking at */
const STILLS = [
  { name: 'live', q: 'screen=live&t=15.6', scale: 3 },
  { name: 'replay', q: 'screen=replay&take=take_demo_signature&t=6.2', scale: 3 },
  { name: 'data', q: 'screen=data&t=15.6', scale: 3, noTwin: true },
];

/** the loop: the travelling wave, index to pinky, which is the clearest
 *  demonstration that twelve joints are being driven independently */
const GIF = { from: 6.7, to: 13.3, frames: 66, scale: 2, screen: 'live' };

async function open(browser, url, scale, needsTwin = true) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: scale });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  // Never shoot before the model is rigged. The Data screen carries no twin,
  // so it does not wait for one.
  if (needsTwin) await page.waitForFunction('window.__taktoTwinReady === true', { timeout: 60000 });
  // let the renderer settle: the first frames upload buffers and compile shaders
  await new Promise((r) => setTimeout(r, 900));
  return page;
}

async function shoot(browser, url, path, scale, needsTwin = true) {
  const page = await open(browser, url, scale, needsTwin);
  await page.screenshot({ path });
  await page.close();
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-webgl',
         '--hide-scrollbars', '--force-device-scale-factor=1'],
});

await mkdir(OUT, { recursive: true });
await mkdir(`${OUT}/frames`, { recursive: true });

if (MODE !== 'gif') for (const s of STILLS) {
  const p = `${OUT}/screen-${s.name}.png`;
  await shoot(browser, `${BASE}/?${s.q}`, p, s.scale, !s.noTwin);
  console.log('still', p);
}

// One page for the whole sequence: the clock is stepped in place, so the model
// uploads once and every frame is the same scene at a different time.
if (MODE !== 'stills') {
  const page = await open(browser, `${BASE}/?screen=${GIF.screen}&t=${GIF.from}`, GIF.scale);
  for (let i = 0; i < GIF.frames; i++) {
    const t = GIF.from + (GIF.to - GIF.from) * (i / GIF.frames);
    await page.evaluate((tt) => window.__taktoSession.pin(tt), t);
    // two animation frames: one to apply the pose, one to draw it
    await page.evaluate(() => new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: `${OUT}/frames/f${String(i).padStart(4, '0')}.png` });
    if (i % 10 === 0) console.log('frame', i, 'of', GIF.frames);
  }
  await page.close();
}

await browser.close();
console.log('done ->', OUT);
