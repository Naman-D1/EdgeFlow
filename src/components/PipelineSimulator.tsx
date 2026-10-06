import React, { useRef, useEffect, useState, useCallback } from 'react';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  Eye, 
  Zap, 
  Cpu, 
  ShieldAlert, 
  Sparkles,
  Info
} from 'lucide-react';
import { 
  MotionObject, 
  MacroblockVector, 
  PipelineStage, 
  ScenarioType, 
  FilterParameters 
} from '../types/pipeline';
import { 
  createInitialScenarioObjects, 
  updateObjectsKinematics, 
  generateMacroblockVectors, 
  DEFAULT_FILTER_PARAMS 
} from '../utils/motionSimulation';

interface PipelineSimulatorProps {
  filterParams: FilterParameters;
  onStatsUpdate?: (stats: {
    totalEvents: number;
    droppedByStage2: number;
    passedToInference: number;
    wattsSavedPercent: number;
  }) => void;
}

export const PipelineSimulator: React.FC<PipelineSimulatorProps> = ({
  filterParams = DEFAULT_FILTER_PARAMS,
  onStatsUpdate,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [activeStage, setActiveStage] = useState<PipelineStage>('stage2_vectors');
  const [activeScenario, setActiveScenario] = useState<ScenarioType>('mixed_scene');
  const [selectedObjectId, setSelectedObjectId] = useState<string>('person_mix');
  const [showMacroblockGrid, setShowMacroblockGrid] = useState<boolean>(true);
  const [showBoundingBoxes, setShowBoundingBoxes] = useState<boolean>(true);

  // Simulation counters
  const [stats, setStats] = useState({
    totalFrames: 0,
    motionEvents: 142,
    droppedAtStage2: 118,
    passedToAi: 24,
    powerSavedPercent: 78.4,
  });

  const objectsRef = useRef<MotionObject[]>([]);
  const elapsedRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);

  // Initialize objects for current scenario
  const resetScenario = useCallback((scenario: ScenarioType) => {
    const width = 800;
    const height = 460;
    const objs = createInitialScenarioObjects(scenario, width, height);
    objectsRef.current = objs;
    if (objs.length > 0) {
      setSelectedObjectId(objs[0].id);
    }
  }, []);

  useEffect(() => {
    resetScenario(activeScenario);
  }, [activeScenario, resetScenario]);

  // Main animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let lastTime = performance.now();

    const loop = (currentTime: number) => {
      const dt = (currentTime - lastTime) / 1000;
      lastTime = currentTime;

      if (isPlaying) {
        elapsedRef.current += dt;
        objectsRef.current = updateObjectsKinematics(
          objectsRef.current,
          filterParams,
          canvas.width,
          canvas.height,
          elapsedRef.current
        );

        // Periodically update statistics
        setStats((prev) => {
          const moving = objectsRef.current.filter((o) => o.hasMotion);
          const dropped = objectsRef.current.filter((o) => o.hasMotion && !o.stage2Passed);
          const passed = objectsRef.current.filter((o) => o.stage2Passed);
          const newTotal = prev.motionEvents + (moving.length > 0 ? 1 : 0);
          const newDropped = prev.droppedAtStage2 + (dropped.length > 0 ? 1 : 0);
          const newPassed = prev.passedToAi + (passed.length > 0 ? 1 : 0);
          const pct = newTotal > 0 ? (newDropped / newTotal) * 100 : 78.4;
          return {
            totalFrames: prev.totalFrames + 1,
            motionEvents: newTotal,
            droppedAtStage2: newDropped,
            passedToAi: newPassed,
            powerSavedPercent: parseFloat(pct.toFixed(1)),
          };
        });
      }

      const objects = objectsRef.current;
      const vectors = generateMacroblockVectors(objects, canvas.width, canvas.height, 32);

      // Render Scene
      renderScene(ctx, canvas.width, canvas.height, objects, vectors, activeStage, {
        showGrid: showMacroblockGrid,
        showBoxes: showBoundingBoxes,
        selectedId: selectedObjectId,
        elapsed: elapsedRef.current,
      });

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isPlaying, activeStage, filterParams, showMacroblockGrid, showBoundingBoxes, selectedObjectId]);

  // Canvas render function
  const renderScene = (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    objects: MotionObject[],
    vectors: MacroblockVector[],
    stage: PipelineStage,
    opts: { showGrid: boolean; showBoxes: boolean; selectedId: string; elapsed: number }
  ) => {
    // 1. Background (CCTV Security View)
    ctx.fillStyle = '#090d16'; // Deep midnight surveillance feed
    ctx.fillRect(0, 0, w, h);

    // Subtle CCTV scanline & atmospheric gradient
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0b1120');
    grad.addColorStop(0.65, '#070b14');
    grad.addColorStop(1, '#05070c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Perimeter fence line & concrete ground
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    // Ground horizon
    const horizon = h * 0.68;
    ctx.fillStyle = '#0c1322';
    ctx.fillRect(0, horizon, w, h - horizon);

    // Chainlink fence texture in distance
    ctx.beginPath();
    for (let x = 0; x < w; x += 16) {
      ctx.moveTo(x, horizon - 90);
      ctx.lineTo(x + 24, horizon);
      ctx.moveTo(x + 24, horizon - 90);
      ctx.lineTo(x, horizon);
    }
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.4)';
    ctx.stroke();

    // Fence top railing
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, horizon - 90);
    ctx.lineTo(w, horizon - 90);
    ctx.stroke();

    // Ambient light source (parking light / floodlight)
    const lightGrad = ctx.createRadialGradient(w * 0.5, 0, 20, w * 0.5, horizon, 380);
    lightGrad.addColorStop(0, 'rgba(56, 189, 248, 0.08)');
    lightGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = lightGrad;
    ctx.fillRect(0, 0, w, h);

    // If Stage 1: Pixel Motion Mask Overlay
    if (stage === 'stage1_motion') {
      // Dim the base feed to emphasize the raw pixel difference map
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fillRect(0, 0, w, h);

      // Render Stage 1 background subtraction difference blobs
      objects.forEach((obj) => {
        if (!obj.hasMotion) return;
        ctx.save();
        ctx.fillStyle = 'rgba(234, 179, 8, 0.35)'; // Amber pixel shift
        ctx.strokeStyle = 'rgba(234, 179, 8, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(obj.x, obj.y, obj.width * 0.7, obj.height * 0.6, obj.angle, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      });
    }

    // 2. Draw Simulated Objects
    objects.forEach((obj) => {
      // v2: speculated future path (world coords, drawn before the rotated object frame)
      if (obj.predictedPath.length > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(obj.x, obj.y);
        obj.predictedPath.forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = `rgba(56, 189, 248, ${0.15 + 0.6 * obj.temporalConfidence})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const end = obj.predictedPath[obj.predictedPath.length - 1];
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(end.x, end.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(56, 189, 248, ${0.2 + 0.7 * obj.temporalConfidence})`;
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.translate(obj.x, obj.y);
      ctx.rotate(obj.angle);

      // Trajectory breadcrumbs
      if (obj.history.length > 2) {
        ctx.beginPath();
        const first = obj.history[0];
        ctx.moveTo(first.x - obj.x, first.y - obj.y);
        for (let i = 1; i < obj.history.length; i++) {
          const pt = obj.history[i];
          ctx.lineTo(pt.x - obj.x, pt.y - obj.y);
        }
        ctx.strokeStyle = obj.stage2Passed ? 'rgba(52, 211, 153, 0.35)' : 'rgba(244, 63, 94, 0.25)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Draw object graphics
      switch (obj.type) {
        case 'insect': {
          // Moth flutter: small dark body with translucent fluttering wings
          ctx.fillStyle = '#e2e8f0';
          ctx.beginPath();
          ctx.ellipse(0, 0, obj.width * 0.35, obj.height * 0.2, 0, 0, Math.PI * 2);
          ctx.fill();

          // Wings
          ctx.fillStyle = 'rgba(226, 232, 240, 0.5)';
          const wingSpread = Math.sin(opts.elapsed * 35) * 8;
          ctx.beginPath();
          ctx.ellipse(0, -wingSpread, obj.width * 0.4, obj.height * 0.35, 0.3, 0, Math.PI * 2);
          ctx.ellipse(0, wingSpread, obj.width * 0.4, obj.height * 0.35, -0.3, 0, Math.PI * 2);
          ctx.fill();
          break;
        }

        case 'trash': {
          // Crumpled translucent plastic bag tumbling
          ctx.fillStyle = 'rgba(241, 245, 249, 0.38)';
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          const hw = obj.width / 2;
          const hh = obj.height / 2;
          ctx.moveTo(-hw, -hh * 0.6);
          ctx.lineTo(0, -hh);
          ctx.lineTo(hw * 0.8, -hh * 0.3);
          ctx.lineTo(hw, hh * 0.4);
          ctx.lineTo(hw * 0.2, hh);
          ctx.lineTo(-hw * 0.7, hh * 0.7);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          break;
        }

        case 'foliage': {
          // Swaying branch with pine needles / leaves
          ctx.fillStyle = 'rgba(16, 185, 129, 0.45)';
          ctx.strokeStyle = 'rgba(5, 150, 105, 0.8)';
          ctx.lineWidth = 1.5;
          const bw = obj.width / 2;
          const bh = obj.height / 2;
          ctx.beginPath();
          ctx.moveTo(0, -bh);
          ctx.bezierCurveTo(bw, -bh * 0.5, bw * 0.8, bh * 0.5, 0, bh);
          ctx.bezierCurveTo(-bw * 0.8, bh * 0.5, -bw, -bh * 0.5, 0, -bh);
          ctx.fill();
          ctx.stroke();
          // Leaf veins
          ctx.beginPath();
          ctx.moveTo(0, -bh);
          ctx.lineTo(0, bh);
          ctx.strokeStyle = 'rgba(6, 78, 59, 0.6)';
          ctx.stroke();
          break;
        }

        case 'person': {
          // Security intruder / human silhouette
          const ph = obj.height;
          const pw = obj.width;
          ctx.fillStyle = '#94a3b8';

          // Head
          ctx.beginPath();
          ctx.arc(0, -ph * 0.38, pw * 0.28, 0, Math.PI * 2);
          ctx.fill();

          // Torso & jacket
          ctx.fillStyle = '#475569';
          ctx.beginPath();
          ctx.roundRect(-pw * 0.38, -ph * 0.22, pw * 0.76, ph * 0.42, 4);
          ctx.fill();

          // Legs walking
          const legPhase = Math.sin(opts.elapsed * 5.5);
          ctx.strokeStyle = '#334155';
          ctx.lineWidth = 4;
          ctx.beginPath();
          // Left leg
          ctx.moveTo(-pw * 0.2, ph * 0.18);
          ctx.lineTo(-pw * 0.2 + legPhase * 8, ph * 0.48);
          // Right leg
          ctx.moveTo(pw * 0.2, ph * 0.18);
          ctx.lineTo(pw * 0.2 - legPhase * 8, ph * 0.48);
          ctx.stroke();
          break;
        }

        case 'child': {
          // Running individual
          const ph = obj.height;
          const pw = obj.width;
          ctx.fillStyle = '#38bdf8';
          // Head
          ctx.beginPath();
          ctx.arc(0, -ph * 0.38, pw * 0.3, 0, Math.PI * 2);
          ctx.fill();
          // Torso
          ctx.fillStyle = '#0284c7';
          ctx.beginPath();
          ctx.roundRect(-pw * 0.35, -ph * 0.2, pw * 0.7, ph * 0.4, 3);
          ctx.fill();
          // Rapid running legs
          const legPhase = Math.sin(opts.elapsed * 10);
          ctx.strokeStyle = '#0369a1';
          ctx.lineWidth = 3.5;
          ctx.beginPath();
          ctx.moveTo(-pw * 0.2, ph * 0.18);
          ctx.lineTo(-pw * 0.2 + legPhase * 12, ph * 0.48);
          ctx.moveTo(pw * 0.2, ph * 0.18);
          ctx.lineTo(pw * 0.2 - legPhase * 12, ph * 0.48);
          ctx.stroke();
          break;
        }

        case 'vehicle': {
          // Vehicle outline
          const vw = obj.width;
          const vh = obj.height;
          ctx.fillStyle = '#64748b';
          ctx.beginPath();
          ctx.roundRect(-vw / 2, -vh / 2, vw, vh, 4);
          ctx.fill();
          // Wheels
          ctx.fillStyle = '#0f172a';
          ctx.beginPath();
          ctx.arc(-vw * 0.3, vh * 0.4, 7, 0, Math.PI * 2);
          ctx.arc(vw * 0.3, vh * 0.4, 7, 0, Math.PI * 2);
          ctx.fill();
          // Headlights
          ctx.fillStyle = '#fef08a';
          ctx.fillRect(vw * 0.42, -vh * 0.1, 4, 8);
          break;
        }

        case 'custom':
        default: {
          ctx.fillStyle = '#a855f7';
          ctx.beginPath();
          ctx.arc(0, 0, obj.width / 2, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
      }
      ctx.restore();
    });

    // 3. Macroblock Motion Vector Grid (Stage 2 Overlay)
    if (opts.showGrid && (stage === 'stage2_vectors' || stage === 'raw')) {
      // Draw grid lines faintly
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      const bSize = 32;
      for (let x = 0; x < w; x += bSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += bSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Draw H.264 Macroblock vectors
      vectors.forEach((v) => {
        ctx.save();
        const len = Math.hypot(v.dx, v.dy);
        if (len < 0.5) {
          ctx.restore();
          return;
        }

        // Color based on coherence
        let strokeColor = 'rgba(56, 189, 248, 0.85)'; // Coherent translation
        if (v.coherenceScore < 0.4) {
          strokeColor = 'rgba(244, 63, 94, 0.85)'; // Chaotic / noisy
        }

        ctx.strokeStyle = strokeColor;
        ctx.fillStyle = strokeColor;
        ctx.lineWidth = 1.8;

        // Vector arrow
        ctx.beginPath();
        ctx.moveTo(v.x, v.y);
        ctx.lineTo(v.x + v.dx * 2.5, v.y + v.dy * 2.5);
        ctx.stroke();

        // Arrow head
        const angle = Math.atan2(v.dy, v.dx);
        const headlen = 4;
        ctx.beginPath();
        ctx.moveTo(v.x + v.dx * 2.5, v.y + v.dy * 2.5);
        ctx.lineTo(
          v.x + v.dx * 2.5 - headlen * Math.cos(angle - Math.PI / 6),
          v.y + v.dy * 2.5 - headlen * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          v.x + v.dx * 2.5 - headlen * Math.cos(angle + Math.PI / 6),
          v.y + v.dy * 2.5 - headlen * Math.sin(angle + Math.PI / 6)
        );
        ctx.fill();

        ctx.restore();
      });
    }

    // 4. Bounding Box & Classification Labels
    if (opts.showBoxes) {
      objects.forEach((obj) => {
        const isSelected = obj.id === opts.selectedId;
        const halfW = obj.width / 2 + 8;
        const halfH = obj.height / 2 + 8;

        ctx.save();
        if (obj.stage2Passed) {
          // PASS TO AI (Stage 3 Wakeup)
          ctx.strokeStyle = '#10b981'; // Emerald
          ctx.lineWidth = isSelected ? 2.5 : 1.5;
          ctx.strokeRect(obj.x - halfW, obj.y - halfH, halfW * 2, halfH * 2);

          // Corner notches
          drawCornerNotches(ctx, obj.x - halfW, obj.y - halfH, halfW * 2, halfH * 2, '#34d399');

          // Label
          ctx.fillStyle = '#064e3b';
          ctx.fillRect(obj.x - halfW, obj.y - halfH - 20, 150, 18);
          ctx.fillStyle = '#6ee7b7';
          ctx.font = '10px "JetBrains Mono", monospace';
          ctx.fillText(`AI WAKEUP: ${obj.aiClassification || 'Target'} 94%`, obj.x - halfW + 4, obj.y - halfH - 6);
        } else {
          // DROPPED AT STAGE 2 (Noise filtered!)
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = isSelected ? 2 : 1;
          ctx.strokeRect(obj.x - halfW, obj.y - halfH, halfW * 2, halfH * 2);
          ctx.setLineDash([]);

          // Filter tag
          ctx.fillStyle = 'rgba(24, 24, 27, 0.85)';
          ctx.fillRect(obj.x - halfW, obj.y - halfH - 18, 120, 16);
          ctx.fillStyle = '#f87171';
          ctx.font = '9px "JetBrains Mono", monospace';
          ctx.fillText(`FILTERED: DROP NOISE`, obj.x - halfW + 4, obj.y - halfH - 6);
        }

        // Selected Crosshair Indicator
        if (isSelected) {
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1;
          ctx.beginPath();
          // Crosshairs
          ctx.moveTo(obj.x - halfW - 6, obj.y);
          ctx.lineTo(obj.x - halfW + 2, obj.y);
          ctx.moveTo(obj.x + halfW - 2, obj.y);
          ctx.lineTo(obj.x + halfW + 6, obj.y);
          ctx.moveTo(obj.x, obj.y - halfH - 6);
          ctx.lineTo(obj.x, obj.y - halfH + 2);
          ctx.moveTo(obj.x, obj.y + halfH - 2);
          ctx.lineTo(obj.x, obj.y + halfH + 6);
          ctx.stroke();
        }

        ctx.restore();
      });
    }

    // 5. Camera On-Screen Display (OSD) HUD
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.fillRect(10, 10, 240, 24);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '10px "JetBrains Mono", monospace';
    const now = new Date();
    const timeStr = now.toISOString().replace('T', ' ').substring(0, 19);
    ctx.fillText(`CAM-04 NORTH-PERIMETER · ${timeStr}`, 16, 26);

    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.fillRect(w - 185, 10, 175, 24);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`ISP H.264/AVC · 30.0 FPS · 1080p`, w - 178, 26);

    // Active Stage Tag in bottom-left
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(10, h - 34, 260, 24);
    ctx.fillStyle = stage === 'stage3_inference' ? '#34d399' : stage === 'stage2_vectors' ? '#38bdf8' : '#fbbf24';
    ctx.fillText(`PIPELINE STAGE: ${stage.toUpperCase()}`, 16, h - 18);
    ctx.restore();
  };

  const drawCornerNotches = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    color: string
  ) => {
    const len = 6;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    // Top-left
    ctx.moveTo(x, y + len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len, y);
    // Top-right
    ctx.moveTo(x + w - len, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + len);
    // Bottom-left
    ctx.moveTo(x, y + h - len);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + len, y + h);
    // Bottom-right
    ctx.moveTo(x + w - len, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + h - len);
    ctx.stroke();
  };

  // Canvas click handler to inspect specific object or spawn test
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clickX = (e.clientX - rect.left) * scaleX;
    const clickY = (e.clientY - rect.top) * scaleY;

    // Check if clicked near an existing object
    let clickedId: string | null = null;
    let minDist = 45;
    for (const obj of objectsRef.current) {
      const dist = Math.hypot(clickX - obj.x, clickY - obj.y);
      if (dist < minDist) {
        minDist = dist;
        clickedId = obj.id;
      }
    }

    if (clickedId) {
      setSelectedObjectId(clickedId);
    } else {
      // Spawn custom test object
      const customObj: MotionObject = {
        id: `custom_${Date.now()}`,
        type: 'custom',
        name: `Interactive Probe #${objectsRef.current.length + 1}`,
        x: clickX,
        y: clickY,
        vx: 1.8,
        vy: 0.2,
        width: 30,
        height: 50,
        baseWidth: 30,
        baseHeight: 50,
        angle: 0,
        angularVelocity: 0,
        phase: 0,
        history: [],
        hasMotion: true,
        pixelDeltaScore: 0.7,
        vectorVariance: 0,
        netDisplacementRatio: 1.0,
        aspectDeformation: 0,
        strideFrequency: 2.0,
        stage2Passed: true,
        temporalScore: 0,
        temporalClass: 'warmup',
        temporalConfidence: 0,
        predictedPath: [],
        dropReason: 'MANUAL_INJECTION',
        inferenceTriggered: true,
      };
      objectsRef.current = [...objectsRef.current, customObj];
      setSelectedObjectId(customObj.id);
    }
  };

  const selectedObject = objectsRef.current.find((o) => o.id === selectedObjectId) || objectsRef.current[0];

  return (
    <div className="space-y-6">
      {/* Top Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-slate-900/60 border border-slate-800 rounded-xl">
        {/* Scenario Selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Test Scenario:</span>
          <div className="flex flex-wrap items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
            <button
              onClick={() => setActiveScenario('mixed_scene')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeScenario === 'mixed_scene'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Mixed Scene (Noise + Target)
            </button>
            <button
              onClick={() => setActiveScenario('insect_swarm')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeScenario === 'insect_swarm'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Moth on Lens (Erratic)
            </button>
            <button
              onClick={() => setActiveScenario('windblown_trash')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeScenario === 'windblown_trash'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Windblown Trash
            </button>
            <button
              onClick={() => setActiveScenario('swaying_foliage')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeScenario === 'swaying_foliage'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Swaying Foliage
            </button>
            <button
              onClick={() => setActiveScenario('walking_person')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeScenario === 'walking_person'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Walking Intruder
            </button>
          </div>
        </div>

        {/* View Stage Controls */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Inspect Stage:</span>
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
            <button
              onClick={() => setActiveStage('raw')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                activeStage === 'raw' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Raw RGB
            </button>
            <button
              onClick={() => setActiveStage('stage1_motion')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                activeStage === 'stage1_motion' ? 'bg-amber-950/80 text-amber-300 border border-amber-800/60' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Stage 1 (Pixel Shift)
            </button>
            <button
              onClick={() => setActiveStage('stage2_vectors')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                activeStage === 'stage2_vectors' ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-800/60' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Stage 2 (Vector Flow)
            </button>
            <button
              onClick={() => setActiveStage('stage3_inference')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                activeStage === 'stage3_inference' ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/60' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Stage 3 (AI Inference)
            </button>
          </div>
        </div>

        {/* Playback Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className="p-2 text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
            title={isPlaying ? 'Pause Simulation' : 'Resume Simulation'}
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button
            onClick={() => resetScenario(activeScenario)}
            className="p-2 text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
            title="Reset Simulation Positions"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Viewport Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Canvas Camera View (Left 8 cols) */}
        <div className="lg:col-span-8 space-y-3">
          <div className="relative rounded-xl overflow-hidden border border-slate-800 bg-slate-950 shadow-2xl group">
            <canvas
              ref={canvasRef}
              width={800}
              height={460}
              onClick={handleCanvasClick}
              className="w-full h-auto block cursor-crosshair"
            />

            {/* In-canvas overlay toggles */}
            <div className="absolute bottom-3 right-3 flex items-center gap-2 bg-slate-950/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-800 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
                <input
                  type="checkbox"
                  checked={showMacroblockGrid}
                  onChange={(e) => setShowMacroblockGrid(e.target.checked)}
                  className="rounded bg-slate-900 border-slate-700 text-emerald-500 focus:ring-0"
                />
                <span>H.264 Macroblocks</span>
              </label>
              <span className="text-slate-600">·</span>
              <label className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
                <input
                  type="checkbox"
                  checked={showBoundingBoxes}
                  onChange={(e) => setShowBoundingBoxes(e.target.checked)}
                  className="rounded bg-slate-900 border-slate-700 text-emerald-500 focus:ring-0"
                />
                <span>Stage Verdict Boxes</span>
              </label>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500 px-1">
            <span>Click any target to inspect vector telemetry, or click on empty ground to inject a custom probe</span>
            <span>Hardware ISP Engine: Ambarella / HiSilicon H.264 Macroblock Re-use</span>
          </div>

          {/* Quick Stage 1 -> 2 -> 3 Compute Cost Comparison Bar */}
          <div className="grid grid-cols-3 gap-3 p-4 bg-slate-900/40 border border-slate-800/80 rounded-xl">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 font-medium">Stage 1: Pixel Motion</span>
                <span className="text-amber-400 font-mono tabular-nums">&lt; 1% Load</span>
              </div>
              <p className="text-[11px] text-slate-500 leading-tight">
                Frame-difference subtraction. Wakes up Stage 2 on pixel change.
              </p>
            </div>
            <div className="space-y-1 border-l border-slate-800/80 pl-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 font-medium">Stage 2: Vector Coherence</span>
                <span className="text-cyan-400 font-mono tabular-nums">3–5% CPU/NPU</span>
              </div>
              <p className="text-[11px] text-slate-500 leading-tight">
                Re-uses ISP motion vectors. Drops erratic noise &amp; foliage before AI.
              </p>
            </div>
            <div className="space-y-1 border-l border-slate-800/80 pl-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 font-medium">Stage 3: Deep Learning AI</span>
                <span className="text-emerald-400 font-mono tabular-nums">100% (Rarely Wakes)</span>
              </div>
              <p className="text-[11px] text-slate-500 leading-tight">
                Full neural network (YOLOv8/Transformer). Triggered strictly for verified kinematics.
              </p>
            </div>
          </div>
        </div>

        {/* Live Vector Telemetry & Decision Inspector (Right 4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          {/* Target Inspector Card */}
          <div className="p-5 bg-slate-900/70 border border-slate-800 rounded-xl space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-xs text-slate-500 font-mono">OBJECT INSPECTOR</span>
                <h3 className="text-base font-semibold text-white tracking-tight">
                  {selectedObject ? selectedObject.name : 'No Target Selected'}
                </h3>
              </div>
              {selectedObject && (
                <div className={`px-2.5 py-1 rounded text-xs font-mono font-medium ${
                  selectedObject.stage2Passed
                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                    : 'bg-rose-950 text-rose-400 border border-rose-800/60'
                }`}>
                  {selectedObject.stage2Passed ? 'PASS TO AI' : 'DROP NOISE'}
                </div>
              )}
            </div>

            {selectedObject ? (
              <div className="space-y-4">
                {/* Mathematical Filter Metrics */}
                <div className="space-y-3 pt-2 border-t border-slate-800">
                  {/* Metric 1: Angular Variance */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Angular Variance (Var(θ)):</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        {selectedObject.vectorVariance.toFixed(1)}°
                        <span className="text-slate-500 text-[10px] ml-1">/ max {filterParams.varianceThreshold}°</span>
                      </span>
                    </div>
                    <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          selectedObject.vectorVariance < filterParams.varianceThreshold
                            ? 'bg-emerald-500'
                            : 'bg-rose-500'
                        }`}
                        style={{
                          width: `${Math.min(100, (selectedObject.vectorVariance / (filterParams.varianceThreshold * 2)) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Metric 2: Net Displacement Ratio */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Net Displacement Ratio:</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        {(selectedObject.netDisplacementRatio * 100).toFixed(1)}%
                        <span className="text-slate-500 text-[10px] ml-1">/ min {(filterParams.minNetDisplacement * 100).toFixed(0)}%</span>
                      </span>
                    </div>
                    <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          selectedObject.netDisplacementRatio >= filterParams.minNetDisplacement
                            ? 'bg-emerald-500'
                            : 'bg-amber-500'
                        }`}
                        style={{
                          width: `${selectedObject.netDisplacementRatio * 100}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Metric 3: Aspect Ratio Deformation */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Shape Deformation Rate (ΔAR):</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        {selectedObject.aspectDeformation.toFixed(3)}
                        <span className="text-slate-500 text-[10px] ml-1">/ max {filterParams.maxAspectDeformation}</span>
                      </span>
                    </div>
                    <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          selectedObject.aspectDeformation <= filterParams.maxAspectDeformation
                            ? 'bg-emerald-500'
                            : 'bg-rose-500'
                        }`}
                        style={{
                          width: `${Math.min(100, (selectedObject.aspectDeformation / (filterParams.maxAspectDeformation * 2)) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Metric 4 (v2): Temporal predictability */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Temporal Erratic Score:</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        {selectedObject.temporalScore.toFixed(3)}
                        <span className="text-slate-500 text-[10px] ml-1">
                          / max {filterParams.maxErraticScore.toFixed(2)} · {selectedObject.temporalClass.replace('_', ' ')}
                        </span>
                      </span>
                    </div>
                    <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          selectedObject.temporalScore <= filterParams.maxErraticScore ? 'bg-sky-500' : 'bg-rose-500'
                        }`}
                        style={{
                          width: `${Math.min(100, (selectedObject.temporalScore / (filterParams.maxErraticScore * 2)) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Stride Cadence (if applicable) */}
                  <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-800/60">
                    <span className="text-slate-400">Stride Periodic Cadence:</span>
                    <span className="font-mono tabular-nums text-slate-300">
                      {selectedObject.strideFrequency > 0
                        ? `${selectedObject.strideFrequency.toFixed(2)} Hz (Bipedal Walk)`
                        : '0.00 Hz (Aperiodic)'}
                    </span>
                  </div>
                </div>

                {/* Filter Verdict Explanation */}
                <div className={`p-3 rounded-lg text-xs space-y-1 ${
                  selectedObject.stage2Passed
                    ? 'bg-emerald-950/40 border border-emerald-900/60 text-emerald-300'
                    : 'bg-slate-950/70 border border-slate-800 text-slate-300'
                }`}>
                  <div className="font-semibold text-slate-200">Stage 2 Evaluation Reason:</div>
                  <div className="font-mono text-[11px]">
                    {selectedObject.dropReason || 'Evaluating vector trajectory...'}
                  </div>
                  <div className="text-[11px] text-slate-400 pt-1">
                    {selectedObject.stage2Passed
                      ? 'Object exhibits spatial translation with consistent aspect ratio. Neural inference triggered.'
                      : 'Erratic vectors or non-translating motion detected. GPU inference eliminated early.'}
                  </div>
                </div>

                {/* Target switcher list */}
                <div className="space-y-1.5 pt-2 border-t border-slate-800">
                  <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Objects In Scene ({objectsRef.current.length}):
                  </div>
                  <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                    {objectsRef.current.map((obj) => (
                      <button
                        key={obj.id}
                        onClick={() => setSelectedObjectId(obj.id)}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer text-left ${
                          obj.id === selectedObjectId
                            ? 'bg-slate-800 text-white font-medium'
                            : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                        }`}
                      >
                        <span className="truncate">{obj.name}</span>
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                          obj.stage2Passed ? 'text-emerald-400' : 'text-slate-500'
                        }`}>
                          {obj.stage2Passed ? 'PASS' : 'DROP'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">Click any object in the video canvas above to inspect.</p>
            )}
          </div>

          {/* Running Benchmark Scorecard */}
          <div className="p-4 bg-slate-900/70 border border-slate-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400 font-medium">Session Energy Savings</span>
              <span className="text-xs font-mono text-emerald-400 font-semibold tabular-nums">
                -{stats.powerSavedPercent}% Compute
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800/80">
                <span className="text-slate-500 block text-[11px]">Noise Dropped (Early)</span>
                <span className="text-base font-semibold text-rose-400 font-mono tabular-nums">
                  {stats.droppedAtStage2}
                </span>
                <span className="text-[10px] text-slate-500 block mt-0.5">Bugs, trash & foliage</span>
              </div>
              <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800/80">
                <span className="text-slate-500 block text-[11px]">AI Inferences Run</span>
                <span className="text-base font-semibold text-emerald-400 font-mono tabular-nums">
                  {stats.passedToAi}
                </span>
                <span className="text-[10px] text-slate-500 block mt-0.5">Humans & vehicles</span>
              </div>
            </div>

            <div className="text-[11px] text-slate-500 leading-tight">
              Without EdgeFlow, <strong className="text-slate-300 font-medium">{stats.motionEvents} full neural model inferences</strong> would have executed on the edge GPU, draining power and triggering false alarms.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
