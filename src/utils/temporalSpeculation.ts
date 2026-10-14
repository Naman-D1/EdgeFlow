// Temporal speculation: predict how a tracked object will move, and score
// how "predictable" (smooth) vs "erratic" its recent motion has been.
// Pure function over a position history, so it works for any tracker.

export interface TrackSample { x: number; y: number; w: number; h: number }

export type MotionClass =
  | 'warmup'             // not enough history yet
  | 'smooth_translating' // predictable AND going somewhere: person / vehicle-like
  | 'oscillating'        // predictable but going nowhere: foliage-like
  | 'erratic';           // unpredictable: insect / debris-like

export interface TemporalProfile {
  relPredError: number;  // 1-step constant-velocity error / mean step length (lower = smoother)
  turnRate: number;      // mean |heading change| per frame, rad (moving frames only)
  straightness: number;  // net displacement / path length, 0..1
  erraticScore: number;  // 0 = smooth .. 1 = erratic
  confidence: number;    // 1 - erraticScore: how far to trust `predicted`
  motionClass: MotionClass;
  predicted: { x: number; y: number }[]; // next `horizon` positions
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// NOTE: erraticCut was calibrated on the *simulator* (noiseless synthetic tracks).
// Real tracked-box centroids jitter, so real people will score higher; re-tune on real clips.
export function speculate(
  hist: TrackSample[],
  horizon = 10,
  opts: { minFrames: number; erraticCut: number; minStraight: number; noiseFloor?: number; linearFit?: boolean } =
    { minFrames: 8, erraticCut: 0.1, minStraight: 0.45 }
): TemporalProfile {
  // noiseFloor (px): expected measurement jitter of the position. 0 for noiseless tracks (simulator).
  // Real boxes flicker by a pixel or two, which would make slow smooth movers look erratic;
  // below the floor we cannot tell smooth from erratic, so we treat it as smooth (benefit of doubt).
  const floor = opts.noiseFloor ?? 0;
  const n = hist.length;
  if (n < opts.minFrames) {
    return { relPredError: 0, turnRate: 0, straightness: 1, erraticScore: 0.5,
             confidence: 0, motionClass: 'warmup', predicted: [] };
  }

  // per-frame steps
  const steps = [];
  for (let i = 1; i < n; i++) steps.push({ dx: hist[i].x - hist[i-1].x, dy: hist[i].y - hist[i-1].y });
  const stepLen = steps.map(s => Math.hypot(s.dx, s.dy));
  const meanStep = stepLen.reduce((a, b) => a + b, 0) / steps.length;

  // 1) one-step-ahead constant-velocity prediction error, relative to speed.
  //    Scale-free: a fast smooth mover and a slow smooth mover score alike.
  let errSum = 0;
  for (let i = 1; i < steps.length; i++) {
    errSum += Math.hypot(steps[i].dx - steps[i-1].dx, steps[i].dy - steps[i-1].dy);
  }
  // second difference of i.i.d. position noise σ has magnitude ≈ 2.4σ per step; remove that expectation
  const meanErr = Math.max(0, errSum / (steps.length - 1) - 2.4 * floor);
  const relPredError = meanErr / (meanStep + 1e-6);

  // 2) turn rate on frames that are actually moving
  const minMove = Math.max(0.15, 2 * floor); // px/frame; below the noise floor a heading is meaningless
  const turns: number[] = [];
  for (let i = 1; i < steps.length; i++) {
    if (stepLen[i] > minMove && stepLen[i-1] > minMove) {
      const a0 = Math.atan2(steps[i-1].dy, steps[i-1].dx);
      const a1 = Math.atan2(steps[i].dy, steps[i].dx);
      turns.push(Math.abs(Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))));
    }
  }
  const turnRate = turns.length ? turns.reduce((a, b) => a + b, 0) / turns.length : 0;

  // 3) straightness
  const path = stepLen.reduce((a, b) => a + b, 0);
  const net = Math.hypot(hist[n-1].x - hist[0].x, hist[n-1].y - hist[0].y);
  const straightness = path > 0 ? Math.min(1, net / path) : 0;

  // combine: prediction error and turning drive the score
  let sPred = clamp01((relPredError - 0.05) / 0.45);
  if (opts.linearFit) {
    // Windowed straight-line fit. One-step prediction error amplifies box jitter (a second difference
    // of noisy positions); the residual of a line fitted over the whole window averages it out, while
    // real erratic motion still leaves a large residual relative to how far the object actually went.
    const w = Math.min(n, 16), h0 = n - w;
    let mt = 0, mx = 0, my = 0;
    for (let i = 0; i < w; i++) { mt += i; mx += hist[h0 + i].x; my += hist[h0 + i].y; }
    mt /= w; mx /= w; my /= w;
    let stt = 0, stx = 0, sty = 0;
    for (let i = 0; i < w; i++) { stt += (i - mt) ** 2; stx += (i - mt) * (hist[h0 + i].x - mx); sty += (i - mt) * (hist[h0 + i].y - my); }
    const bx = stx / stt, by = sty / stt;
    let ss = 0;
    for (let i = 0; i < w; i++) ss += (hist[h0 + i].x - (mx + bx * (i - mt))) ** 2 + (hist[h0 + i].y - (my + by * (i - mt))) ** 2;
    const rms = Math.max(0, Math.sqrt(ss / w) - 0.5 * floor);
    const disp = Math.hypot(bx, by) * (w - 1);
    sPred = clamp01((rms / (disp + 2 * floor + 1e-6) - 0.1) / 0.4);
  }
  const sTurn = clamp01(turnRate / 0.8);
  const erraticScore = 0.65 * sPred + 0.35 * sTurn;

  let motionClass: MotionClass;
  if (erraticScore >= opts.erraticCut) motionClass = 'erratic';
  else if (straightness >= opts.minStraight) motionClass = 'smooth_translating';
  else motionClass = 'oscillating';

  // speculate: damped constant-velocity from the last 3 steps; damping grows
  // with the erratic score so uncertain tracks "fade" toward standing still
  const k = Math.min(3, steps.length);
  let vx = 0, vy = 0;
  for (let i = steps.length - k; i < steps.length; i++) { vx += steps[i].dx / k; vy += steps[i].dy / k; }
  const damp = 1 - 0.5 * erraticScore;
  const predicted: { x: number; y: number }[] = [];
  let px = hist[n-1].x, py = hist[n-1].y;
  for (let i = 0; i < horizon; i++) {
    vx *= damp; vy *= damp; px += vx; py += vy;
    predicted.push({ x: px, y: py });
  }

  return { relPredError, turnRate, straightness, erraticScore,
           confidence: 1 - erraticScore, motionClass, predicted };
}
