// Per-object tracking for the live path.
//
// The live engine used to collapse everything that moved into ONE bounding box, so a person
// and a bag in the same frame became a single object. This module:
//   1. groups active macroblocks into blobs (union-find over the macroblock grid),
//   2. matches blobs to tracks using each track's own predicted position,
//   3. keeps a per-track box history and runs the same Stage 2 gates as the simulator
//      (legacy vector checks + v2 temporal predictability + v2.1 size/rigidity),
//   4. applies vote hysteresis so one noisy frame can't flip a track.
//
// Design rule from the project goal: only drop what we are CONFIDENT is trash. Anything
// uncertain (too little history, ambiguous votes) is never reported as a drop.
//
// Pure TypeScript; no canvas/OpenCV dependency, so it can be tested headlessly.

import { speculate, MotionClass, TrackSample } from './temporalSpeculation';
import { analyzeBBox, BBoxVerdict } from './bboxStability';
import type { FilterParameters } from '../types/pipeline';

// ───────────────────────── macroblock grid (filled by the engine) ─────────────────────────

export interface CellGrid {
  cols: number;
  rows: number;
  blockSize: number;
  active: Uint8Array;   // 1 if the cell has a motion vector
  vdx: Float32Array;    // vector per cell
  vdy: Float32Array;
  count: Int32Array;    // changed pixels in the cell
  minX: Int32Array;     // pixel extents of changed pixels in the cell
  maxX: Int32Array;
  minY: Int32Array;
  maxY: Int32Array;
  sumX: Float64Array;   // for mass centroid
  sumY: Float64Array;
}

export function createGrid(cols: number, rows: number, blockSize: number): CellGrid {
  const n = cols * rows;
  const g: CellGrid = {
    cols, rows, blockSize,
    active: new Uint8Array(n),
    vdx: new Float32Array(n), vdy: new Float32Array(n),
    count: new Int32Array(n),
    minX: new Int32Array(n), maxX: new Int32Array(n),
    minY: new Int32Array(n), maxY: new Int32Array(n),
    sumX: new Float64Array(n), sumY: new Float64Array(n),
  };
  resetGrid(g);
  return g;
}

export function resetGrid(g: CellGrid): void {
  g.active.fill(0);
  g.vdx.fill(0); g.vdy.fill(0);
  g.count.fill(0);
  g.minX.fill(1 << 30); g.minY.fill(1 << 30);
  g.maxX.fill(-1); g.maxY.fill(-1);
  g.sumX.fill(0); g.sumY.fill(0);
}

// ───────────────────────── blob extraction ─────────────────────────

export interface BlobObs {
  x: number; y: number; w: number; h: number; // pixel bbox (top-left + size)
  cx: number; cy: number;                     // bbox center
  mx: number; my: number;                     // changed-pixel centroid
  mass: number;                               // changed pixels
  cells: number;
  vectors: { dx: number; dy: number }[];
}

export interface BlobOptions {
  linkRadius: number;     // cells; clusters within this Chebyshev distance are one blob
  minCellPixels: number;  // a cell needs this many changed pixels to contribute to the bbox
}

export const DEFAULT_BLOB_OPTS: BlobOptions = { linkRadius: 1, minCellPixels: 3 };

