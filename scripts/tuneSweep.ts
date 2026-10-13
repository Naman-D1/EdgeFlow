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
const synth: Record<string, ImageData[]> = { person: [], vehicle: [], cloth: [], shaker: [] };
let sx = 200, sy = 100;
for (let t = 0; t < 160; t++) {
  synth.person.push(render([{ x: bounce(30, 2.6, t, 0, 280), y: 70, w: 40, h: 90 }]));
  synth.vehicle.push(render([{ x: bounce(10, 5, t, 0, 250), y: 150, w: 70, h: 35 }]));
  cx += (rnd() - .5) * 22; cy += (rnd() - .5) * 22; cx = Math.min(240, Math.max(20, cx)); cy = Math.min(140, Math.max(20, cy));
  const k = 1 + (rnd() - .5) * .7; synth.cloth.push(render([{ x: cx, y: cy, w: 60 * k, h: 60 / k }]));
  sx += (rnd() - .5) * 26; sy += (rnd() - .5) * 26; sx = Math.min(280, Math.max(120, sx)); sy = Math.min(190, Math.max(30, sy)); synth.shaker.push(render([{ x: sx, y: sy, w: 34, h: 34 }]));
}


interface Cfg {
  nf: number; erratic: number; aspect: number; variance: number; minNet: number;
  voteWindow: number; dropEnter: number; dropLeave: number; confirm: number; gateScale: number; link: number; fit: boolean;
}
function run(frames: ImageData[], cfg: Cfg) {
  const gate = { ...DEFAULT_FILTER_PARAMS, maxErraticScore: cfg.erratic, maxAspectDeformation: cfg.aspect, varianceThreshold: cfg.variance, minNetDisplacement: cfg.minNet };
  const th = { varianceThreshold: cfg.variance, minNetDisplacement: cfg.minNet, maxAspectDeformation: cfg.aspect };
  const e = new OpenCVOpticalFlowEngine();
  Object.assign(e.getTracker().opts, { noiseFloor: cfg.nf, voteWindow: cfg.voteWindow, dropEnter: cfg.dropEnter, dropLeave: cfg.dropLeave, confirmFrames: cfg.confirm, gateScale: cfg.gateScale, linearFit: cfg.fit });
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
  return { person: k('person').keep, vehicle: k('vehicle').keep, clothDrop: k('cloth').trash, shakerDrop: k('shaker').trash };
};
const guardOk = (g: ReturnType<typeof synthScore>) => g.person >= 0.95 && g.vehicle >= 0.95 && g.clothDrop >= 0.9 && g.shakerDrop >= 0.9;

const defaults: Cfg = { nf: 4, erratic: DEFAULT_FILTER_PARAMS.maxErraticScore, aspect: DEFAULT_FILTER_PARAMS.maxAspectDeformation, variance: DEFAULT_FILTER_PARAMS.varianceThreshold,
  minNet: DEFAULT_FILTER_PARAMS.minNetDisplacement, voteWindow: 5, dropEnter: 4, dropLeave: 2, confirm: 8, gateScale: 0.75, link: 1, fit: false };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const N = +(process.argv[3] ?? 160);
const cands: Cfg[] = [defaults];
for (let i = 0; i < N; i++) {
  const voteWindow = pick([3, 5, 7]);
  cands.push({ nf: pick([3, 4, 5, 6, 8]), erratic: pick([0.1, 0.2, 0.3, 0.5, 0.7]), aspect: pick([0.28, 0.5, 0.8, 1.2]), variance: pick([38, 70, 110]), minNet: pick([0.2, 0.3, 0.42]),
    voteWindow, dropEnter: pick([voteWindow, Math.max(2, voteWindow - 1)]), dropLeave: pick([1, 2, 3]), confirm: pick([8, 12, 16]), gateScale: pick([0.5, 0.75, 1.0]), link: pick([1, 2]), fit: process.env.FIT === '1' ? true : pick([false, true]) });
}
const fmt = (c: Cfg) => `nf ${c.nf} erratic ${c.erratic} aspect ${c.aspect} var ${c.variance} minNet ${c.minNet} vote ${c.dropEnter}/${c.voteWindow} leave ${c.dropLeave} confirm ${c.confirm} gate ${c.gateScale} link ${c.link} fit ${c.fit ? 'on' : 'off'}`;
const rows = cands.map(cfg => { const per = run(real, cfg); return { cfg, A: score(per, 0, SPLIT), B: score(per, SPLIT, real.length), g: synthScore(cfg) }; });
const val = (x: { keep: number; trash: number }) => x.keep - x.trash;
const elig = rows.filter(r => guardOk(r.g));
console.log(`candidates ${rows.length}, passing synthetic guard rails (person/vehicle kept >=95%, cloth and shaker dropped >=90%): ${elig.length}`);
const show = (name: string, r: typeof rows[number]) => console.log(`  ${name.padEnd(8)} ${fmt(r.cfg)}\n           half A keep ${(100 * r.A.keep).toFixed(1)}% trash ${(100 * r.A.trash).toFixed(1)} | half B keep ${(100 * r.B.keep).toFixed(1)}% trash ${(100 * r.B.trash).toFixed(1)} | synth person ${(100 * r.g.person).toFixed(0)} vehicle ${(100 * r.g.vehicle).toFixed(0)} cloth-drop ${(100 * r.g.clothDrop).toFixed(0)} shaker-drop ${(100 * r.g.shakerDrop).toFixed(0)}`);
console.log('\nTwo-fold check (pick on one half, score on the other):');
const bestA = [...elig].sort((x, y) => val(y.A) - val(x.A))[0], bestB = [...elig].sort((x, y) => val(y.B) - val(x.B))[0];
if (bestA) console.log(`  chosen on A -> scored on B: keep ${(100 * bestA.B.keep).toFixed(1)}% trash ${(100 * bestA.B.trash).toFixed(1)}%`);
if (bestB) console.log(`  chosen on B -> scored on A: keep ${(100 * bestB.A.keep).toFixed(1)}% trash ${(100 * bestB.A.trash).toFixed(1)}%`);
console.log(`  defaults, both halves:      A keep ${(100 * rows[0].A.keep).toFixed(1)}% trash ${(100 * rows[0].A.trash).toFixed(1)} | B keep ${(100 * rows[0].B.keep).toFixed(1)}% trash ${(100 * rows[0].B.trash).toFixed(1)}`);
console.log('\nTop 5 by combined real score (in-sample on the whole clip):');
const total = (r: typeof rows[number]) => val(r.A) + val(r.B);
[...elig].sort((x, y) => total(y) - total(x)).slice(0, 5).forEach((r, i) => show(`#${i + 1}`, r));
console.log('\nDefaults:'); show('defaults', rows[0]);
