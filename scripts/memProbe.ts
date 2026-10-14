// Memory/time probe for the engine itself (not the PNG loading): npx tsx --expose-gc scripts/memProbe.ts <framesDir>
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { OpenCVOpticalFlowEngine } from '../src/utils/opencvAdapter';
import { DEFAULT_FILTER_PARAMS as G } from '../src/utils/motionSimulation';
const { PNG } = createRequire(import.meta.url)('pngjs');
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort().slice(0, 600);
const imgs = files.map(f => { const p = PNG.sync.read(fs.readFileSync(path.join(dir, f))); return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height, colorSpace: 'srgb' } as ImageData; });
const gc = (globalThis as any).gc as () => void;
gc(); const m0 = process.memoryUsage();
const e = new OpenCVOpticalFlowEngine();
const th = { varianceThreshold: G.varianceThreshold, minNetDisplacement: G.minNetDisplacement, maxAspectDeformation: G.maxAspectDeformation };
let peak = 0; const t0 = performance.now();
for (const im of imgs) { e.processFrame(im, 20, th, { gate: G }); const u = process.memoryUsage(); peak = Math.max(peak, u.heapUsed + u.arrayBuffers); }
const ms = (performance.now() - t0) / imgs.length;
gc(); const m1 = process.memoryUsage();
const kb = (x: number) => (x / 1024).toFixed(0) + ' KB';
console.log(`frame ${imgs[0].width}x${imgs[0].height}, ${imgs.length} frames`);
console.log(`engine state kept: heap ${kb(m1.heapUsed - m0.heapUsed)} + buffers ${kb(m1.arrayBuffers - m0.arrayBuffers)}`);
console.log(`peak during run (heap+buffers, above start): ${kb(peak - (m0.heapUsed + m0.arrayBuffers))}  (includes the ${imgs.length} preloaded input frames of ${kb(imgs.length * imgs[0].width * imgs[0].height * 4)})`);
console.log(`time ${ms.toFixed(2)} ms/frame; one raw RGBA frame = ${kb(imgs[0].width * imgs[0].height * 4)}`);