// Frame differencing outlines a moving object (leading + trailing edge) instead of filling it,
// so a large object appears as several separate clusters of cells. linkRadius bridges those gaps.
export function extractBlobs(g: CellGrid, opts: Partial<BlobOptions> = {}): BlobObs[] {
  const o: BlobOptions = {
    linkRadius: opts.linkRadius ?? DEFAULT_BLOB_OPTS.linkRadius,
    minCellPixels: opts.minCellPixels ?? DEFAULT_BLOB_OPTS.minCellPixels,
  };
  const { cols, rows, blockSize } = g;
  const n = cols * rows;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };

  const R = o.linkRadius;
  let anyActive = false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!g.active[i]) continue;
      anyActive = true;
      // forward half-neighbourhood only (each pair examined once)
      for (let dr = 0; dr <= R; dr++) {
        for (let dc = -R; dc <= R; dc++) {
          if (dr === 0 && dc <= 0) continue;
          const rr = r + dr, cc = c + dc;
          if (rr >= rows || cc < 0 || cc >= cols) continue;
          const j = rr * cols + cc;
          if (!g.active[j]) continue;
          const a = find(i), b = find(j);
          if (a !== b) parent[a] = b;
        }
      }
    }
  }
  if (!anyActive) return [];

  interface Acc {
    x0: number; y0: number; x1: number; y1: number; // pixel extents (qualifying cells)
    cx0: number; cy0: number; cx1: number; cy1: number; // cell rectangles (fallback)
    mass: number; sx: number; sy: number; cells: number;
    vectors: { dx: number; dy: number }[];
  }
  const accs = new Map<number, Acc>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!g.active[i]) continue;
      const root = find(i);
      let a = accs.get(root);
      if (!a) {
        a = { x0: 1 << 30, y0: 1 << 30, x1: -1, y1: -1, cx0: 1 << 30, cy0: 1 << 30, cx1: -1, cy1: -1,
              mass: 0, sx: 0, sy: 0, cells: 0, vectors: [] };
        accs.set(root, a);
      }
      a.cells++;
      a.vectors.push({ dx: g.vdx[i], dy: g.vdy[i] });
      a.cx0 = Math.min(a.cx0, c * blockSize); a.cy0 = Math.min(a.cy0, r * blockSize);
      a.cx1 = Math.max(a.cx1, (c + 1) * blockSize); a.cy1 = Math.max(a.cy1, (r + 1) * blockSize);
      if (g.count[i] >= o.minCellPixels) {
        a.x0 = Math.min(a.x0, g.minX[i]); a.y0 = Math.min(a.y0, g.minY[i]);
        a.x1 = Math.max(a.x1, g.maxX[i]); a.y1 = Math.max(a.y1, g.maxY[i]);
        a.mass += g.count[i]; a.sx += g.sumX[i]; a.sy += g.sumY[i];
      }
    }
  }

  const blobs: BlobObs[] = [];
  for (const a of accs.values()) {
    const hasPx = a.x1 >= 0;
    const x0 = hasPx ? a.x0 : a.cx0, y0 = hasPx ? a.y0 : a.cy0;
    const x1 = hasPx ? a.x1 : a.cx1, y1 = hasPx ? a.y1 : a.cy1;
    const w = Math.max(1, x1 - x0 + 1), h = Math.max(1, y1 - y0 + 1);
    const cx = x0 + w / 2, cy = y0 + h / 2;
    blobs.push({
      x: x0, y: y0, w, h, cx, cy,
      mx: a.mass > 0 ? a.sx / a.mass : cx, my: a.mass > 0 ? a.sy / a.mass : cy,
      mass: a.mass, cells: a.cells, vectors: a.vectors,
    });
  }
  return blobs;
}

// ───────────────────────── legacy per-blob vector statistics ─────────────────────────
// Same definitions as the original single-box engine, applied to ONE blob's vectors.

export function vectorStats(vs: { dx: number; dy: number }[]): { variance: number; netRatio: number } | null {
  if (vs.length < 2) return null; // too few vectors to say anything: callers treat this as "no evidence"
  let sumVx = 0, sumVy = 0, sumMag = 0, sumSin = 0, sumCos = 0;
  const ang: number[] = [];
  for (const v of vs) {
    const mag = Math.hypot(v.dx, v.dy);
    sumVx += v.dx; sumVy += v.dy; sumMag += mag;
    const a = Math.atan2(v.dy, v.dx);
    ang.push(a); sumSin += Math.sin(a); sumCos += Math.cos(a);
  }
  const meanAngle = Math.atan2(sumSin, sumCos);
  let s = 0;
  for (const a of ang) {
    let d = Math.abs(a - meanAngle);
    if (d > Math.PI) d = 2 * Math.PI - d;
    s += d * d;
  }
  const radVar = s / ang.length;
  return {
    variance: (radVar * (180 / Math.PI) * (180 / Math.PI)) / 100,
    netRatio: sumMag > 0 ? Math.min(1, Math.hypot(sumVx, sumVy) / sumMag) : 0,
  };
}

// ───────────────────────── tracker ─────────────────────────

export type TrackGateParams = Pick<
  FilterParameters,
  | 'varianceThreshold' | 'minNetDisplacement' | 'maxAspectDeformation'
  | 'enableTemporal' | 'maxErraticScore'
  | 'enableSizeGate' | 'minAreaFrac'
  | 'enableRigidity' | 'maxBBoxChaos'
>;

export type TrackState = 'pending' | 'pass' | 'drop';

export interface TrackReport {
  id: number;
  state: TrackState;
  reason: string;
  box: { x: number; y: number; width: number; height: number };
  age: number;               // frames since birth
  coasting: boolean;         // no blob matched this frame (position is predicted)
  vectorVariance: number;
  netDisplacementRatio: number;
  aspectDeformation: number;
  temporalScore: number;
  temporalClass: MotionClass;
  bboxChaos: number;
  bboxVerdict: BBoxVerdict;
  areaFrac: number;
  predicted: { x: number; y: number }[];
}

