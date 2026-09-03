// gif.mjs - encode the loop frames capture.mjs wrote into docs/media/app-live.gif.
//
//   npm --prefix /tmp/cap install gifenc pngjs
//   NODE_PATH=/tmp/cap/node_modules node tools/gif.mjs tools/out/frames ../../docs/media/app-live.gif [width]
//
// capture.mjs already laid the three panels out, so a frame here is the
// finished picture and this only quantises and times it.
//
// Pure JS on purpose: the Playwright ffmpeg build has no image demuxer and a
// full ffmpeg is not a dependency this app wants to carry.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { PNG } = require('pngjs');

const DIR = process.argv[2] ?? 'tools/out/frames';
const OUT = process.argv[3] ?? '../../docs/media/app-live.gif';
const WIDTH = Number(process.argv[4] ?? 960);  // target width; frames box-filter down to it
const DELAY = 40;                        // ms, twenty-five frames a second

const files = readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();
const gif = GIFEncoder();
for (const f of files) {
  const png = PNG.sync.read(readFileSync(join(DIR, f)));
  const scale = png.width / WIDTH;
  const h = Math.round(png.height / scale);
  // box-filter downsample to the target width
  const rgba = new Uint8ClampedArray(WIDTH * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < WIDTH; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    const x0 = Math.floor(x * scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
    const y0 = Math.floor(y * scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
    for (let yy = y0; yy < y1 && yy < png.height; yy++) for (let xx = x0; xx < x1 && xx < png.width; xx++) {
      const i = (yy * png.width + xx) * 4; r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
    }
    const o = (y * WIDTH + x) * 4;
    rgba[o] = r / n; rgba[o + 1] = g / n; rgba[o + 2] = b / n; rgba[o + 3] = 255;
  }
  const palette = quantize(rgba, 128);
  const index = applyPalette(rgba, palette);
  gif.writeFrame(index, WIDTH, h, { palette, delay: DELAY });
}
gif.finish();
writeFileSync(OUT, gif.bytes());
console.log('wrote', OUT, files.length, 'frames');
