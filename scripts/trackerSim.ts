// Headless synthetic-video check for the per-object tracker.
// Run: npx tsx scripts/trackerSim.ts
import { OpenCVOpticalFlowEngine } from '../src/utils/opencvAdapter';
import { DEFAULT_FILTER_PARAMS } from '../src/utils/motionSimulation';

const W = 320, H = 240;
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7;

// Spatially-correlated textures (box-blurred noise) look like real imagery; white noise makes
// block matching ambiguous and is not representative.
function smoothField(w: number, h: number, r: number, lo: number, hi: number, wrap: boolean): Uint8Array {
  const a = new Float32Array(w * h).map(() => rnd());
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let t = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      let yy = y + dy, xx = x + dx;
      if (wrap) { yy = (yy + h) % h; xx = (xx + w) % w; } else if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
      t += a[yy * w + xx]; n++;
    }
    o[y * w + x] = t / n;
  }
  let mn = 1e9, mx = -1e9; for (const v of o) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return Uint8Array.from(o, v => lo + ((v - mn) / (mx - mn)) * (hi - lo));
}
const tex = smoothField(256, 256, 3, 50, 210, true);
const bg = smoothField(W, H, 4, 90, 150, false);

interface Box { x: number; y: number; w: number; h: number }
type Scene = (t: number) => Box[];

function render(boxes: Box[], noise: number): ImageData {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const v = bg[i] + gauss() * noise; d[i*4]=v; d[i*4+1]=v; d[i*4+2]=v; d[i*4+3]=255; }
  for (const b of boxes) {
    const x0 = Math.max(0, Math.round(b.x)), y0 = Math.max(0, Math.round(b.y));
    const x1 = Math.min(W, Math.round(b.x + b.w)), y1 = Math.min(H, Math.round(b.y + b.h));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const v = tex[((y - Math.round(b.y)) & 255) * 256 + ((x - Math.round(b.x)) & 255)] + gauss() * noise;
      const i = (y * W + x) * 4; d[i]=v; d[i+1]=v; d[i+2]=v;
    }
  }
  return { data: d, width: W, height: H, colorSpace: 'srgb' } as ImageData;
}

const bounce = (p0: number, v: number, t: number, lo: number, hi: number) => {
  const span = hi - lo; let p = (p0 - lo + v * t) % (2 * span); if (p < 0) p += 2 * span;
  return lo + (p > span ? 2 * span - p : p);
};

const human = (t: number): Box => ({ x: bounce(30, 2.6, t, 0, W - 40), y: 70 + Math.sin(t * 0.5) * 1.2, w: 40, h: 90 });
let fx = 200, fy = 60;
const flutter = (_t: number): Box => { fx += (rnd() - 0.5) * 12; fy += (rnd() - 0.5) * 12; fx = Math.min(300, Math.max(150, fx)); fy = Math.min(200, Math.max(20, fy)); return { x: fx, y: fy, w: 14, h: 14 }; };
let cx = 100, cy = 120;
const cloth = (_t: number): Box => { cx += (rnd() - 0.5) * 22; cy += (rnd() - 0.5) * 22; cx = Math.min(240, Math.max(20, cx)); cy = Math.min(140, Math.max(20, cy)); const s = 1 + (rnd() - 0.5) * 0.7; return { x: cx, y: cy, w: 60 * s, h: 60 / s }; };
const vehicle = (t: number): Box => ({ x: bounce(10, 5, t, 0, W - 70), y: 150, w: 70, h: 35 });

const scenes: Record<string, Scene> = {
  human: t => [human(t)],
  vehicle: t => [vehicle(t)],
  flutter: t => [flutter(t)],
  cloth: t => [cloth(t)],
  'human+flutter': t => [human(t), flutter(t)],
  'vehicle+cloth': t => [vehicle(t), cloth(t)],
};

const FRAMES = 160;
const noiseLevels = [0];
const linkRadii = [1, 2];
const gate = {
  varianceThreshold: DEFAULT_FILTER_PARAMS.varianceThreshold,
  minNetDisplacement: DEFAULT_FILTER_PARAMS.minNetDisplacement,
  maxAspectDeformation: DEFAULT_FILTER_PARAMS.maxAspectDeformation,
  enableTemporal: DEFAULT_FILTER_PARAMS.enableTemporal,
  maxErraticScore: DEFAULT_FILTER_PARAMS.maxErraticScore,
  enableSizeGate: DEFAULT_FILTER_PARAMS.enableSizeGate,
  minAreaFrac: DEFAULT_FILTER_PARAMS.minAreaFrac,
  enableRigidity: DEFAULT_FILTER_PARAMS.enableRigidity,
  maxBBoxChaos: DEFAULT_FILTER_PARAMS.maxBBoxChaos,
};

const args = process.argv.slice(2);
const verbose = args.includes('-v');
for (const link of linkRadii) {
  for (const noise of noiseLevels) {
    console.log(`\n=== linkRadius ${link}, sensor noise σ=${noise} ===`);
    for (const [name, scene] of Object.entries(scenes)) {
      seed = 777; fx = 200; fy = 60; cx = 100; cy = 120;
      const eng = new OpenCVOpticalFlowEngine();
      const why: Record<string, number> = {};
      let pass = 0, drop = 0, pend = 0, maxTracks = 0, ids = new Set<number>(), t0 = performance.now();
      for (let t = 0; t < FRAMES; t++) {
        const res = eng.processFrame(render(scene(t), noise), 20, gate, { gate, linkRadius: link });
        const tr = res.tracks ?? [];
        maxTracks = Math.max(maxTracks, tr.length);
        for (const k of tr) {
          ids.add(k.id);
          if (t >= 30) { if (k.state === 'pass') pass++; else if (k.state === 'drop') { drop++; const r = k.reason.split(' ')[0]; why[r] = (why[r] || 0) + 1; } else pend++; }
          if (verbose && name === 'human' && noise === 0 && t >= 40 && t < 52) console.log(`  trace t=${t} truthCx=${(scene(t)[0].x + 20).toFixed(1)} boxCx=${(k.box.x + k.box.width / 2).toFixed(1)} w=${k.box.width.toFixed(0)}`);
          if (verbose && t % 20 === 0) console.log(`  t=${t} #${k.id} ${k.state} ${k.reason} box=${Math.round(k.box.width)}x${Math.round(k.box.height)} ${k.temporalScore.toFixed(2)}`);
        }
      }
      const ms = (performance.now() - t0) / FRAMES;
      const tot = pass + drop + pend || 1;
      console.log(`${name.padEnd(14)} pass ${(100*pass/tot).toFixed(0).padStart(3)}%  drop ${(100*drop/tot).toFixed(0).padStart(3)}%  pending ${(100*pend/tot).toFixed(0).padStart(3)}%  ids ${String(ids.size).padStart(3)}  maxTracks ${maxTracks}  ${ms.toFixed(2)} ms/frame(incl. render)  ${verbose ? JSON.stringify(why) : ''}`);
    }
  }
}