export interface TrackerOptions {
  maxHistory: number;   // samples kept per track (matches the simulator)
  maxCoast: number;     // frames a track may go unmatched before it is deleted
  confirmFrames: number; // history needed before a track may be reported pass/drop
  gateScale: number;    // association gate = max(1.5 blocks, gateScale * largest box side)
  voteWindow: number;   // frames of per-frame verdicts that vote
  dropEnter: number;    // drop votes (of voteWindow) needed to start dropping a track
  dropLeave: number;    // at or below this many drop votes a dropped track passes again
  center: 'bbox' | 'mass';
  horizon: number;      // frames of speculated path
  mergeRatio: number;   // a blob whose area differs from the track's last box by more than this factor is a suspected merge/split (0 = off)
  suspectMax: number;   // frames a suspected merge/split is held back before the new size is accepted as real
  smoothAlpha: number;  // 1 = use the measured box as is; <1 blends measurement with the prediction (alpha-beta style)
  linearFit: boolean;   // temporal gate uses a windowed line-fit residual instead of one-step prediction error
  noiseFloor: number;   // px of box-position jitter the temporal gate ignores (edge flicker, quantisation)
}

export const DEFAULT_TRACKER_OPTS: TrackerOptions = {
  maxHistory: 24, maxCoast: 6, confirmFrames: 8, gateScale: 0.75,
  voteWindow: 5, dropEnter: 4, dropLeave: 2, center: 'bbox', horizon: 12, noiseFloor: 4, linearFit: false,
  mergeRatio: 1.3, suspectMax: 6, smoothAlpha: 0.85,
};

interface Track {
  id: number;
  hist: TrackSample[];
  age: number;
  misses: number;
  votes: boolean[];            // true = this frame said "drop"
  suspect: number;             // consecutive frames the measured blob looked like a merge/split
  state: TrackState;
  reason: string;
  lastDropReason: string;
  prevAR: number | null;
  metrics: {
    vectorVariance: number; netRatio: number; aspectDef: number;
    temporalScore: number; temporalClass: MotionClass; chaos: number; bboxVerdict: BBoxVerdict;
    areaFrac: number; predicted: { x: number; y: number }[];
  };
}

