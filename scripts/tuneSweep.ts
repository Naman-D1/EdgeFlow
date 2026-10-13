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
if (!dir) { console.error('usage: npx tsx scripts/tuneSweep.ts <framesDir>'); process.exit(1); }
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
const synth: Record<string, ImageData[]> = { person: [], vehicle: [], cloth: [] };
for (let t = 0; t < 160; t++) {
  synth.person.push(render([{ x: bounce(30, 2.6, t, 0, 280), y: 70, w: 40, h: 90 }]));
  synth.vehicle.push(render([{ x: bounce(10, 5, t, 0, 250), y: 150, w: 70, h: 35 }]));
  cx += (rnd() - .5) * 22; cy += (rnd() - .5) * 22; cx = Math.min(240, Math.max(20, cx)); cy = Math.min(140, Math.max(20, cy));
  const k = 1 + (rnd() - .5) * .7; synth.cloth.push(render([{ x: cx, y: cy, w: 60 * k, h: 60 / k }]));
}

interface Cfg { nf: number; erratic: number; aspect: number; variance: number }
function run(frames: ImageData[], cfg: Cfg, from = 0) {
  const gate = { ...DEFAULT_FILTER_PARAMS, maxErraticScore: cfg.erratic, maxAspectDeformation: cfg.aspect, varianceThreshold: cfg.variance };
  const th = { varianceThreshold: gate.varianceThreshold, minNetDisplacement: gate.minNetDisplacement, maxAspectDeformation: gate.maxAspectDeformation };
  const e = new OpenCVOpticalFlowEngine(); e.getTracker().opts.noiseFloor = cfg.nf;
  const life = new Map<number, { f: number; p: number; d: number }>();
  frames.forEach((img, i) => {
    const r = e.processFrame(img, 20, th, { gate });
    if (i < from) return;
    for (const k of r.tracks ?? []) { const v = life.get(k.id) ?? { f: 0, p: 0, d: 0 }; v.f++; if (k.state === 'pass') v.p++; else if (k.state === 'drop') v.d++; life.set(k.id, v); }
  });
  let f = 0, p = 0, d = 0; for (const v of life.values()) if (v.f >= 20) { f += v.f; p += v.p; d += v.d; }
  return { keep: f ? p / f : 0, trash: f ? d / f : 0 };
}
const synthScore = (cfg: Cfg) => {
  const a = run(synth.person.slice(0), cfg, 30), b = run(synth.vehicle, cfg, 30), c = run(synth.cloth, cfg, 30);
  return { person: a.keep, vehicle: b.keep, clothDrop: c.trash };
};

const defaults: Cfg = { nf: 4, erratic: DEFAULT_FILTER_PARAMS.maxErraticScore, aspect: DEFAULT_FILTER_PARAMS.maxAspectDeformation, variance: DEFAULT_FILTER_PARAMS.varianceThreshold };
const grid: Cfg[] = [];
for (const nf of [4, 6, 8]) for (const erratic of [0.3, 0.5, 0.8]) for (const aspect of [0.8, 1.2]) for (const variance of [38, 70, 110]) grid.push({ nf, erratic, aspect, variance });
const rows = grid.map(cfg => ({ cfg, tune: run(real.slice(0, SPLIT), cfg), syn: synthScore(cfg) }));
const fmt = (c: Cfg) => `noiseFloor ${c.nf}, erratic ${c.erratic}, aspect ${c.aspect}, variance ${c.variance}`;
const eligible = rows.filter(r => r.syn.person >= 0.95 && r.syn.vehicle >= 0.95 && r.syn.clothDrop >= 0.9);
eligible.sort((a, b) => (b.tune.keep - b.tune.trash) - (a.tune.keep - a.tune.trash));
console.log(`eligible configs: ${eligible.length} of ${rows.length} (synthetic person/vehicle kept >=95%, cloth dropped >=90%)`);
console.log('\nTop 5 on first half of real frames:');
for (const r of eligible.slice(0, 5)) console.log(`  ${fmt(r.cfg)}  real keep ${(100 * r.tune.keep).toFixed(1)}% trash ${(100 * r.tune.trash).toFixed(1)}% | synth person ${(100 * r.syn.person).toFixed(0)}% vehicle ${(100 * r.syn.vehicle).toFixed(0)}% cloth dropped ${(100 * r.syn.clothDrop).toFixed(0)}%`);
const best = eligible[0]?.cfg;
const report = (name: string, cfg: Cfg) => {
  const held = run(real, cfg, SPLIT), syn = synthScore(cfg);
  console.log(`  ${name.padEnd(9)} ${fmt(cfg)}\n            HELD-OUT real half: keep ${(100 * held.keep).toFixed(1)}% trash ${(100 * held.trash).toFixed(1)}% | synth person ${(100 * syn.person).toFixed(0)}% vehicle ${(100 * syn.vehicle).toFixed(0)}% cloth dropped ${(100 * syn.clothDrop).toFixed(0)}%`);
};
console.log('\nHeld-out second half (not used for choosing):');
report('defaults', defaults);
if (best) report('selected', best); else console.log('  no config satisfied the synthetic guard rails');
