// Ablation on the scripted synthetic scenes: switches one component off at a time. Usage: npx tsx scripts/synAblation.ts <framesDir>  (framesDir only supplies real frames the harness loads; results are the synthetic scores)
// Threshold sweep with a guard rail against "keep everything".
//   npx tsx scripts/tuneSweep.ts <framesDir>
// Real frames (no ground truth, assumed to be mostly objects worth keeping) are split in two:
// the first half picks thresholds, the second half is held out. A config is only eligible if it ALSO
// still drops synthetic trash (tumbling cloth) and keeps the synthetic person and vehicle.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { OpenCVOpticalFlowEngine } from '../src/utils/opencvAdapter';
import { DEFAULT_FILTER_PARAMS } from '../src/utils/motionSimulation';

const req = createRequire(import.meta.url);
const { PNG } = req('pngjs');
const dir = process.argv[2];
if (!dir) { console.error('usage: npx tsx scripts/synAblation.ts <framesDir>'); process.exit(1); }
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
const real: ImageData[] = files.map(f => { const p = PNG.sync.read(fs.readFileSync(path.join(dir, f))); return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height, colorSpace: 'srgb' } as ImageData; });
const SPLIT = Math.floor(real.length / 2);

// ---- synthetic scenes (same construction as scripts/trackerSim.ts) ----
const W = 320, H = 240;
let seed = 777; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
function field(w: number, h: number, r: number, lo: number, hi: number, wrap: boolean) {
  const a = Float32Array.from({ length: w * h }, () => rnd()), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let t = 0, n = 0; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { let yy = y + dy, xx = x + dx; if (wrap) { yy = (yy + h) % h; xx = (xx + w) % w; } else if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue; t += a[yy * w + xx]; n++; } o[y * w + x] = t / n; }
  let mn = 1e9, mx = -1e9; for (const v of o) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return Uint8Array.from(o, v => lo + (v - mn) / (mx - mn) * (hi - lo));
}
const tex = field(256, 256, 3, 50, 210, true), bg = field(W, H, 4, 90, 150, false);
const bounce = (p0: number, v: number, t: number, lo: number, hi: number) => { const sp = hi - lo; let p = (p0 - lo + v * t) % (2 * sp); if (p < 0) p += 2 * sp; return lo + (p > sp ? 2 * sp - p : p); };
function render(boxes: { x: number; y: number; w: number; h: number }[]): ImageData {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = bg[i]; d[i * 4 + 3] = 255; }
  for (const b of boxes) for (let y = Math.max(0, Math.round(b.y)); y < Math.min(H, Math.round(b.y + b.h)); y++) for (let x = Math.max(0, Math.round(b.x)); x < Math.min(W, Math.round(b.x + b.w)); x++) { const v = tex[((y - Math.round(b.y)) & 255) * 256 + ((x - Math.round(b.x)) & 255)], i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; }
  return { data: d, width: W, height: H, colorSpace: 'srgb' } as ImageData;
}
let cx = 100, cy = 120;
const synth: Record<string, ImageData[]> = { person: [], vehicle: [], cloth: [], shaker: [] };
let sx = 200, sy = 100;
for (let t = 0; t < 160; t++) {
  synth.person.push(render([{ x: bounce(30, 2.6, t, 0, 280), y: 70, w: 40, h: 90 }]));
  synth.vehicle.push(render([{ x: bounce(10, 5, t, 0, 250), y: 150, w: 70, h: 35 }]));
  cx += (rnd() - .5) * 22; cy += (rnd() - .5) * 22; cx = Math.min(240, Math.max(20, cx)); cy = Math.min(140, Math.max(20, cy));
  const k = 1 + (rnd() - .5) * .7; synth.cloth.push(render([{ x: cx, y: cy, w: 60 * k, h: 60 / k }]));
  sx += (rnd() - .5) * 26; sy += (rnd() - .5) * 26; sx = Math.min(280, Math.max(120, sx)); sy = Math.min(190, Math.max(30, sy)); synth.shaker.push(render([{ x: sx, y: sy, w: 34, h: 34 }]));
}


// The app's own virtual-camera demos (flat shapes on a dark room), so a preset cannot pass them as "keep".
function flat(draw: (set: (x: number, y: number, v: number) => void) => void): ImageData {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = y > H * 0.65 ? 18 : 38, i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  draw((x, y, v) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < W && y < H) { const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; } });
  return { data: d, width: W, height: H, colorSpace: 'srgb' } as ImageData;
}
const disc = (set: (x: number, y: number, v: number) => void, cx0: number, cy0: number, r: number, v: number) => { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) set(cx0 + x, cy0 + y, v); };
const rect = (set: (x: number, y: number, v: number) => void, x0: number, y0: number, w: number, h: number, v: number) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x0 + x, y0 + y, v); };
const demo: Record<string, ImageData[]> = { humanDemo: [], flutterDemo: [], debrisDemo: [] };
for (let f = 0; f < 200; f++) {
  const t = f * 0.033;
  demo.humanDemo.push(flat(set => { const wx = (Math.sin(t * 0.8) * 0.35 + 0.5) * W, wy = H * 0.55; rect(set, wx - 15, wy - 37, 30, 75, 150); disc(set, wx, wy - 49, 10, 245); }));
  demo.flutterDemo.push(flat(set => disc(set, W * 0.5 + Math.sin(t * 12) * 45, H * 0.4 + Math.cos(t * 16) * 35, 14, 110)));
  demo.debrisDemo.push(flat(set => { const dx = W * 0.5 + Math.sin(t * 1.5) * 60, sw = 40 + Math.sin(t * 8) * 28, sh = 40 + Math.cos(t * 7) * 28; rect(set, dx - sw / 2, H * 0.5 - sh / 2, sw, sh, 190); }));
}