export class BlobTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  public opts: TrackerOptions;

  constructor(opts: Partial<TrackerOptions> = {}) {
    this.opts = { ...DEFAULT_TRACKER_OPTS, ...opts };
  }

  public reset(): void { this.tracks = []; this.nextId = 1; }

  private predictNext(t: Track): { x: number; y: number } {
    const h = t.hist, n = h.length;
    const last = h[n - 1];
    if (n < 2) return { x: last.x, y: last.y };
    const k = Math.min(3, n - 1);
    let vx = 0, vy = 0;
    for (let i = n - k; i < n; i++) { vx += (h[i].x - h[i - 1].x) / k; vy += (h[i].y - h[i - 1].y) / k; }
    return { x: last.x + vx, y: last.y + vy };
  }

  public update(
    blobs: BlobObs[], gate: TrackGateParams, frameArea: number, blockSize: number
  ): TrackReport[] {
    const o = this.opts;
    const pos = (b: BlobObs) => (o.center === 'mass' ? { x: b.mx, y: b.my } : { x: b.cx, y: b.cy });

    // ── associate: greedy nearest-to-prediction, gated per pair
    const pairs: { ti: number; bi: number; d: number }[] = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      const p = this.predictNext(t);
      const last = t.hist[t.hist.length - 1];
      for (let bi = 0; bi < blobs.length; bi++) {
        const b = blobs[bi], bp = pos(b);
        const d = Math.hypot(bp.x - p.x, bp.y - p.y);
        const gateR = Math.max(1.5 * blockSize, o.gateScale * Math.max(last.w, last.h, b.w, b.h));
        if (d <= gateR) pairs.push({ ti, bi, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const tUsed = new Set<number>(), bUsed = new Set<number>();
    const matched = new Map<number, number>(); // ti -> bi
    for (const p of pairs) {
      if (tUsed.has(p.ti) || bUsed.has(p.bi)) continue;
      tUsed.add(p.ti); bUsed.add(p.bi); matched.set(p.ti, p.bi);
    }

    // ── update matched tracks, coast the rest
    const reports: TrackReport[] = [];
    const survivors: Track[] = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      const bi = matched.get(ti);
      if (bi !== undefined) {
        const b = blobs[bi], bp = pos(b);
        t.misses = 0; t.age++;
        const last = t.hist[t.hist.length - 1];
        const ratio = (b.w * b.h) / Math.max(1, last.w * last.h);
        let suspected = o.mergeRatio > 0 && t.hist.length >= 3 && (ratio > o.mergeRatio || ratio < 1 / o.mergeRatio);
        if (suspected) {
          // A merge or split needs company: another track that just lost its blob, or a new unmatched
          // blob, close by. A lone object whose size swings (tumbling debris) is deformation, not a merge.
          const reach = 2 * Math.max(1.5 * blockSize, o.gateScale * Math.max(last.w, last.h, b.w, b.h));
          let neighbour = false;
          for (let tj = 0; tj < this.tracks.length && !neighbour; tj++) {
            if (tj === ti || matched.has(tj)) continue;
            const q = this.tracks[tj].hist[this.tracks[tj].hist.length - 1];
            if (Math.hypot(q.x - bp.x, q.y - bp.y) <= reach) neighbour = true;
          }
          for (let bj = 0; bj < blobs.length && !neighbour; bj++) {
            if (bj === bi || bUsed.has(bj)) continue;
            const q = pos(blobs[bj]);
            if (Math.hypot(q.x - bp.x, q.y - bp.y) <= reach) neighbour = true;
          }
          suspected = neighbour;
        }
        if (suspected && t.suspect < o.suspectMax) {
          // Probable merge with / split from another object: the measured centre and size describe a
          // different thing, so hold the old size, follow the prediction, and do not let this frame vote.
          t.suspect++;
          const p = this.predictNext(t);
          this.push(t, { x: p.x, y: p.y, w: last.w, h: last.h });
          this.evaluate(t, b, gate, frameArea, blockSize, true);
        } else {
          t.suspect = 0;
          let sample = { x: bp.x, y: bp.y, w: b.w, h: b.h };
          if (o.smoothAlpha < 1 && t.hist.length >= 2) {
            const p = this.predictNext(t), a = o.smoothAlpha;
            sample = { x: p.x + a * (bp.x - p.x), y: p.y + a * (bp.y - p.y), w: last.w + a * (b.w - last.w), h: last.h + a * (b.h - last.h) };
          }
          this.push(t, sample);
          this.evaluate(t, b, gate, frameArea, blockSize);
        }
        survivors.push(t);
        reports.push(this.report(t, false));
      } else {
        t.misses++; t.age++;
        if (t.misses > o.maxCoast) continue; // lost: delete
        // coast on the prediction so the history keeps uniform frame spacing
        const p = this.predictNext(t), last = t.hist[t.hist.length - 1];
        this.push(t, { x: p.x, y: p.y, w: last.w, h: last.h });
        survivors.push(t);
        if (t.misses <= 2) reports.push(this.report(t, true)); // brief coast stays visible, then hides
      }
    }

    // ── births
    for (let bi = 0; bi < blobs.length; bi++) {
      if (bUsed.has(bi)) continue;
      const b = blobs[bi], bp = pos(b);
      const t: Track = {
        id: this.nextId++, hist: [], age: 1, misses: 0, suspect: 0, votes: [], state: 'pending',
        reason: 'PENDING (building trajectory history)', lastDropReason: '', prevAR: null,
        metrics: { vectorVariance: 0, netRatio: 1, aspectDef: 0, temporalScore: 0, temporalClass: 'warmup',
                   chaos: 0, bboxVerdict: 'warmup', areaFrac: 0, predicted: [] },
      };
      this.push(t, { x: bp.x, y: bp.y, w: b.w, h: b.h });
      this.evaluate(t, b, gate, frameArea, blockSize);
      survivors.push(t);
      reports.push(this.report(t, false));
    }

    this.tracks = survivors;
    return reports;
  }

  private push(t: Track, s: TrackSample): void {
    t.hist.push(s);
    if (t.hist.length > this.opts.maxHistory) t.hist.shift();
  }

  private evaluate(t: Track, b: BlobObs, gate: TrackGateParams, frameArea: number, blockSize: number, noVote = false): void {
    const o = this.opts, m = t.metrics;

    // legacy Stage 2 checks, on this blob only (no evidence -> no drop)
    const vs = noVote ? null : vectorStats(b.vectors);
    m.vectorVariance = vs ? vs.variance : 0;
    m.netRatio = vs ? vs.netRatio : 1;
    const ar = Math.max(blockSize, b.w) / Math.max(blockSize, b.h);
    m.aspectDef = noVote || t.prevAR === null ? 0 : Math.abs(ar - t.prevAR);
    if (!noVote) t.prevAR = ar;

    // windowed gates over this track's own history
    const temporal = speculate(t.hist, o.horizon, {
      minFrames: 8, erraticCut: gate.maxErraticScore, minStraight: 0.45, noiseFloor: o.noiseFloor, linearFit: o.linearFit,
    });
    m.temporalScore = temporal.erraticScore;
    m.temporalClass = temporal.motionClass;
    m.predicted = gate.enableTemporal ? temporal.predicted : [];
    const bb = analyzeBBox(t.hist.map((s) => ({ w: s.w, h: s.h })), frameArea, {
      minAreaFrac: gate.minAreaFrac, chaoticMin: gate.maxBBoxChaos,
    });
    m.chaos = bb.chaosScore; m.bboxVerdict = bb.verdict; m.areaFrac = bb.areaFrac;

    // per-frame verdict, same order as the simulator
    let drop = false, reason = '';
    if (vs && !(vs.variance < gate.varianceThreshold * 1.6)) {
      drop = true; reason = `ERRATIC_ANGULAR_SHIFT (Var ${vs.variance.toFixed(1)} > max ${gate.varianceThreshold})`;
    } else if (vs && !(vs.netRatio >= gate.minNetDisplacement)) {
      drop = true; reason = `ZERO_NET_DISPLACEMENT (${(vs.netRatio * 100).toFixed(0)}% < min ${(gate.minNetDisplacement * 100).toFixed(0)}%)`;
    } else if (!(m.aspectDef <= gate.maxAspectDeformation)) {
      drop = true; reason = `CHAOTIC_DEFORMATION (ΔAR ${m.aspectDef.toFixed(2)} > max ${gate.maxAspectDeformation.toFixed(2)})`;
    } else if (gate.enableTemporal && temporal.motionClass === 'erratic') {
      drop = true; reason = `UNPREDICTABLE_TRAJECTORY (Temporal ${temporal.erraticScore.toFixed(2)} > max ${gate.maxErraticScore.toFixed(2)})`;
    } else if (gate.enableSizeGate && bb.verdict !== 'warmup' && bb.areaFrac < gate.minAreaFrac) {
      drop = true; reason = `BELOW_MIN_SIZE (${(bb.areaFrac * 100).toFixed(2)}% of frame < ${(gate.minAreaFrac * 100).toFixed(2)}%)`;
    } else if (gate.enableRigidity && bb.verdict !== 'warmup' && bb.chaosScore >= gate.maxBBoxChaos) {
      drop = true; reason = `UNSTABLE_BBOX_GEOMETRY (Chaos ${bb.chaosScore.toFixed(2)} > max ${gate.maxBBoxChaos.toFixed(2)})`;
    }

    // vote hysteresis: asymmetric on purpose, so uncertainty resolves to PASS
    if (!noVote) {
      t.votes.push(drop);
      if (t.votes.length > o.voteWindow) t.votes.shift();
      if (drop) t.lastDropReason = reason;
    }
    const drops = t.votes.reduce((a, v) => a + (v ? 1 : 0), 0);
    const full = t.votes.length >= o.voteWindow;

    if (t.hist.length < o.confirmFrames) {
      t.state = 'pending';
      t.reason = `PENDING (${t.hist.length}/${o.confirmFrames} frames of history)`;
    } else if (t.state === 'pending') {
      t.state = full && drops >= o.dropEnter ? 'drop' : 'pass';
    } else if (t.state === 'pass' && full && drops >= o.dropEnter) {
      t.state = 'drop';
    } else if (t.state === 'drop' && drops <= o.dropLeave) {
      t.state = 'pass';
    }
    if (t.state === 'drop') t.reason = t.lastDropReason;
    else if (t.state === 'pass') t.reason = 'PASSED_STAGE_2 (not confidently trash)';
  }

  private report(t: Track, coasting: boolean): TrackReport {
    const s = t.hist[t.hist.length - 1], m = t.metrics;
    return {
      id: t.id, state: t.state, reason: t.reason,
      box: { x: s.x - s.w / 2, y: s.y - s.h / 2, width: s.w, height: s.h },
      age: t.age, coasting,
      vectorVariance: m.vectorVariance, netDisplacementRatio: m.netRatio, aspectDeformation: m.aspectDef,
      temporalScore: m.temporalScore, temporalClass: m.temporalClass,
      bboxChaos: m.chaos, bboxVerdict: m.bboxVerdict, areaFrac: m.areaFrac,
      predicted: m.predicted,
    };
  }
}
