// Evaluate the live-path filter on CDNet-2014-layout sequences.
//
//   npm i --no-save jpeg-js pngjs
//   npx tsx scripts/evalCDNet.ts <root> [--maxw 320] [--minfg 150]
//
// <root> is a sequence folder (has input/ and groundtruth/) or a folder of them (a category such as
// dynamicBackground/, or the whole dataset). Layout per sequence:
//   input/in000001.jpg   groundtruth/gt000001.png   temporalROI.txt ("start end")
// Ground truth: 255 = moving foreground, 0 = static (this includes dynamic background such as trees,
// water, fountains), 50 = shadow, 85 = outside ROI, 170 = unknown. Foreground = 255 only.
//
// What is measured (frame level, i.e. what the downstream AI stage would actually receive):
//   object recall   : % of frames with a real foreground object that were forwarded WITH a kept box
//                     overlapping that object
//   empty forwarded : % of frames with NO foreground object that were forwarded anyway (wasted AI work)
//   forwarded       : % of all frames forwarded
// Rows: forward-all, Stage 1 only (any motion), legacy (single global box + legacy gates), and
// per-object tracking (v2.2), the latter both strict (pending = not forwarded) and lenient
// (pending = forwarded, since only confident trash is dropped).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { OpenCVOpticalFlowEngine } from '../src/utils/opencvAdapter';
import { DEFAULT_FILTER_PARAMS } from '../src/utils/motionSimulation';

const req = createRequire(import.meta.url);
let jpeg: any, PNG: any;
try { jpeg = req('jpeg-js'); PNG = req('pngjs').PNG; }
catch { console.error('Missing decoders. Run: npm i --no-save jpeg-js pngjs'); process.exit(1); }

const args = process.argv.slice(2);
const root = args.find(a => !a.startsWith('--'));
const opt = (k: string, d: number) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d; };
const MAXW = opt('maxw', 320), MINFG = opt('minfg', 150);
if (!root) { console.error('usage: npx tsx scripts/evalCDNet.ts <root>'); process.exit(1); }

function findSequences(dir: string, out: string[] = []): string[] {
  if (fs.existsSync(path.join(dir, 'input')) && fs.existsSync(path.join(dir, 'groundtruth'))) { out.push(dir); return out; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) findSequences(path.join(dir, e.name), out);
  return out;
}

interface Frame { img: ImageData; fg: Uint8Array; hasGT: boolean }
function scaleTo(w: number, h: number, rgba: Uint8Array, nw: number, nh: number): Uint8ClampedArray {
  const o = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx = Math.min(w - 1, Math.floor(x * w / nw)), sy = Math.min(h - 1, Math.floor(y * h / nh));
    const si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
    o[di] = rgba[si]; o[di + 1] = rgba[si + 1]; o[di + 2] = rgba[si + 2]; o[di + 3] = 255;
  }
  return o;
}
function loadFrame(seq: string, n: number): Frame | null {
  const nm = String(n).padStart(6, '0');
  const ip = path.join(seq, 'input', `in${nm}.jpg`), gp = path.join(seq, 'groundtruth', `gt${nm}.png`);
  if (!fs.existsSync(ip)) return null;
  const j = jpeg.decode(fs.readFileSync(ip), { useTArray: true });
  const nw = Math.min(MAXW, j.width), nh = Math.round(j.height * nw / j.width);
  const data = scaleTo(j.width, j.height, j.data, nw, nh);
  const fg = new Uint8Array(nw * nh);
  let hasGT = false;
  if (fs.existsSync(gp)) {
    const g = PNG.sync.read(fs.readFileSync(gp));
    hasGT = true;
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const sx = Math.min(g.width - 1, Math.floor(x * g.width / nw)), sy = Math.min(g.height - 1, Math.floor(y * g.height / nh));
      if (g.data[(sy * g.width + sx) * 4] === 255) fg[y * nw + x] = 1;
    }
  }
  return { img: { data, width: nw, height: nh, colorSpace: 'srgb' } as ImageData, fg, hasGT };
}

const fgInside = (fg: Uint8Array, W: number, b: { x: number; y: number; width: number; height: number }) => {
  let s = 0;
  for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(fg.length / W, Math.ceil(b.y + b.height)); y++)
    for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(W, Math.ceil(b.x + b.width)); x++) s += fg[y * W + x];
  return s;
};

