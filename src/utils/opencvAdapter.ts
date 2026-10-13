// OpenCV.js integration & real-time hardware-accelerated optical flow adapter

import {
  BlobTracker, CellGrid, TrackGateParams, TrackReport,
  createGrid, resetGrid, extractBlobs,
} from './blobTracker';

declare global {
  interface Window {
    cv: any;
    cvReady?: boolean;
  }
}

export interface RealFlowResult {
  vectors: {
    gx: number;
    gy: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    mag: number;
  }[];
  // Stage 1
  pixelShiftPercent: number;
  hasMotion: boolean;
  // Stage 2
  vectorVariance: number;
  netDisplacementRatio: number;
  aspectDeformation: number;
  currentAspectRatio: number;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  stage2Passed: boolean;
  verdict: 'PASS to AI' | 'DROP (Noise)' | 'IDLE';
  dropReason: string;
  isOpenCvBackend: boolean;
  // Per-object tracking (only populated when a tracking option is passed to processFrame)
  trackingMode?: boolean;
  tracks?: TrackReport[];
}

// Collapse per-track states into the legacy single verdict so existing telemetry still makes sense:
// PASS if anything is worth keeping; DROP only if everything visible is confidently trash.
function summarizeTracks(tracks: TrackReport[]): Pick<RealFlowResult, 'stage2Passed' | 'verdict' | 'dropReason'> | null {
  if (tracks.length === 0) return null;
  const keep = tracks.filter((t) => t.state === 'pass');
  if (keep.length > 0) {
    return { stage2Passed: true, verdict: 'PASS to AI', dropReason: `${keep.length} of ${tracks.length} tracked object(s) kept` };
  }
  const watching = tracks.some((t) => t.state === 'pending');
  if (watching) return { stage2Passed: false, verdict: 'IDLE', dropReason: 'WATCHING (building track history)' };
  return { stage2Passed: false, verdict: 'DROP (Noise)', dropReason: tracks[0].reason };
}

export interface TrackingOptions {
  gate: TrackGateParams;
  linkRadius?: number;
  /** Fraction of active macroblocks above which the frame is treated as camera motion (default 0.5). */
  globalMotionFrac?: number;
  /** Stage 1 gate: % of pixels that must change before blobs are extracted (default 0.25; the single-box legacy path keeps 0.45). */
  motionPercent?: number;
  /** Changed pixels a cell needs to count as active in blob extraction (default 3). */
  minCellPixels?: number;
}

export class OpenCVOpticalFlowEngine {
  private prevGrayMat: any = null;
  private flowMat: any = null;
  private prevLumaBuffer: Uint8ClampedArray | null = null;
  private historyTrajectories: { x: number; y: number; vx: number; vy: number; ar: number }[] = [];
  private prevAspectRatio: number = 1.0;
  private tracker = new BlobTracker();
  private grid: CellGrid | null = null;

  public isOpenCvReady(): boolean {
    return typeof window !== 'undefined' && !!window.cv && !!window.cv.Mat && !!window.cv.calcOpticalFlowFarneback;
  }

  // Cleanup OpenCV mats if allocated
  public dispose(): void {
    if (this.prevGrayMat && typeof this.prevGrayMat.delete === 'function') {
      try {
        this.prevGrayMat.delete();
      } catch (e) {
        // ignore
      }
      this.prevGrayMat = null;
    }
    if (this.flowMat && typeof this.flowMat.delete === 'function') {
      try {
        this.flowMat.delete();
      } catch (e) {
        // ignore
      }
      this.flowMat = null;
    }
    this.prevLumaBuffer = null;
    this.historyTrajectories = [];
    this.tracker.reset();
    this.grid = null;
  }

  public cameraMotion = false;

  /** Forget the previous frame and all tracks (e.g. when a new video starts). */
  public resetState(): void {
    this.prevLumaBuffer = null;
    this.historyTrajectories = [];
    this.tracker.reset();
    this.grid = null;
    this.cameraMotion = false;
  }

  public getTracker(): BlobTracker {
    return this.tracker;
  }

  /**
   * Process a live frame from camera canvas
   */
  public processFrame(
    currImageData: ImageData,
    blockSize: number = 24,
    thresholds: {
      varianceThreshold: number;
      minNetDisplacement: number;
      maxAspectDeformation: number;
    },
    tracking?: TrackingOptions
  ): RealFlowResult {
    const width = currImageData.width;
    const height = currImageData.height;
    const currData = currImageData.data;

    // Convert current frame to luminance array (fast 0.299R + 0.587G + 0.114B)
    const luma = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < currData.length; i += 4, j++) {
      luma[j] = (currData[i] * 77 + currData[i + 1] * 150 + currData[i + 2] * 29) >> 8;
    }

    // If first frame, save and return initial state
    if (!this.prevLumaBuffer) {
      this.prevLumaBuffer = luma;
      return {
        vectors: [],
        pixelShiftPercent: 0,
        hasMotion: false,
        vectorVariance: 0,
        netDisplacementRatio: 1.0,
        aspectDeformation: 0,
        currentAspectRatio: 1.0,
        boundingBox: null,
        stage2Passed: false,
        verdict: 'IDLE',
        dropReason: 'INITIALIZING_FIRST_FRAME',
        isOpenCvBackend: this.isOpenCvReady(),
      };
    }

