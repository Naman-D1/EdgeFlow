// Run the filter on a folder of frames WITHOUT ground truth (any real video, extracted with ffmpeg):
//   ffmpeg -i clip.mp4 -vf scale=320:-2 frames/f%05d.png
//   npx tsx scripts/runFrames.ts frames [outDir]
// Prints how many frames each filter forwards and how long tracks live, and writes annotated PNGs
// (green = KEEP, red = TRASH, grey = WATCHING) so the behaviour can be checked by eye.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { OpenCVOpticalFlowEngine } from '../src/utils/opencvAdapter';
import { DEFAULT_FILTER_PARAMS } from '../src/utils/motionSimulation';

const req = createRequire(import.meta.url);
const { PNG } = req('pngjs');
const dir = process.argv[2], outDir = process.argv[3];
if (!dir) { console.error('usage: npx tsx scripts/runFrames.ts <framesDir> [outDir]'); process.exit(1); }
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const saveEvery = +(process.argv[4] ?? 40);

// Optional overrides for threshold sweeps: GATE='{"maxErraticScore":0.3}' NF=8 npx tsx scripts/runFrames.ts ...
const gate = { ...DEFAULT_FILTER_PARAMS, ...(process.env.GATE ? JSON.parse(process.env.GATE) : {}) };
const th = { varianceThreshold: gate.varianceThreshold, minNetDisplacement: gate.minNetDisplacement, maxAspectDeformation: gate.maxAspectDeformation };
const eL = new OpenCVOpticalFlowEngine(), eT = new OpenCVOpticalFlowEngine();
if (process.env.TRACKER) Object.assign(eT.getTracker().opts, JSON.parse(process.env.TRACKER)); // e.g. TRACKER='{"mergeRatio":0,"smoothAlpha":1}' for the old behaviour
if (process.env.NF) eT.getTracker().opts.noiseFloor = +process.env.NF;
let camFrames = 0;
const dump: { f: string; keep: number; lenient: number; cam: number }[] = [];
let n = 0, motion = 0, legacyFwd = 0, trackPass = 0, trackLenient = 0, anyDrop = 0, anyTrack = 0;
const life = new Map<number, { frames: number; pass: number; drop: number; pend: number }>();
let ms = 0;
const why: Record<string, number> = {};

function rect(d: Uint8Array, W: number, H: number, x: number, y: number, w: number, h: number, c: number[]) {
  const set = (px: number, py: number) => { if (px >= 0 && py >= 0 && px < W && py < H) { const i = (py * W + px) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; } };
  for (let t = 0; t < 2; t++) for (let i = 0; i < w; i++) { set(x + i, y + t); set(x + i, y + h - 1 - t); }
  for (let t = 0; t < 2; t++) for (let j = 0; j < h; j++) { set(x + t, y + j); set(x + w - 1 - t, y + j); }
}

for (const f of files) {
  const p = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
  const img = { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height, colorSpace: 'srgb' } as ImageData;
  const L = eL.processFrame(img, 20, th);
  const t0 = performance.now();
  const T = eT.processFrame(img, 20, { ...th, varianceThreshold: gate.varianceThreshold, minNetDisplacement: gate.minNetDisplacement, maxAspectDeformation: gate.maxAspectDeformation }, { gate, globalMotionFrac: process.env.GMF ? +process.env.GMF : undefined, motionPercent: process.env.MP ? +process.env.MP : undefined, minCellPixels: process.env.MCP ? +process.env.MCP : undefined });
  ms += performance.now() - t0;
  n++;
  if (eT.cameraMotion) camFrames++;
  if (L.hasMotion) motion++;
  if (L.stage2Passed) legacyFwd++;
  const tr = T.tracks ?? [];
  if (tr.length) anyTrack++;
  dump.push({ f, keep: tr.some(k => k.state === 'pass') ? 1 : 0, lenient: tr.some(k => k.state !== 'drop') ? 1 : 0, cam: eT.cameraMotion ? 1 : 0 });
  if (tr.some(k => k.state === 'pass')) trackPass++;
  if (tr.some(k => k.state !== 'drop')) trackLenient++;
  if (tr.some(k => k.state === 'drop')) anyDrop++;
  for (const k of tr) {
    const r = life.get(k.id) ?? { frames: 0, pass: 0, drop: 0, pend: 0 };
    if (k.state === 'drop') { const w = k.reason.split(' ')[0]; why[w] = (why[w] || 0) + 1; }
    r.frames++; if (k.state === 'pass') r.pass++; else if (k.state === 'drop') r.drop++; else r.pend++;
    life.set(k.id, r);
  }
  if (outDir && n % saveEvery === 0) {
    const out = new PNG({ width: p.width, height: p.height }); out.data = Buffer.from(p.data);
    for (const k of tr) rect(out.data as any, p.width, p.height, Math.round(k.box.x), Math.round(k.box.y), Math.round(k.box.width), Math.round(k.box.height),
      k.state === 'pass' ? [16, 185, 129] : k.state === 'drop' ? [244, 63, 94] : [148, 163, 184]);
    fs.writeFileSync(path.join(outDir, `ann_${String(n).padStart(5, '0')}.png`), PNG.sync.write(out));
  }
}
const pc = (a: number) => (100 * a / n).toFixed(1) + '%';
console.log(`frames ${n}  engine ${(ms / n).toFixed(2)} ms/frame (tracking mode)`);
console.log(`Stage 1 motion detected : ${pc(motion)}`);
console.log(`legacy single-box PASS   : ${pc(legacyFwd)}`);
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(dump));
console.log(`camera-motion frames: ${camFrames} (${pc(camFrames)})`);
console.log(`tracking: any KEEP track : ${pc(trackPass)}   keep-or-watching: ${pc(trackLenient)}   any TRASH track: ${pc(anyDrop)}`);
const long = [...life.entries()].filter(([, v]) => v.frames >= 20).sort((a, b) => b[1].frames - a[1].frames);
console.log('drop reasons (track-frames):', JSON.stringify(why));
console.log(`tracks total ${life.size}, lasting >=20 frames ${long.length}`);
{ const t = long.reduce((a, [, v]) => ({ f: a.f + v.frames, p: a.p + v.pass, d: a.d + v.drop }), { f: 0, p: 0, d: 0 });
  console.log(`in tracks lasting >=20 frames: keep ${(100 * t.p / (t.f || 1)).toFixed(1)}%  trash ${(100 * t.d / (t.f || 1)).toFixed(1)}% of track-frames`); }
for (const [id, v] of long.slice(0, 12)) console.log(`  #${id}: ${v.frames} frames  keep ${(100 * v.pass / v.frames).toFixed(0)}%  trash ${(100 * v.drop / v.frames).toFixed(0)}%  watching ${(100 * v.pend / v.frames).toFixed(0)}%`);
