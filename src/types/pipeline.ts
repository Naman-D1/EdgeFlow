import type { MotionClass } from '../utils/temporalSpeculation';

export type PipelineStage = 'raw' | 'stage1_motion' | 'stage2_vectors' | 'stage3_inference';

export type ScenarioType = 
  | 'mixed_scene'
  | 'insect_swarm'
  | 'windblown_trash'
  | 'swaying_foliage'
  | 'walking_person'
  | 'running_child'
  | 'vehicle_driveby';

export interface MotionObject {
  id: string;
  type: 'insect' | 'trash' | 'foliage' | 'person' | 'child' | 'vehicle' | 'custom';
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  baseWidth: number;
  baseHeight: number;
  angle: number;
  angularVelocity: number;
  phase: number;
  history: { x: number; y: number; vx: number; vy: number; w: number; h: number }[];
  // Stage 1 output
  hasMotion: boolean;
  pixelDeltaScore: number;
  // Stage 2 outputs
  vectorVariance: number; // deg^2 or normalized variance
  netDisplacementRatio: number; // 0 to 1
  aspectDeformation: number; // delta AR / delta t
  strideFrequency: number; // Hz (0 for non-periodic)
  stage2Passed: boolean;
  dropReason?: string;
  // v2: temporal speculation outputs
  temporalScore: number; // 0 = smooth/predictable, 1 = erratic
  temporalClass: MotionClass;
  temporalConfidence: number; // 1 - temporalScore
  predictedPath: { x: number; y: number }[]; // speculated future positions
  // Stage 3 output
  aiClassification?: string;
  aiConfidence?: number;
  inferenceTriggered: boolean;
}

export interface MacroblockVector {
  gx: number;
  gy: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  magnitude: number;
  coherenceScore: number; // 0 (chaotic) to 1 (coherent)
}

export interface FilterParameters {
  varianceThreshold: number; // Max angular variance threshold in degrees (e.g. 35)
  minNetDisplacement: number; // Min net displacement ratio (e.g. 0.45)
  maxAspectDeformation: number; // Max aspect ratio deformation per sec (e.g. 0.30)
  minPersistenceFrames: number; // Min consecutive frames required (e.g. 4)
  strideFrequencyMin: number; // Human stride range min Hz
  strideFrequencyMax: number; // Human stride range max Hz
  enableTemporal: boolean; // v2: gate on trajectory predictability
  maxErraticScore: number; // v2: drop tracks scoring above this (0..1). Calibrated on simulator only.
}

export interface HardwareProfile {
  id: string;
  name: string;
  category: 'Edge IP Camera' | 'Edge Gateway' | 'Cloud Server';
  soc: string;
  cpuSpec: string;
  npuTops: number;
  typicalPowerWatts: number;
  macroblockSupport: 'Hardware ISP H.264/H.265' | 'NPU Vector Unit' | 'Host CPU Emulation';
  baselineFullAiWatts: number;
  edgeFlowWatts: number;
}
