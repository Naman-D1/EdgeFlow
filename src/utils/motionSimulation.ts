import { speculate } from './temporalSpeculation';
import { MotionObject, MacroblockVector, FilterParameters, ScenarioType } from '../types/pipeline';

export const DEFAULT_FILTER_PARAMS: FilterParameters = {
  varianceThreshold: 38, // degrees of angular variance
  minNetDisplacement: 0.42, // net / total path
  maxAspectDeformation: 0.28, // max AR change rate
  minPersistenceFrames: 5,
  strideFrequencyMin: 1.0,
  strideFrequencyMax: 3.5,
  enableTemporal: true,
  maxErraticScore: 0.1,
};

export function createInitialScenarioObjects(scenario: ScenarioType, width: number, height: number): MotionObject[] {
  const objects: MotionObject[] = [];

  switch (scenario) {
    case 'insect_swarm':
      objects.push(
        createObject('insect_1', 'insect', 'Lens Moth #1', width * 0.35, height * 0.4, 18, 14),
        createObject('insect_2', 'insect', 'Nocturnal Beetle #2', width * 0.6, height * 0.3, 14, 10),
        createObject('insect_3', 'insect', 'Gnat Cluster #3', width * 0.75, height * 0.65, 12, 12)
      );
      break;

    case 'windblown_trash':
      objects.push(
        createObject('trash_1', 'trash', 'Tumbling Polyethylene Bag', width * 0.2, height * 0.65, 42, 34),
        createObject('trash_2', 'trash', 'Discarded Cardboard Debris', width * 0.55, height * 0.7, 36, 26)
      );
      break;

    case 'swaying_foliage':
      objects.push(
        createObject('foliage_1', 'foliage', 'Pine Tree Canopy Branch A', width * 0.18, height * 0.35, 68, 85),
        createObject('foliage_2', 'foliage', 'Oak Tree Leaves Overhang', width * 0.82, height * 0.28, 75, 70),
        createObject('foliage_3', 'foliage', 'Perimeter Shrub Cluster', width * 0.32, height * 0.78, 55, 48)
      );
      break;

    case 'walking_person':
      objects.push(
        createObject('person_1', 'person', 'Pedestrian / Perimeter Intruder', width * 0.15, height * 0.48, 28, 72)
      );
      break;

    case 'running_child':
      objects.push(
        createObject('child_1', 'child', 'Running Individual', width * 0.1, height * 0.52, 22, 54)
      );
      break;

    case 'vehicle_driveby':
      objects.push(
        createObject('vehicle_1', 'vehicle', 'Service Vehicle', width * 0.05, height * 0.62, 85, 44)
      );
      break;

    case 'mixed_scene':
    default:
      // Real-world challenging scene with environmental noise + legitimate intruder
      objects.push(
        createObject('foliage_mix', 'foliage', 'Swaying Tree Branch', width * 0.85, height * 0.3, 70, 75),
        createObject('trash_mix', 'trash', 'Windblown Plastic Film', width * 0.4, height * 0.72, 38, 30),
        createObject('insect_mix', 'insect', 'Camera Lens Insect', width * 0.25, height * 0.25, 16, 12),
        createObject('person_mix', 'person', 'Perimeter Target (Intruder)', width * 0.12, height * 0.48, 28, 74)
      );
      break;
  }

  return objects;
}

function createObject(
  id: string,
  type: MotionObject['type'],
  name: string,
  x: number,
  y: number,
  w: number,
  h: number
): MotionObject {
  return {
    id,
    type,
    name,
    x,
    y,
    vx: type === 'person' ? 1.4 : type === 'child' ? 2.6 : type === 'vehicle' ? 3.5 : (Math.random() - 0.5) * 3,
    vy: type === 'person' || type === 'child' || type === 'vehicle' ? 0.05 : (Math.random() - 0.5) * 3,
    width: w,
    height: h,
    baseWidth: w,
    baseHeight: h,
    angle: 0,
    angularVelocity: 0,
    phase: Math.random() * Math.PI * 2,
    history: [],
    hasMotion: true,
    pixelDeltaScore: 0.85,
    vectorVariance: 0,
    netDisplacementRatio: 1,
    aspectDeformation: 0,
    strideFrequency: 0,
    stage2Passed: false,
    temporalScore: 0,
    temporalClass: 'warmup',
    temporalConfidence: 0,
    predictedPath: [],
    inferenceTriggered: false,
  };
}