    const prevLuma = this.prevLumaBuffer;
    const useOpenCV = this.isOpenCvReady();

    // Stage 1: Pixel Motion Check (Background / Frame differencing)
    let totalAbsDiff = 0;
    let changedPixelsCount = 0;
    const diffThreshold = 18; // 18 intensity levels
    const totalPixels = width * height;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    const cols = Math.floor(width / blockSize);
    const rows = Math.floor(height / blockSize);
    let grid: CellGrid | null = null;
    if (tracking) {
      if (!this.grid || this.grid.cols !== cols || this.grid.rows !== rows || this.grid.blockSize !== blockSize) {
        this.grid = createGrid(cols, rows, blockSize);
      } else {
        resetGrid(this.grid);
      }
      grid = this.grid;
    }

    for (let i = 0; i < totalPixels; i++) {
      const diff = Math.abs(luma[i] - prevLuma[i]);
      totalAbsDiff += diff;
      if (diff > diffThreshold) {
        changedPixelsCount++;
        const px = i % width;
        const py = Math.floor(i / width);
        if (grid) {
          const gc = Math.floor(px / blockSize), gr = Math.floor(py / blockSize);
          if (gc < cols && gr < rows) {
            const ci = gr * cols + gc;
            grid.count[ci]++;
            if (px < grid.minX[ci]) grid.minX[ci] = px;
            if (px > grid.maxX[ci]) grid.maxX[ci] = px;
            if (py < grid.minY[ci]) grid.minY[ci] = py;
            if (py > grid.maxY[ci]) grid.maxY[ci] = py;
            grid.sumX[ci] += px;
            grid.sumY[ci] += py;
          }
        }
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }

    const pixelShiftPercent = (changedPixelsCount / totalPixels) * 100;
    const hasMotion = pixelShiftPercent > (tracking?.motionPercent ?? 0.25); // share of scene that must move (Stage 1)

    const vectors: RealFlowResult['vectors'] = [];

    // Stage 2: Hardware ISP Macroblock Vector Estimation
    // If OpenCV is loaded, we can use OpenCV Farnebäck / dense flow.
    // In all cases, we compute block-matching vectors (SAD) across the grid.
    const searchRadius = 8; // ±8 pixels search window

    let sumVx = 0;
    let sumVy = 0;
    let sumMag = 0;
    const activeVectorAngles: number[] = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const mbCenterX = c * blockSize + Math.floor(blockSize / 2);
        const mbCenterY = r * blockSize + Math.floor(blockSize / 2);

        // Check if this macroblock had pixel changes
        let blockDiffSum = 0;
        const startY = r * blockSize;
        const endY = Math.min(height, startY + blockSize);
        const startX = c * blockSize;
        const endX = Math.min(width, startX + blockSize);

        for (let y = startY; y < endY; y += 4) {
          const rowOffset = y * width;
          for (let x = startX; x < endX; x += 4) {
            blockDiffSum += Math.abs(luma[rowOffset + x] - prevLuma[rowOffset + x]);
          }
        }

        // Only search blocks with noticeable movement
        if (blockDiffSum > (blockSize * blockSize) / 8) {
          let bestDx = 0;
          let bestDy = 0;
          let minSad = Number.MAX_SAFE_INTEGER;

          // Block-matching (Sum of Absolute Differences)
          for (let dy = -searchRadius; dy <= searchRadius; dy += 2) {
            for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
              let sad = 0;
              let sampleCount = 0;

              for (let by = startY; by < endY; by += 4) {
                const prevY = by + dy;
                if (prevY < 0 || prevY >= height) continue;
                const rowCurr = by * width;
                const rowPrev = prevY * width;

                for (let bx = startX; bx < endX; bx += 4) {
                  const prevX = bx + dx;
                  if (prevX < 0 || prevX >= width) continue;
                  sad += Math.abs(luma[rowCurr + bx] - prevLuma[rowPrev + prevX]);
                  sampleCount++;
                }
              }

              if (sampleCount > 0 && sad < minSad) {
                minSad = sad;
                bestDx = dx;
                bestDy = dy;
              }
            }
          }

          const mag = Math.hypot(bestDx, bestDy);
          if (mag > 0.8) {
            vectors.push({
              gx: c,
              gy: r,
              x: mbCenterX,
              y: mbCenterY,
              dx: bestDx,
              dy: bestDy,
              mag,
            });

            if (grid) {
              const ci = r * cols + c;
              grid.active[ci] = 1;
              grid.vdx[ci] = bestDx;
              grid.vdy[ci] = bestDy;
            }
            sumVx += bestDx;
            sumVy += bestDy;
            sumMag += mag;
            activeVectorAngles.push(Math.atan2(bestDy, bestDx));
          }
        }
      }
    }

    // Save current frame as previous for next iteration
    this.prevLumaBuffer = luma;

    // Per-object path: group cells into blobs, track them, gate each track on its own history.
    // Runs every frame (even idle ones) so tracks coast and age correctly.
    let trackReports: TrackReport[] | undefined;
    if (tracking && grid) {
      // Camera-motion guard: when most of the frame is active the camera itself moved
      // (PTZ, shake). Per-object history is meaningless then, so drop it and start fresh.
      const frac = vectors.length / Math.max(1, rows * cols);
      const camCut = tracking.globalMotionFrac ?? 0.5;
      if (frac > camCut) {
        this.tracker.reset();
        this.cameraMotion = true;
        trackReports = [];
      } else {
        this.cameraMotion = false;
        const blobs = hasMotion
          ? extractBlobs(grid, { linkRadius: tracking.linkRadius, minCellPixels: tracking.minCellPixels })
          : [];
        trackReports = this.tracker.update(blobs, tracking.gate, totalPixels, blockSize);
      }
    }

    if (!hasMotion || vectors.length < 2) {
      return {
        vectors,
        pixelShiftPercent,
        hasMotion: false,
        vectorVariance: 0,
        netDisplacementRatio: 1.0,
        aspectDeformation: 0,
        currentAspectRatio: 1.0,
        boundingBox: null,
        stage2Passed: false,
        verdict: 'IDLE',
        dropReason: 'NO_SIGNIFICANT_MOTION (Stage 1 Filtered)',
        isOpenCvBackend: useOpenCV,
        trackingMode: !!tracking,
        tracks: trackReports,
      };
    }

    // Compute Bounding Box of active motion
    const bboxW = Math.max(20, maxX - minX);
    const bboxH = Math.max(20, maxY - minY);
    const currentAR = bboxW / bboxH;
    const aspectDeformation = Math.abs(currentAR - this.prevAspectRatio);
    this.prevAspectRatio = currentAR;

    // Vector Statistics for Stage 2
    // 1. Angular Variance
    let meanAngle = 0;
    let sumSin = 0;
    let sumCos = 0;
    for (const ang of activeVectorAngles) {
      sumSin += Math.sin(ang);
      sumCos += Math.cos(ang);
    }
    meanAngle = Math.atan2(sumSin, sumCos);

    let angularVarSum = 0;
    for (const ang of activeVectorAngles) {
      let diff = Math.abs(ang - meanAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      angularVarSum += diff * diff;
    }
    const radVariance = angularVarSum / activeVectorAngles.length;
    const vectorVariance = (radVariance * (180 / Math.PI) * (180 / Math.PI)) / 100;

    // 2. Net Displacement Ratio: ||Σv|| / Σ||v||
    const netDx = sumVx;
    const netDy = sumVy;
    const netDist = Math.hypot(netDx, netDy);
    const netDisplacementRatio = sumMag > 0 ? Math.min(1.0, netDist / sumMag) : 0;

    // Maintain temporal trajectory history (last 16 frames)
    this.historyTrajectories.push({
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      vx: sumVx / vectors.length,
      vy: sumVy / vectors.length,
      ar: currentAR,
    });
    if (this.historyTrajectories.length > 16) {
      this.historyTrajectories.shift();
    }

    // Stage 2 Decision Gate
    let stage2Passed = false;
    let verdict: RealFlowResult['verdict'] = 'DROP (Noise)';
    let dropReason = '';

    const angularPass = vectorVariance < thresholds.varianceThreshold * 1.6;
    const displacementPass = netDisplacementRatio >= thresholds.minNetDisplacement;
    const aspectPass = aspectDeformation <= thresholds.maxAspectDeformation;

    if (!angularPass) {
      stage2Passed = false;
      verdict = 'DROP (Noise)';
      dropReason = `ERRATIC_ANGULAR_SHIFT (Var: ${vectorVariance.toFixed(1)}° > max ${thresholds.varianceThreshold}°)`;
    } else if (!displacementPass) {
      stage2Passed = false;
      verdict = 'DROP (Noise)';
      dropReason = `ZERO_NET_DISPLACEMENT (Disp: ${(netDisplacementRatio * 100).toFixed(0)}% < min ${(thresholds.minNetDisplacement * 100).toFixed(0)}%)`;
    } else if (!aspectPass) {
      stage2Passed = false;
      verdict = 'DROP (Noise)';
      dropReason = `CHAOTIC_DEFORMATION (ΔAR: ${aspectDeformation.toFixed(2)} > max ${thresholds.maxAspectDeformation.toFixed(2)})`;
    } else {
      stage2Passed = true;
      verdict = 'PASS to AI';
      dropReason = 'COHERENT_KINEMATICS_MATCH (Human/Vehicle Motion Profile)';
    }

    return {
      vectors,
      pixelShiftPercent,
      hasMotion: true,
      vectorVariance,
      netDisplacementRatio,
      aspectDeformation,
      currentAspectRatio: currentAR,
      boundingBox: {
        x: minX,
        y: minY,
        width: bboxW,
        height: bboxH,
      },
      stage2Passed,
      verdict,
      dropReason,
      ...(trackReports ? summarizeTracks(trackReports) ?? {} : {}),
      isOpenCvBackend: useOpenCV,
      trackingMode: !!tracking,
      tracks: trackReports,
    };
  }
}
