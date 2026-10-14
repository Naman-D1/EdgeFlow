// BBox rigidity & geometric stability: a second verification layer.
// Asks two questions about a track's bounding-box history:
//   1. Is it big enough to matter?                (size gate)
//   2. Does its box hold a stable shape over time? (rigidity)
//
// Rigidity is measured on the *detrended* log-geometry. A car driving toward the
// camera grows steadily; that slow, systematic drift is removed before measuring,
// so only wobble around the trend counts as instability.

export interface BoxSample { w: number; h: number }

export type BBoxVerdict = 'warmup' | 'too_small' | 'rigid' | 'flexing' | 'chaotic';

export interface BBoxProfile {
  meanArea: number;     // px^2, mean over window
  areaFrac: number;     // meanArea / frameArea
  areaJitter: number;   // RMS of detrended log(area)
  arJitter: number;     // RMS of detrended log(w/h)
  scaleDrift: number;   // slope of log(area) per frame (systematic growth/shrink)
  chaosScore: number;   // 0 = perfectly stable box .. 1 = chaotic
  verdict: BBoxVerdict;
}

export interface BBoxOptions {
  minFrames: number;
  minAreaFrac: number;  // below this fraction of the frame -> too_small
  rigidMax: number;     // chaosScore below this -> rigid
  chaoticMin: number;   // chaosScore at/above this -> chaotic (between = flexing)
}

export const DEFAULT_BBOX_OPTS: BBoxOptions = {
  minFrames: 8,
  minAreaFrac: 0.001,
  rigidMax: 0.03,
  chaoticMin: 0.2,  // between big-arm-swing humans (~0.14-0.17) and crumpling debris (~0.23+); see notes
};

// RMS of residual after removing a least-squares line; also returns the slope.
function detrendedRms(y: number[]): { rms: number; slope: number } {
  const n = y.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
  const den = n * sxx - sx * sx;
  const slope = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  const icpt = (sy - slope * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const r = y[i] - (icpt + slope * i); ss += r * r; }
  return { rms: Math.sqrt(ss / n), slope };
}

export function analyzeBBox(
  boxes: BoxSample[],
  frameArea: number,
  opts: Partial<BBoxOptions> = {}
): BBoxProfile {
  const o = { ...DEFAULT_BBOX_OPTS, ...opts };
  if (boxes.length < o.minFrames) {
    return { meanArea: 0, areaFrac: 0, areaJitter: 0, arJitter: 0, scaleDrift: 0,
             chaosScore: 0, verdict: 'warmup' };
  }
  const logA = boxes.map(b => Math.log(Math.max(1, b.w * b.h)));
  const logAR = boxes.map(b => Math.log(Math.max(1, b.w) / Math.max(1, b.h)));
  const meanArea = boxes.reduce((a, b) => a + b.w * b.h, 0) / boxes.length;

  const a = detrendedRms(logA);
  const r = detrendedRms(logAR);

  // Area jitter and shape (aspect) jitter weighted equally. Both in log units, so a
  // 10% wobble means the same for a small box and a large one.
  const chaosScore = 0.5 * a.rms + 0.5 * r.rms;
  const areaFrac = meanArea / frameArea;

  let verdict: BBoxVerdict;
  if (areaFrac < o.minAreaFrac) verdict = 'too_small';
  else if (chaosScore >= o.chaoticMin) verdict = 'chaotic';
  else if (chaosScore < o.rigidMax) verdict = 'rigid';
  else verdict = 'flexing';

  return { meanArea, areaFrac, areaJitter: a.rms, arJitter: r.rms, scaleDrift: a.slope,
           chaosScore, verdict };
}