export function updateObjectsKinematics(
  objects: MotionObject[],
  params: FilterParameters,
  canvasWidth: number,
  canvasHeight: number,
  elapsedSec: number
): MotionObject[] {
  return objects.map((obj) => {
    let { x, y, vx, vy, width, height, baseWidth, baseHeight, angle, phase } = obj;
    phase += 0.08;

    // Kinematic updates per object type
    switch (obj.type) {
      case 'insect': {
        // High frequency jitter, random sudden turn every few frames, extreme pixel speed
        if (Math.random() < 0.22) {
          const speed = 4 + Math.random() * 6;
          const heading = Math.random() * Math.PI * 2;
          vx = Math.cos(heading) * speed;
          vy = Math.sin(heading) * speed;
        } else {
          vx += (Math.random() - 0.5) * 2;
          vy += (Math.random() - 0.5) * 2;
        }
        // Rapid distance flutter (simulates near-lens optical flutter)
        const scale = 0.8 + Math.random() * 0.5;
        width = baseWidth * scale;
        height = baseHeight * (0.7 + Math.random() * 0.6);
        angle += (Math.random() - 0.5) * 1.5;
        break;
      }

      case 'trash': {
        // Tumbling, driven by wind with sudden gusts, constantly deforming geometry
        vx = 2.2 + Math.sin(phase * 1.5) * 1.8 + (Math.random() - 0.5) * 1.2;
        vy = Math.cos(phase * 2.2) * 1.6 + 0.3; // drifting slightly downward
        angle += 0.12 + Math.random() * 0.1;
        // Crumpling & stretching shape
        width = baseWidth * (0.8 + 0.5 * Math.abs(Math.sin(phase * 3.1)));
        height = baseHeight * (0.7 + 0.6 * Math.abs(Math.cos(phase * 2.7)));
        break;
      }

      case 'foliage': {
        // Wind oscillation: back and forth periodic motion around anchor point
        const anchorX = obj.history.length > 0 ? obj.history[0].x : x;
        const anchorY = obj.history.length > 0 ? obj.history[0].y : y;
        const swayAmp = 18;
        const swayFreq = 2.2;
        x = anchorX + Math.sin(elapsedSec * swayFreq + phase) * swayAmp;
        y = anchorY + Math.cos(elapsedSec * (swayFreq * 0.7) + phase) * (swayAmp * 0.35);
        vx = Math.cos(elapsedSec * swayFreq + phase) * swayAmp * 0.1;
        vy = -Math.sin(elapsedSec * (swayFreq * 0.7) + phase) * (swayAmp * 0.35) * 0.1;
        width = baseWidth * (1 + 0.08 * Math.sin(phase * 2));
        height = baseHeight * (1 + 0.05 * Math.cos(phase * 2));
        angle = Math.sin(elapsedSec * swayFreq) * 0.15;
        break;
      }

      case 'person': {
        // Coherent translation, stable upright aspect ratio, periodic subtle bobbing
        vx = 1.6;
        vy = Math.sin(phase * 2.5) * 0.25; // gait vertical oscillation
        width = baseWidth * (1 + 0.04 * Math.sin(phase * 2.5));
        height = baseHeight * (1 + 0.03 * Math.cos(phase * 2.5));
        angle = Math.sin(phase * 2.5) * 0.03;
        break;
      }

      case 'child': {
        // Faster jog, higher cadence
        vx = 2.8;
        vy = Math.sin(phase * 4.2) * 0.45;
        width = baseWidth * (1 + 0.06 * Math.sin(phase * 4.2));
        height = baseHeight * (1 + 0.04 * Math.cos(phase * 4.2));
        angle = Math.sin(phase * 4.2) * 0.05;
        break;
      }

      case 'vehicle': {
        // Very smooth, linear translation, rigid dimensions
        vx = 3.6;
        vy = 0;
        width = baseWidth;
        height = baseHeight;
        angle = 0;
        break;
      }

      case 'custom':
      default: {
        // Retain current velocity
        break;
      }
    }

    if (obj.type !== 'foliage') {
      x += vx;
      y += vy;
    }

    // Wrap around boundaries
    if (x > canvasWidth + 80) x = -70;
    if (x < -80) x = canvasWidth + 70;
    if (y > canvasHeight - 20) y = canvasHeight - 80;
    if (y < 20) y = 40;

    // Maintain history (last 24 frames)
    const newHistory = [...obj.history, { x, y, vx, vy, w: width, h: height }].slice(-24);

    // Stage 1 Check: Raw Pixel Motion Check (< 1% Compute)
    const speed = Math.hypot(vx, vy);
    const hasMotion = speed > 0.15;
    const pixelDeltaScore = Math.min(1.0, speed / 4.0);

    // v2 Temporal speculation: how predictable has this track been, and where is it going?
    const temporal = speculate(
      newHistory.map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h })),
      12,
      { minFrames: 8, erraticCut: params.maxErraticScore, minStraight: 0.45 }
    );

    // Stage 2 Check: Vector Coherence & Trajectory Profiling (~3-5% CPU)
    let vectorVariance = 0;
    let netDisplacementRatio = 1.0;
    let aspectDeformation = 0;
    let strideFrequency = 0;
    let stage2Passed = false;
    let dropReason = '';

    if (newHistory.length >= 6) {
      // 1. Angular Variance
      const angles = newHistory.map((h) => Math.atan2(h.vy, h.vx));
      // Calculate circular mean & angular variance
      let sumSin = 0;
      let sumCos = 0;
      for (const a of angles) {
        sumSin += Math.sin(a);
        sumCos += Math.cos(a);
      }
      const meanAngle = Math.atan2(sumSin, sumCos);
      let varSum = 0;
      for (const a of angles) {
        let diff = Math.abs(a - meanAngle);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        varSum += diff * diff;
      }
      // Variance in degrees^2
      const radVariance = varSum / angles.length;
      vectorVariance = (radVariance * (180 / Math.PI) * (180 / Math.PI)) / 100; // normalized scaled

      // 2. Net Displacement Ratio: ||sum(v)|| / sum(||v||)
      const first = newHistory[0];
      const last = newHistory[newHistory.length - 1];
      const netDist = Math.hypot(last.x - first.x, last.y - first.y);
      let totalDist = 0;
      for (let i = 1; i < newHistory.length; i++) {
        totalDist += Math.hypot(newHistory[i].x - newHistory[i - 1].x, newHistory[i].y - newHistory[i - 1].y);
      }
      netDisplacementRatio = totalDist > 0 ? Math.min(1.0, netDist / totalDist) : 0;

      // 3. Aspect Ratio Deformation: delta(W/H) per unit time
      const arChanges: number[] = [];
      for (let i = 1; i < newHistory.length; i++) {
        const arPrev = newHistory[i - 1].w / newHistory[i - 1].h;
        const arCurr = newHistory[i].w / newHistory[i].h;
        arChanges.push(Math.abs(arCurr - arPrev));
      }
      aspectDeformation = arChanges.reduce((a, b) => a + b, 0) / arChanges.length;

      // 4. Stride Periodic Signal Check
      if (obj.type === 'person') strideFrequency = 1.85;
      else if (obj.type === 'child') strideFrequency = 2.75;
      else strideFrequency = 0;

      // Decision Gate
      const angularPass = vectorVariance < params.varianceThreshold * 1.5;
      const displacementPass = netDisplacementRatio >= params.minNetDisplacement;
      const aspectPass = aspectDeformation <= params.maxAspectDeformation;

      if (!angularPass) {
        stage2Passed = false;
        dropReason = 'ERRATIC_ANGULAR_SHIFT (High Vector Variance)';
      } else if (!displacementPass) {
        stage2Passed = false;
        dropReason = 'ZERO_NET_DISPLACEMENT (Oscillatory Foliage)';
      } else if (!aspectPass) {
        stage2Passed = false;
        dropReason = 'CHAOTIC_DEFORMATION (Deforming Debris)';
      } else if (params.enableTemporal && temporal.motionClass === 'erratic') {
        stage2Passed = false;
        dropReason = `UNPREDICTABLE_TRAJECTORY (Temporal ${temporal.erraticScore.toFixed(2)} > max ${params.maxErraticScore.toFixed(2)})`;
      } else {
        stage2Passed = true;
        dropReason = 'COHERENT_TRAJECTORY (Human / Kinematic Match)';
      }
    } else {
      stage2Passed = false;
      dropReason = 'WARMUP_BUFFERING';
    }

    // Stage 3 Check: Deep Learning Inference (Triggered ONLY when Stage 2 Passes!)
    const inferenceTriggered = stage2Passed;
    let aiClassification = undefined;
    let aiConfidence = undefined;

    if (inferenceTriggered) {
      if (obj.type === 'person') {
        aiClassification = 'Person';
        aiConfidence = 0.94;
      } else if (obj.type === 'child') {
        aiClassification = 'Person / Jogger';
        aiConfidence = 0.91;
      } else if (obj.type === 'vehicle') {
        aiClassification = 'Vehicle';
        aiConfidence = 0.98;
      } else {
        aiClassification = 'Moving Target';
        aiConfidence = 0.88;
      }
    }

    return {
      ...obj,
      x,
      y,
      vx,
      vy,
      width,
      height,
      angle,
      phase,
      history: newHistory,
      hasMotion,
      pixelDeltaScore,
      vectorVariance,
      netDisplacementRatio,
      aspectDeformation,
      strideFrequency,
      stage2Passed,
      dropReason,
      temporalScore: temporal.erraticScore,
      temporalClass: temporal.motionClass,
      temporalConfidence: temporal.confidence,
      predictedPath: params.enableTemporal ? temporal.predicted : [],
      inferenceTriggered,
      aiClassification,
      aiConfidence,
    };
  });
}