type Row = 'forward-all' | 'stage1-only' | 'legacy' | 'tracking-strict' | 'tracking-lenient';
const ROWS: Row[] = ['forward-all', 'stage1-only', 'legacy', 'tracking-strict', 'tracking-lenient'];
interface Tally { obj: number; objHit: number; empty: number; emptyFwd: number; frames: number; fwd: number }
const newT = (): Record<Row, Tally> => Object.fromEntries(ROWS.map(r => [r, { obj: 0, objHit: 0, empty: 0, emptyFwd: 0, frames: 0, fwd: 0 }])) as any;
const total = newT();
let msLegacy = 0, msTrack = 0, nTimed = 0;

const gate = { ...DEFAULT_FILTER_PARAMS };
const th = { varianceThreshold: gate.varianceThreshold, minNetDisplacement: gate.minNetDisplacement, maxAspectDeformation: gate.maxAspectDeformation };

for (const seq of findSequences(root)) {
  const roiF = path.join(seq, 'temporalROI.txt');
  const [r0, r1] = fs.existsSync(roiF) ? fs.readFileSync(roiF, 'utf8').trim().split(/\s+/).map(Number) : [1, 1e9];
  const eL = new OpenCVOpticalFlowEngine(), eT = new OpenCVOpticalFlowEngine();
  const t = newT();
  for (let n = 1; n <= r1; n++) {
    const f = loadFrame(seq, n); if (!f) break;
    let a = performance.now(); const L = eL.processFrame(f.img, 20, th); const dl = performance.now() - a;
    a = performance.now(); const T = eT.processFrame(f.img, 20, th, { gate }); const dt = performance.now() - a;
    if (n < r0 || !f.hasGT) continue;
    msLegacy += dl; msTrack += dt; nTimed++;
    const W = f.img.width;
    const isObj = f.fg.reduce((s, v) => s + v, 0) >= MINFG;
    const tracks = T.tracks ?? [];
    const keptBox = (boxes: { x: number; y: number; width: number; height: number }[]) => boxes.some(b => fgInside(f.fg, W, b) >= Math.min(MINFG, 20));
    const dec: Record<Row, { fwd: boolean; hit: boolean }> = {
      'forward-all': { fwd: true, hit: true },
      'stage1-only': { fwd: L.hasMotion, hit: L.hasMotion && !!L.boundingBox && keptBox([L.boundingBox]) },
      legacy: { fwd: L.stage2Passed, hit: L.stage2Passed && !!L.boundingBox && keptBox([L.boundingBox]) },
      'tracking-strict': { fwd: tracks.some(k => k.state === 'pass'), hit: keptBox(tracks.filter(k => k.state === 'pass').map(k => k.box)) },
      'tracking-lenient': { fwd: tracks.some(k => k.state !== 'drop'), hit: keptBox(tracks.filter(k => k.state !== 'drop').map(k => k.box)) },
    };
    for (const r of ROWS) {
      for (const T_ of [t[r], total[r]]) {
        T_.frames++; if (dec[r].fwd) T_.fwd++;
        if (isObj) { T_.obj++; if (dec[r].hit) T_.objHit++; } else { T_.empty++; if (dec[r].fwd) T_.emptyFwd++; }
      }
    }
  }
  const pct = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) : '  n/a').padStart(6);
  console.log(`\n${path.relative(root, seq) || path.basename(seq)}  (object frames ${t['legacy'].obj}, empty frames ${t['legacy'].empty})`);
  for (const r of ROWS) console.log(`  ${r.padEnd(17)} recall ${pct(t[r].objHit, t[r].obj)}%  empty-fwd ${pct(t[r].emptyFwd, t[r].empty)}%  forwarded ${pct(t[r].fwd, t[r].frames)}%`);
}
const pct = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) : 'n/a').padStart(6);
console.log('\n=== ALL SEQUENCES (frame-weighted) ===');
for (const r of ROWS) console.log(`  ${r.padEnd(17)} recall ${pct(total[r].objHit, total[r].obj)}%  empty-fwd ${pct(total[r].emptyFwd, total[r].empty)}%  forwarded ${pct(total[r].fwd, total[r].frames)}%`);
if (nTimed) console.log(`\nengine time: legacy ${(msLegacy / nTimed).toFixed(2)} ms/frame, tracking ${(msTrack / nTimed).toFixed(2)} ms/frame (Node, scaled to <=${MAXW}px wide)`);