interface Cfg {
  nf: number; erratic: number; aspect: number; variance: number; minNet: number;
  voteWindow: number; dropEnter: number; dropLeave: number; confirm: number; gateScale: number; link: number; fit: boolean; merge: number; alpha: number;
}
let OV: any = {};
function run(frames: ImageData[], cfg: Cfg) {
  const gate = { ...DEFAULT_FILTER_PARAMS, ...(OV.gate ?? {}), maxErraticScore: cfg.erratic, maxAspectDeformation: cfg.aspect, varianceThreshold: cfg.variance, minNetDisplacement: cfg.minNet };
  const th = { varianceThreshold: cfg.variance, minNetDisplacement: cfg.minNet, maxAspectDeformation: cfg.aspect };
  const e = new OpenCVOpticalFlowEngine();
  Object.assign(e.getTracker().opts, { noiseFloor: cfg.nf, voteWindow: cfg.voteWindow, dropEnter: cfg.dropEnter, dropLeave: cfg.dropLeave, confirmFrames: cfg.confirm, gateScale: cfg.gateScale, linearFit: cfg.fit, mergeRatio: cfg.merge, smoothAlpha: cfg.alpha, ...(OV.tracker ?? {}) });
  // per-frame (trackId, state) so halves can be scored separately
  const per: { id: number; s: string }[][] = [];
  frames.forEach(img => { const r = e.processFrame(img, 20, th, { gate, linkRadius: cfg.link }); per.push((r.tracks ?? []).map(k => ({ id: k.id, s: k.state }))); });
  return per;
}
// keep/trash share over tracks that last >=20 frames within [a,b)
function score(per: { id: number; s: string }[][], a: number, b: number) {
  const life = new Map<number, { f: number; p: number; d: number }>();
  for (let i = a; i < b; i++) for (const k of per[i]) { const v = life.get(k.id) ?? { f: 0, p: 0, d: 0 }; v.f++; if (k.s === 'pass') v.p++; else if (k.s === 'drop') v.d++; life.set(k.id, v); }
  let f = 0, p = 0, d = 0; for (const v of life.values()) if (v.f >= 20) { f += v.f; p += v.p; d += v.d; }
  return { keep: f ? p / f : 0, trash: f ? d / f : 0 };
}
const synthScore = (cfg: Cfg) => {
  const k = (n: string) => score(run(synth[n], cfg), 30, 160);
  const dk = (n: string) => score(run(demo[n], cfg), 30, 200);
  const fl = dk('flutterDemo'), db = dk('debrisDemo');
  return { person: k('person').keep, vehicle: k('vehicle').keep, clothDrop: k('cloth').trash, shakerDrop: k('shaker').trash, humanDemo: dk('humanDemo').keep, flutterDemoKeep: fl.keep, debrisDemoKeep: db.keep };
};
const guardOk = (g: ReturnType<typeof synthScore>) => g.person >= 0.95 && g.vehicle >= 0.95 && g.clothDrop >= 0.9 && g.shakerDrop >= 0.9 && g.humanDemo >= 0.9 && g.flutterDemoKeep <= 0.2 && g.debrisDemoKeep <= 0.35;

const full: Cfg = { nf: 4, erratic: DEFAULT_FILTER_PARAMS.maxErraticScore, aspect: DEFAULT_FILTER_PARAMS.maxAspectDeformation, variance: DEFAULT_FILTER_PARAMS.varianceThreshold, minNet: DEFAULT_FILTER_PARAMS.minNetDisplacement, voteWindow: 5, dropEnter: 4, dropLeave: 2, confirm: 8, gateScale: 0.75, link: 1, fit: false, merge: 1.3, alpha: 0.85 };
const cases: [string, any][] = [['full', {}], ['no_temporal', { gate: { enableTemporal: false } }], ['no_size', { gate: { enableSizeGate: false } }], ['no_mergesplit', { tracker: { mergeRatio: 0, smoothAlpha: 1 } }], ['no_voting', { tracker: { voteWindow: 1, dropEnter: 1, dropLeave: 0 } }], ['no_angvar', { gate: { varianceThreshold: 360 } }], ['no_netdisp', { gate: { minNetDisplacement: 0 } }], ['no_aspect', { gate: { maxAspectDeformation: 99 } }]];
console.log('config         person vehicle cloth-drop shaker-drop | human-demo-keep flutter-keep debris-keep');
for (const [n, ov] of cases) { OV = ov; const g = synthScore(full); const f = (x: number) => (100 * x).toFixed(0).padStart(4);
  console.log(n.padEnd(14), f(g.person), f(g.vehicle), f(g.clothDrop), f(g.shakerDrop), '   |', f(g.humanDemo), f(g.flutterDemoKeep), f(g.debrisDemoKeep)); }