// Generate H.264/H.265 Macroblock motion vectors over a 16x16 grid
export function generateMacroblockVectors(
  objects: MotionObject[],
  width: number,
  height: number,
  blockSize: number = 32
): MacroblockVector[] {
  const vectors: MacroblockVector[] = [];
  const cols = Math.floor(width / blockSize);
  const rows = Math.floor(height / blockSize);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const mbCenterX = c * blockSize + blockSize / 2;
      const mbCenterY = r * blockSize + blockSize / 2;

      let dominantDx = 0;
      let dominantDy = 0;
      let maxWeight = 0;
      let coherence = 1.0;

      // Check proximity to active objects
      for (const obj of objects) {
        const halfW = obj.width / 2 + blockSize / 2;
        const halfH = obj.height / 2 + blockSize / 2;
        const dist = Math.hypot(mbCenterX - obj.x, mbCenterY - obj.y);

        if (Math.abs(mbCenterX - obj.x) < halfW && Math.abs(mbCenterY - obj.y) < halfH) {
          const weight = Math.max(0, 1 - dist / (Math.max(obj.width, obj.height) * 1.5));
          if (weight > maxWeight) {
            maxWeight = weight;
            dominantDx = obj.vx;
            dominantDy = obj.vy;
            coherence = obj.stage2Passed ? 0.95 : 0.25;
          }
        }
      }

      if (maxWeight > 0.05) {
        const mag = Math.hypot(dominantDx, dominantDy);
        vectors.push({
          gx: c,
          gy: r,
          x: mbCenterX,
          y: mbCenterY,
          dx: dominantDx * 3.5,
          dy: dominantDy * 3.5,
          magnitude: mag,
          coherenceScore: coherence,
        });
      }
    }
  }

  return vectors;
}
