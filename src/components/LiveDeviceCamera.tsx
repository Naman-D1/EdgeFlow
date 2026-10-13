import React, { useRef, useEffect, useState, useCallback } from 'react';
import { 
  Camera, 
  CameraOff, 
  RotateCw, 
  FlipHorizontal, 
  CheckCircle2, 
  XCircle, 
  Zap, 
  Sliders, 
  Eye, 
  Info,
  Pause,
  Play,
  Sparkles,
  Video,
  MonitorPlay,
  RefreshCw
} from 'lucide-react';
import { FilterParameters } from '../types/pipeline';
import { OpenCVOpticalFlowEngine, RealFlowResult } from '../utils/opencvAdapter';
import type { TrackReport } from '../utils/blobTracker';

// Draw one box per tracked object: green = pass to next stage, red dashed = confidently trash,
// grey = not enough history yet (never treated as trash).
function drawTracks(ctx: CanvasRenderingContext2D, tracks: TrackReport[], sx: number, sy: number) {
  ctx.save();
  for (const t of tracks) {
    const x = t.box.x * sx, y = t.box.y * sy, w = t.box.width * sx, h = t.box.height * sy;
    const color = t.state === 'pass' ? '#10b981' : t.state === 'drop' ? '#f43f5e' : '#94a3b8';
    ctx.strokeStyle = color;
    ctx.lineWidth = t.state === 'pass' ? 3 : 2;
    ctx.setLineDash(t.state === 'pass' ? [] : t.state === 'drop' ? [4, 4] : [2, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    if (t.state !== 'drop' && t.predicted.length > 0) {
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y + h / 2);
      for (const p of t.predicted) ctx.lineTo(p.x * sx, p.y * sy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const label = `#${t.id} ${t.state === 'pass' ? 'KEEP' : t.state === 'drop' ? 'TRASH' : 'WATCHING'}`;
    ctx.font = '10px "JetBrains Mono", monospace';
    const lw = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(x, Math.max(0, y - 16), lw, 15);
    ctx.fillStyle = color;
    ctx.fillText(label, x + 5, Math.max(0, y - 16) + 11);
  }
  ctx.restore();
}

const SAMPLE_FPS = 10;

interface VideoStats {
  frames: number;          // sampled frames analysed
  keep: number;            // frames with at least one KEEP track
  lenient: number;         // frames with at least one KEEP or WATCHING track
  trash: number;           // frames with at least one TRASH track
  camera: number;          // frames skipped as camera motion
  reasons: Record<string, number>; // TRASH reasons, in track-frames
  seconds: number;         // video time reached
  uniqueKept: number;      // distinct tracks that were ever KEEP (object count)
  peakKept: number;        // most KEEP tracks visible in one frame
}
const emptyStats = (): VideoStats => ({ frames: 0, keep: 0, lenient: 0, trash: 0, camera: 0, reasons: {}, seconds: 0, uniqueKept: 0, peakKept: 0 });

interface LiveDeviceCameraProps {
  filterParams: FilterParameters;
}

export const LiveDeviceCamera: React.FC<LiveDeviceCameraProps> = ({ filterParams }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<OpenCVOpticalFlowEngine | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const [mode, setMode] = useState<'idle' | 'webcam' | 'virtual' | 'file'>('idle');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [isMirrored, setIsMirrored] = useState<boolean>(true);
  const [isFrozen, setIsFrozen] = useState<boolean>(false);
  const [showVectors, setShowVectors] = useState<boolean>(true);
  const [showMask, setShowMask] = useState<boolean>(true);
  const [isOpenCvReady, setIsOpenCvReady] = useState<boolean>(false);
  const [virtualScenario, setVirtualScenario] = useState<'human' | 'flutter_keys' | 'cloth_debris' | 'mixed'>('human');
  const [perObject, setPerObject] = useState<boolean>(true);

  // Uploaded-video analysis (mode 'file'): frames are sampled at SAMPLE_FPS of video time,
  // the rate the thresholds were evaluated at, whatever the file's own frame rate is.
  const [fileName, setFileName] = useState<string>('');
  const [fileDone, setFileDone] = useState<boolean>(false);
  const [viewAspect, setViewAspect] = useState<number>(4 / 3);
  const [speed, setSpeed] = useState<number>(1);
  const [videoStats, setVideoStats] = useState<VideoStats>(emptyStats());
  const statsRef = useRef<VideoStats>(emptyStats());
  const keptIdsRef = useRef<Set<number>>(new Set());
  const rowsRef = useRef<string[]>([]);
  const lastProcRef = useRef<number>(-1);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Live telemetry state for UI
  const [telemetry, setTelemetry] = useState<RealFlowResult>({
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
    dropReason: 'CAMERA_IDLE',
    isOpenCvBackend: false,
  });

  const [fps, setFps] = useState<number>(30);
  const frameCountRef = useRef<number>(0);
  const lastFpsCalcRef = useRef<number>(performance.now());
  const virtualTimeRef = useRef<number>(0);

  // Check OpenCV state
  useEffect(() => {
    engineRef.current = new OpenCVOpticalFlowEngine();

    const checkOpenCv = () => {
      if (engineRef.current?.isOpenCvReady()) {
        setIsOpenCvReady(true);
      }
    };

    checkOpenCv();
    window.addEventListener('opencv-ready', checkOpenCv);
    const interval = setInterval(checkOpenCv, 1000);

    return () => {
      window.removeEventListener('opencv-ready', checkOpenCv);
      clearInterval(interval);
      engineRef.current?.dispose();
    };
  }, []);

  // Create offscreen canvas for frame pixel processing
  useEffect(() => {
    if (!offscreenCanvasRef.current) {
      const off = document.createElement('canvas');
      off.width = 320;
      off.height = 240;
      offscreenCanvasRef.current = off;
    }
  }, []);

  // Start Camera Stream with progressive fallback
  const startCamera = async () => {
    setCameraError(null);
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('WebRTC Camera API (getUserMedia) is not supported or not allowed in this browser iframe context.');
      }

      let stream: MediaStream | null = null;

      // 1. Try with preferred resolution & facingMode
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: { ideal: facingMode },
          },
          audio: false,
        });
      } catch (err1) {
        console.warn('Initial camera constraints failed, attempting fallback to basic video...', err1);
        // 2. Try generic video: true fallback
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        } catch (err2) {
          throw err2;
        }
      }

      if (!stream) {
        throw new Error('No video stream received from camera device.');
      }

      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;

        // Ensure play begins once metadata is loaded
        video.onloadedmetadata = () => {
          video.play().catch((e) => console.warn('video.play() rejected:', e));
        };
      }

      setMode('webcam');
    } catch (err: any) {
      console.error('Camera access error:', err);
      let errorMsg = err.message || 'Camera permission denied or device busy.';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorMsg = 'Camera permission was denied. Please click the camera icon in your browser URL bar to allow access, or use the "Virtual Demo Camera" below.';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        errorMsg = 'No physical camera detected on this system. You can test all optical flow features using the "Virtual Demo Camera".';
      }
      setCameraError(errorMsg);
      setMode('idle');
    }
  };

  // Stop Camera Stream
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      if (objectUrlRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute('src');
        videoRef.current.load();
      }
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setViewAspect(4 / 3);
    setFileDone(false);
    setMode('idle');
    setCameraError(null);
  };

  // Analyse an uploaded video file with the same engine and settings as the live camera.
  const startVideoFile = (file: File) => {
    stopCamera();
    const video = videoRef.current;
    const off = offscreenCanvasRef.current;
    if (!video || !off) return;
    setCameraError(null);
    setFileName(file.name);
    setFileDone(false);
    setIsFrozen(false);
    setIsMirrored(false);
    statsRef.current = emptyStats();
    rowsRef.current = [];
    lastProcRef.current = -1;
    setVideoStats(emptyStats());
    keptIdsRef.current = new Set();
    engineRef.current?.resetState();

    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    video.srcObject = null;
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.loop = false;
    video.playbackRate = speed;
    video.onloadedmetadata = () => {
      const vw = video.videoWidth || 320, vh = video.videoHeight || 240;
      // Analyse at 320 px wide with the clip's own aspect ratio (what the evaluation scripts use).
      off.width = 320;
      off.height = Math.max(40, Math.round((320 * vh) / vw));
      setViewAspect(vw / vh);
      const c = canvasRef.current;
      if (c) { c.width = 640; c.height = Math.round((640 * vh) / vw); }
      video.play().catch((e) => console.warn('video.play() rejected:', e));
    };
    video.onended = () => setFileDone(true);
    video.onerror = () => {
      setCameraError('This browser could not decode that video file. Try an MP4 (H.264) or WebM.');
      stopCamera();
    };
    setMode('file');
  };

  const downloadCsv = () => {
    const csv = 'video_seconds,keep,keep_or_watching,trash,camera_motion,tracks\n' + rowsRef.current.join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${fileName || 'video'}-edgeflow.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const replayFile = () => {
    const video = videoRef.current;
    if (!video) return;
    statsRef.current = emptyStats();
    rowsRef.current = [];
    lastProcRef.current = -1;
    setVideoStats(emptyStats());
    keptIdsRef.current = new Set();
    setFileDone(false);
    engineRef.current?.resetState();
    video.currentTime = 0;
    video.play().catch(() => undefined);
  };

  // Start Virtual Camera Mode
  const startVirtualCamera = () => {
    stopCamera();
    setMode('virtual');
    setCameraError(null);
  };

  // Toggle Camera Facing Mode (Front / Rear)
  const toggleFacingMode = () => {
    const next = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(next);
    setIsMirrored(next === 'user');
    if (mode === 'webcam') {
      stopCamera();
      setTimeout(startCamera, 200);
    }
  };

  // Freeze also pauses an uploaded video; the speed buttons set its playback rate.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || mode !== 'file') return;
    if (isFrozen) v.pause();
    else if (!v.ended) v.play().catch(() => undefined);
  }, [isFrozen, mode]);
  useEffect(() => {
    if (videoRef.current && mode === 'file') videoRef.current.playbackRate = speed;
  }, [speed, mode]);

  // Main processing loop
  useEffect(() => {
    if (mode === 'idle' || isFrozen) return;

    const canvas = canvasRef.current;
    const offCanvas = offscreenCanvasRef.current;
    if (!canvas || !offCanvas) return;

    const ctx = canvas.getContext('2d');
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || !offCtx) return;

    const loop = () => {
      if (isFrozen) return;

      // File mode: analyse one frame per 1/SAMPLE_FPS s of video time, not per screen refresh.
      if (mode === 'file') {
        const v = videoRef.current;
        if (!v || v.readyState < 2) {
          animFrameRef.current = requestAnimationFrame(loop);
          return;
        }
        if (v.currentTime < lastProcRef.current) lastProcRef.current = -1; // seeked back
        if (v.currentTime - lastProcRef.current < 1 / SAMPLE_FPS - 1e-6) {
          animFrameRef.current = requestAnimationFrame(loop);
          return;
        }
        lastProcRef.current = v.currentTime;
      }

      const w = canvas.width;
      const h = canvas.height;
      const offW = offCanvas.width;
      const offH = offCanvas.height;

      // Clear main canvas overlay
      ctx.clearRect(0, 0, w, h);

      if (mode === 'webcam' || mode === 'file') {
        const video = videoRef.current;
        if (video && video.readyState >= 2) {
          // Render current video frame to offscreen canvas for vector analysis
          offCtx.save();
          if (mode === 'webcam' && isMirrored) {
            offCtx.translate(offW, 0);
            offCtx.scale(-1, 1);
          }
          offCtx.drawImage(video, 0, 0, offW, offH);
          offCtx.restore();

          // Extract frame data and run Optical Flow
          const imgData = offCtx.getImageData(0, 0, offW, offH);
          if (engineRef.current) {
            const result = engineRef.current.processFrame(imgData, 20, {
              varianceThreshold: filterParams.varianceThreshold,
              minNetDisplacement: filterParams.minNetDisplacement,
              maxAspectDeformation: filterParams.maxAspectDeformation,
            }, perObject ? { gate: filterParams } : undefined);

            setTelemetry(result);

            if (mode === 'file') {
              const st = statsRef.current;
              const tr = result.tracks ?? [];
              const cam = !!engineRef.current.cameraMotion;
              const k = tr.some((t) => t.state === 'pass');
              const l = tr.some((t) => t.state !== 'drop');
              const d = tr.some((t) => t.state === 'drop');
              st.frames++;
              let nowKept = 0;
              for (const t of tr) if (t.state === 'pass') { nowKept++; keptIdsRef.current.add(t.id); }
              st.uniqueKept = keptIdsRef.current.size;
              if (nowKept > st.peakKept) st.peakKept = nowKept;
              st.seconds = video.currentTime;
              if (k) st.keep++;
              if (l) st.lenient++;
              if (d) st.trash++;
              if (cam) st.camera++;
              for (const t of tr) if (t.state === 'drop') { const key = t.reason.split(' (')[0]; st.reasons[key] = (st.reasons[key] ?? 0) + 1; }
              rowsRef.current.push(`${video.currentTime.toFixed(2)},${+k},${+l},${+d},${+cam},${tr.length}`);
              if (st.frames % 5 === 0) setVideoStats({ ...st, reasons: { ...st.reasons } });
            }

            // Scale factor between offscreen analysis and display canvas
            const scaleX = w / offW;
            const scaleY = h / offH;

            // Render Stage 1 Pixel Mask
            if (showMask && !result.trackingMode && result.hasMotion && result.boundingBox) {
              const b = result.boundingBox;
              ctx.fillStyle = 'rgba(234, 179, 8, 0.22)';
              ctx.strokeStyle = 'rgba(234, 179, 8, 0.7)';
              ctx.lineWidth = 1.5;
              ctx.fillRect(b.x * scaleX, b.y * scaleY, b.width * scaleX, b.height * scaleY);
              ctx.strokeRect(b.x * scaleX, b.y * scaleY, b.width * scaleX, b.height * scaleY);
            }

            // Render Stage 2 Macroblock Vectors
            if (showVectors && result.vectors.length > 0) {
              ctx.lineWidth = 2.5;
              result.vectors.forEach((v) => {
                const vx = v.x * scaleX;
                const vy = v.y * scaleY;
                const vdx = v.dx * scaleX * 2.2;
                const vdy = v.dy * scaleY * 2.2;

                const vectorColor = result.stage2Passed ? '#34d399' : '#f87171';
                ctx.strokeStyle = vectorColor;
                ctx.fillStyle = vectorColor;

                ctx.beginPath();
                ctx.moveTo(vx, vy);
                ctx.lineTo(vx + vdx, vy + vdy);
                ctx.stroke();

                // Arrowhead
                const angle = Math.atan2(vdy, vdx);
                const headLen = 5;
                ctx.beginPath();
                ctx.moveTo(vx + vdx, vy + vdy);
                ctx.lineTo(
                  vx + vdx - headLen * Math.cos(angle - Math.PI / 6),
                  vy + vdy - headLen * Math.sin(angle - Math.PI / 6)
                );
                ctx.lineTo(
                  vx + vdx - headLen * Math.cos(angle + Math.PI / 6),
                  vy + vdy - headLen * Math.sin(angle + Math.PI / 6)
                );
                ctx.fill();
              });
            }

            if (result.trackingMode && result.tracks) {
              drawTracks(ctx, result.tracks, scaleX, scaleY);
            }

            // Render Stage 3 Bounding Box & Annotation (single global box; legacy mode only)
            if (!result.trackingMode && result.hasMotion && result.boundingBox) {
              const b = result.boundingBox;
              const bx = b.x * scaleX;
              const by = b.y * scaleY;
              const bw = b.width * scaleX;
              const bh = b.height * scaleY;

              ctx.save();
              if (result.stage2Passed) {
                // PASS TO AI
                ctx.strokeStyle = '#10b981';
                ctx.lineWidth = 3;
                ctx.strokeRect(bx, by, bw, bh);

                ctx.fillStyle = '#064e3b';
                ctx.fillRect(bx, Math.max(0, by - 26), 220, 24);
                ctx.fillStyle = '#6ee7b7';
                ctx.font = '11px "JetBrains Mono", monospace';
                ctx.fillText('STAGE 3 AI: HUMAN KINEMATICS', bx + 6, Math.max(0, by - 26) + 16);
              } else {
                // DROPPED AT STAGE 2
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
                ctx.lineWidth = 2;
                ctx.setLineDash([4, 4]);
                ctx.strokeRect(bx, by, bw, bh);
                ctx.setLineDash([]);

                ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
                ctx.fillRect(bx, Math.max(0, by - 24), 210, 22);
                ctx.fillStyle = '#f87171';
                ctx.font = '10px "JetBrains Mono", monospace';
                ctx.fillText('STAGE 2: FILTERED (DROP NOISE)', bx + 6, Math.max(0, by - 24) + 15);
              }
              ctx.restore();
            }
          }
        }
      } else if (mode === 'virtual') {
        // Virtual Camera Motion Simulator: Renders synthetic video into offscreen canvas,
        // then runs the EXACT SAME OpenCV optical flow code!
        virtualTimeRef.current += 0.033;
        const t = virtualTimeRef.current;

        // Render synthetic room backdrop
        offCtx.fillStyle = '#1e293b';
        offCtx.fillRect(0, 0, offW, offH);
        // Floor
        offCtx.fillStyle = '#0f172a';
        offCtx.fillRect(0, offH * 0.65, offW, offH * 0.35);

        // Render moving target based on scenario
        if (virtualScenario === 'mixed') {
          // Person walking on the left half while a fluttering object and tumbling debris share the frame
          const px = (Math.sin(t * 0.8) * 0.2 + 0.28) * offW;
          offCtx.fillStyle = '#38bdf8';
          offCtx.fillRect(px - 15, offH * 0.55 - 37, 30, 75);
          offCtx.fillStyle = '#f8fafc';
          offCtx.beginPath();
          offCtx.arc(px, offH * 0.55 - 49, 10, 0, Math.PI * 2);
          offCtx.fill();
          const mx = offW * 0.78 + Math.sin(t * 12) * 28;
          const my = offH * 0.25 + Math.cos(t * 16) * 22;
          offCtx.fillStyle = '#f43f5e';
          offCtx.beginPath();
          offCtx.arc(mx, my, 14, 0, Math.PI * 2);
          offCtx.fill();
          const dw = 40 + Math.sin(t * 8) * 28, dh = 40 + Math.cos(t * 7) * 28;
          const dx = offW * 0.68 + Math.sin(t * 1.5) * 22;
          offCtx.fillStyle = '#fbbf24';
          offCtx.fillRect(dx - dw / 2, offH * 0.55 - dh / 2, dw, dh);
        } else if (virtualScenario === 'human') {
          // Human walking smoothly across the screen: Coherent translation, stable aspect ratio
          const walkX = (Math.sin(t * 0.8) * 0.35 + 0.5) * offW;
          const walkY = offH * 0.55;
          const hw = 30;
          const hh = 75;
          // Body
          offCtx.fillStyle = '#38bdf8';
          offCtx.fillRect(walkX - hw / 2, walkY - hh / 2, hw, hh);
          // Head
          offCtx.fillStyle = '#f8fafc';
          offCtx.beginPath();
          offCtx.arc(walkX, walkY - hh / 2 - 12, 10, 0, Math.PI * 2);
          offCtx.fill();
        } else if (virtualScenario === 'flutter_keys') {
          // Rapid erratic insect / key flutter: High angular variance
          const mothX = offW * 0.5 + Math.sin(t * 12) * 45;
          const mothY = offH * 0.4 + Math.cos(t * 16) * 35;
          offCtx.fillStyle = '#f43f5e';
          offCtx.beginPath();
          offCtx.arc(mothX, mothY, 14, 0, Math.PI * 2);
          offCtx.fill();
        } else {
          // Debris / cloth: continuously deforming aspect ratio
          const debrisX = offW * 0.5 + Math.sin(t * 1.5) * 60;
          const debrisY = offH * 0.5;
          const stretchW = 40 + Math.sin(t * 8) * 28;
          const stretchH = 40 + Math.cos(t * 7) * 28;
          offCtx.fillStyle = '#fbbf24';
          offCtx.fillRect(debrisX - stretchW / 2, debrisY - stretchH / 2, stretchW, stretchH);
        }

        // Draw virtual camera video directly to main canvas background
        ctx.drawImage(offCanvas, 0, 0, w, h);

        // Now feed the image data to OpenCVOpticalFlowEngine
        const imgData = offCtx.getImageData(0, 0, offW, offH);
        if (engineRef.current) {
          const result = engineRef.current.processFrame(imgData, 20, {
            varianceThreshold: filterParams.varianceThreshold,
            minNetDisplacement: filterParams.minNetDisplacement,
            maxAspectDeformation: filterParams.maxAspectDeformation,
          }, perObject ? { gate: filterParams } : undefined);

          setTelemetry(result);

          // Render vectors & bounding boxes
          const scaleX = w / offW;
          const scaleY = h / offH;

          if (showVectors && result.vectors.length > 0) {
            ctx.lineWidth = 2.5;
            result.vectors.forEach((v) => {
              const vectorColor = result.stage2Passed ? '#34d399' : '#f87171';
              ctx.strokeStyle = vectorColor;
              ctx.fillStyle = vectorColor;
              ctx.beginPath();
              ctx.moveTo(v.x * scaleX, v.y * scaleY);
              ctx.lineTo((v.x + v.dx * 2.5) * scaleX, (v.y + v.dy * 2.5) * scaleY);
              ctx.stroke();
            });
          }

          if (result.trackingMode && result.tracks) {
            drawTracks(ctx, result.tracks, scaleX, scaleY);
          }

          if (!result.trackingMode && result.hasMotion && result.boundingBox) {
            const b = result.boundingBox;
            ctx.strokeStyle = result.stage2Passed ? '#10b981' : '#f43f5e';
            ctx.lineWidth = 2.5;
            ctx.strokeRect(b.x * scaleX, b.y * scaleY, b.width * scaleX, b.height * scaleY);

            ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
            ctx.fillRect(b.x * scaleX, Math.max(0, b.y * scaleY - 24), 210, 22);
            ctx.fillStyle = result.stage2Passed ? '#6ee7b7' : '#f87171';
            ctx.font = '10px "JetBrains Mono", monospace';
            ctx.fillText(
              result.stage2Passed ? 'STAGE 3 AI: HUMAN KINEMATICS' : 'STAGE 2: FILTERED (DROP NOISE)',
              b.x * scaleX + 6,
              Math.max(0, b.y * scaleY - 24) + 15
            );
          }
        }
      }

      // Calculate Frame FPS
      frameCountRef.current++;
      const now = performance.now();
      if (now - lastFpsCalcRef.current >= 1000) {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
        lastFpsCalcRef.current = now;
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [mode, isFrozen, isMirrored, showVectors, showMask, filterParams, virtualScenario, perObject]);

  return (
    <div className="space-y-6">
      {/* Device Camera Control Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-slate-900/60 border border-slate-800 rounded-xl">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${
            mode === 'webcam' ? 'bg-emerald-950 text-emerald-400' : mode === 'virtual' ? 'bg-cyan-950 text-cyan-400' : 'bg-slate-800 text-slate-400'
          }`}>
            <Camera className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <span>Live Device Camera Prototype</span>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                isOpenCvReady 
                  ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800/80' 
                  : 'bg-cyan-950/80 text-cyan-300 border-cyan-800/80'
              }`}>
                {isOpenCvReady ? 'OpenCV.js Ready (WASM)' : 'ISP Macroblock Kernel'}
              </span>
              {mode === 'webcam' && (
                <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  Live Webcam
                </span>
              )}
              {mode === 'virtual' && (
                <span className="text-[10px] font-mono text-cyan-400">
                  Virtual Camera Test Stream
                </span>
              )}
              {mode === 'file' && (
                <span className="text-[10px] font-mono text-violet-300 truncate max-w-[220px]">
                  Video file: {fileName}
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-400">
              Computes optical flow vectors in real time to filter noise and pass structured human motion.
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {mode === 'idle' ? (
            <>
              <button
                onClick={startCamera}
                className="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 rounded-lg hover:bg-emerald-300 transition-colors flex items-center gap-2 cursor-pointer shadow-sm shadow-emerald-500/20"
              >
                <Camera className="w-4 h-4" />
                <span>Enable Device Camera</span>
              </button>
              <button
                onClick={startVirtualCamera}
                className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
              >
                <MonitorPlay className="w-4 h-4 text-cyan-400" />
                <span>Virtual Demo Camera</span>
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
              >
                <Play className="w-4 h-4 text-violet-300" />
                <span>Analyze Video File</span>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setIsFrozen(!isFrozen)}
                className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                title={isFrozen ? 'Resume live feed' : 'Freeze frame to inspect vector math'}
              >
                {isFrozen ? <Play className="w-3.5 h-3.5 text-emerald-400" /> : <Pause className="w-3.5 h-3.5" />}
                <span>{isFrozen ? 'Resume' : 'Freeze'}</span>
              </button>

              {mode === 'webcam' && (
                <>
                  <button
                    onClick={() => setIsMirrored(!isMirrored)}
                    className="p-2 text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                    title="Mirror Camera View"
                  >
                    <FlipHorizontal className="w-4 h-4" />
                  </button>
                  <button
                    onClick={toggleFacingMode}
                    className="p-2 text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                    title="Switch Camera (Front / Rear)"
                  >
                    <RotateCw className="w-4 h-4" />
                  </button>
                </>
              )}

              {mode === 'file' && (
                <>
                  <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
                    {[1, 2, 4].map((sp) => (
                      <button
                        key={sp}
                        onClick={() => setSpeed(sp)}
                        className={`px-2 py-1 text-[11px] font-medium rounded ${speed === sp ? 'bg-slate-800 text-white' : 'text-slate-400'}`}
                        title="Playback speed (analysis still samples every 0.1 s of video time)"
                      >
                        {sp}x
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={replayFile}
                    className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Replay</span>
                  </button>
                  <button
                    onClick={downloadCsv}
                    className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                    title="One row per analysed frame"
                  >
                    Download CSV
                  </button>
                </>
              )}

              {mode === 'virtual' && (
                <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
                  <button
                    onClick={() => setVirtualScenario('human')}
                    className={`px-2 py-1 text-[11px] font-medium rounded ${
                      virtualScenario === 'human' ? 'bg-slate-800 text-white' : 'text-slate-400'
                    }`}
                  >
                    Human Walk
                  </button>
                  <button
                    onClick={() => setVirtualScenario('flutter_keys')}
                    className={`px-2 py-1 text-[11px] font-medium rounded ${
                      virtualScenario === 'flutter_keys' ? 'bg-slate-800 text-white' : 'text-slate-400'
                    }`}
                  >
                    Erratic Flutter
                  </button>
                  <button
                    onClick={() => setVirtualScenario('cloth_debris')}
                    className={`px-2 py-1 text-[11px] font-medium rounded ${
                      virtualScenario === 'cloth_debris' ? 'bg-slate-800 text-white' : 'text-slate-400'
                    }`}
                  >
                    Debris Tumbling
                  </button>
                  <button
                    onClick={() => setVirtualScenario('mixed')}
                    className={`px-2 py-1 text-[11px] font-medium rounded ${
                      virtualScenario === 'mixed' ? 'bg-slate-800 text-white' : 'text-slate-400'
                    }`}
                  >
                    Mixed Scene
                  </button>
                </div>
              )}

              <button
                onClick={() => setPerObject((v) => !v)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                  perObject
                    ? 'bg-emerald-950/70 text-emerald-300 border-emerald-800/80'
                    : 'bg-slate-800 text-slate-300 border-slate-700'
                }`}
                title="Track each moving object separately (instead of one global box)"
              >
                {perObject ? 'Per-object tracking: ON' : 'Per-object tracking: OFF'}
              </button>

              <button
                onClick={stopCamera}
                className="px-3.5 py-1.5 text-xs font-semibold text-rose-300 bg-rose-950/80 border border-rose-800/80 hover:bg-rose-900 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <CameraOff className="w-3.5 h-3.5" />
                <span>Stop</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Camera Error / Permission Notice */}
      {cameraError && (
        <div className="p-4 bg-slate-900 border border-rose-800/80 rounded-xl text-xs space-y-3">
          <div className="flex items-start gap-2.5 text-rose-300">
            <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-semibold block">Camera Access Notice:</span>
              <p className="text-slate-300 leading-relaxed">{cameraError}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 pl-6">
            <button
              onClick={startVirtualCamera}
              className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold rounded text-xs transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <MonitorPlay className="w-3.5 h-3.5" />
              <span>Use Virtual Demo Camera Instead</span>
            </button>
            <button
              onClick={startCamera}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Permission</span>
            </button>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        data-testid="video-file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) startVideoFile(f);
          e.target.value = '';
        }}
      />

      {mode === 'file' && (
        <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl text-xs space-y-3" data-testid="video-results">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-200">
              Video results {fileDone ? '(finished)' : '(analysing)'}: {videoStats.frames} frames sampled at {SAMPLE_FPS}/s, {videoStats.seconds.toFixed(1)} s of video
            </span>
            <span className="text-slate-500">Frames are judged on tracks, so "forwarded" means it would reach Stage 3.</span>
          </div>
          {(() => {
            const n = Math.max(1, videoStats.frames);
            const pct = (x: number) => ((100 * x) / n).toFixed(1) + '%';
            const cells: [string, string, string][] = [
              ['Forwarded (KEEP)', pct(videoStats.keep), 'text-emerald-400'],
              ['KEEP or watching', pct(videoStats.lenient), 'text-slate-200'],
              ['Has TRASH track', pct(videoStats.trash), 'text-rose-400'],
              ['Camera motion (skipped)', pct(videoStats.camera), 'text-amber-300'],
              ['Moving objects counted', String(videoStats.uniqueKept), 'text-sky-300'],
              ['Most at once', String(videoStats.peakKept), 'text-sky-300'],
            ];
            return (<>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {cells.map(([label, value, color]) => (
                  <div key={label} className="bg-slate-950 border border-slate-800 rounded-lg p-3">
                    <span className="text-slate-500 block text-[10px]">{label}</span>
                    <span className={`font-mono text-base ${color}`}>{value}</span>
                  </div>
                ))}
              </div>
              <p className="text-slate-500 text-[10px]">
                Counts are moving objects that passed the filter (one per tracked blob). EdgeFlow does not identify what an object is, so in a scene of people this approximates a head count; a tight group may count as one, and a track that breaks and restarts is counted again, so the total can run high on long clips. &quot;Most at once&quot; is the steadier figure.
              </p>
            </>);
          })()}
          {Object.keys(videoStats.reasons).length > 0 && (
            <p className="text-slate-400">
              Why tracks were dropped (track-frames):{' '}
              {Object.entries(videoStats.reasons)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([r, c]) => `${r} ${c}`)
                .join(', ')}
            </p>
          )}
        </div>
      )}

      {/* Main Viewport Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Camera Viewport (Left 8 cols) */}
        <div className="lg:col-span-8 space-y-3">
          <div style={{ aspectRatio: String(viewAspect) }} className="relative rounded-xl overflow-hidden border border-slate-800 bg-slate-950 shadow-2xl">
            {/* Live Hardware Video Element (rendered directly for guaranteed 60fps & no black frames) */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${
                (mode === 'webcam' || mode === 'file') ? 'opacity-100' : 'opacity-0 pointer-events-none'
              } ${mode === 'webcam' && isMirrored ? 'scale-x-[-1]' : ''}`}
            />

            {/* Canvas Overlay for Vectors & Bounding Boxes */}
            <canvas
              ref={canvasRef}
              width={640}
              height={480}
              className="absolute inset-0 w-full h-full object-cover block z-10"
            />

            {/* When Camera is idle: Friendly Launch Splash */}
            {mode === 'idle' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center space-y-4 bg-slate-950 z-20">
                <div className="p-4 rounded-full bg-slate-900 border border-slate-800 text-slate-400">
                  <Camera className="w-8 h-8 text-emerald-400" />
                </div>
                <div className="max-w-md space-y-1.5">
                  <h4 className="text-base font-bold text-white">Camera Prototype Ready</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Connect your webcam to test the real-time optical flow vector analysis pipeline, or use the Virtual Demo Stream to test physical motion scenarios.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={startCamera}
                    className="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 rounded-lg hover:bg-emerald-300 transition-colors flex items-center gap-2 cursor-pointer shadow-sm shadow-emerald-500/20"
                  >
                    <Camera className="w-4 h-4" />
                    <span>Launch Device Camera</span>
                  </button>
                  <button
                    onClick={startVirtualCamera}
                    className="px-4 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <MonitorPlay className="w-4 h-4 text-cyan-400" />
                    <span>Virtual Demo Stream</span>
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="px-4 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <Play className="w-4 h-4 text-violet-300" />
                    <span>Analyze Video File</span>
                  </button>
                </div>
              </div>
            )}

            {/* In-canvas overlay settings */}
            {mode !== 'idle' && (
              <div className="absolute bottom-3 right-3 flex items-center gap-2 bg-slate-950/85 backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-800 text-xs z-30">
                <label className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
                  <input
                    type="checkbox"
                    checked={showVectors}
                    onChange={(e) => setShowVectors(e.target.checked)}
                    className="rounded bg-slate-900 border-slate-700 text-emerald-500 focus:ring-0"
                  />
                  <span>Vector Arrows</span>
                </label>
                <span className="text-slate-600">·</span>
                <label className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
                  <input
                    type="checkbox"
                    checked={showMask}
                    onChange={(e) => setShowMask(e.target.checked)}
                    className="rounded bg-slate-900 border-slate-700 text-emerald-500 focus:ring-0"
                  />
                  <span>Stage 1 Mask</span>
                </label>
              </div>
            )}
          </div>

          {/* Real-World Quick Testing Playbook */}
          <div className="p-4 bg-slate-900/40 border border-slate-800/80 rounded-xl space-y-2.5">
            <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              <span>Physical Motion Experiments (Try with Your Camera)</span>
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800/80 space-y-1">
                <span className="font-semibold text-rose-400 block">1. Erratic Jitter Test</span>
                <p className="text-[11px] text-slate-400 leading-tight">
                  Rapidly shake keys or flutter fingers in circles $\rightarrow$ Angular variance spikes $\rightarrow$ <strong>DROPPED (Noise)</strong>.
                </p>
              </div>
              <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800/80 space-y-1">
                <span className="font-semibold text-amber-400 block">2. Debris / Cloth Test</span>
                <p className="text-[11px] text-slate-400 leading-tight">
                  Tumble a napkin or crumpled cloth $\rightarrow$ Aspect ratio deforms continuously $\rightarrow$ <strong>DROPPED (Debris)</strong>.
                </p>
              </div>
              <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800/80 space-y-1">
                <span className="font-semibold text-emerald-400 block">3. Human Motion Test</span>
                <p className="text-[11px] text-slate-400 leading-tight">
                  Walk or step across the frame with upright posture $\rightarrow$ Coherent translation verified $\rightarrow$ <strong>PASS TO AI</strong>!
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Live Vector Telemetry & Decision Inspector (Right 4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          {telemetry.trackingMode && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-2">
              <h4 className="text-xs font-semibold text-slate-200">Tracked objects ({telemetry.tracks?.length ?? 0})</h4>
              {(telemetry.tracks ?? []).length === 0 && (
                <p className="text-[11px] text-slate-500">Nothing is moving.</p>
              )}
              {(telemetry.tracks ?? []).map((t) => (
                <div key={t.id} className="text-[11px] font-mono flex justify-between gap-2 border-t border-slate-800 pt-1">
                  <span className={t.state === 'pass' ? 'text-emerald-400' : t.state === 'drop' ? 'text-rose-400' : 'text-slate-400'}>
                    #{t.id} {t.state === 'pass' ? 'KEEP' : t.state === 'drop' ? 'TRASH' : 'WATCHING'}
                  </span>
                  <span className="text-slate-500 truncate" title={t.reason}>{t.reason}</span>
                </div>
              ))}
            </div>
          )}
          <div className="p-5 bg-slate-900/70 border border-slate-800 rounded-xl space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-xs text-slate-500 font-mono">LIVE ISP TELEMETRY</span>
                <h3 className="text-base font-semibold text-white tracking-tight">
                  Optical Flow Analyzer
                </h3>
              </div>
              <div className={`px-2.5 py-1 rounded text-xs font-mono font-medium ${
                telemetry.verdict === 'PASS to AI'
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                  : telemetry.verdict === 'DROP (Noise)'
                  ? 'bg-rose-950 text-rose-400 border border-rose-800/60'
                  : 'bg-slate-800 text-slate-400'
              }`}>
                {telemetry.verdict}
              </div>
            </div>

            {/* Live Numerical Readouts */}
            <div className="space-y-3 pt-2 border-t border-slate-800">
              {/* Metric 1: Angular Variance */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Angular Vector Variance:</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {telemetry.vectorVariance.toFixed(1)}°
                    <span className="text-slate-500 text-[10px] ml-1">/ max {filterParams.varianceThreshold}°</span>
                  </span>
                </div>
                <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-150 ${
                      telemetry.vectorVariance < filterParams.varianceThreshold
                        ? 'bg-emerald-500'
                        : 'bg-rose-500'
                    }`}
                    style={{
                      width: `${Math.min(100, (telemetry.vectorVariance / (filterParams.varianceThreshold * 2)) * 100)}%`,
                    }}
                  />
                </div>
              </div>

              {/* Metric 2: Net Displacement */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Net Displacement Ratio:</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {(telemetry.netDisplacementRatio * 100).toFixed(0)}%
                    <span className="text-slate-500 text-[10px] ml-1">/ min {(filterParams.minNetDisplacement * 100).toFixed(0)}%</span>
                  </span>
                </div>
                <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-150 ${
                      telemetry.netDisplacementRatio >= filterParams.minNetDisplacement
                        ? 'bg-emerald-500'
                        : 'bg-amber-500'
                    }`}
                    style={{
                      width: `${telemetry.netDisplacementRatio * 100}%`,
                    }}
                  />
                </div>
              </div>

              {/* Metric 3: Shape Deformation */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Shape Deformation Rate (ΔAR):</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {telemetry.aspectDeformation.toFixed(2)}
                    <span className="text-slate-500 text-[10px] ml-1">/ max {filterParams.maxAspectDeformation.toFixed(2)}</span>
                  </span>
                </div>
                <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-150 ${
                      telemetry.aspectDeformation <= filterParams.maxAspectDeformation
                        ? 'bg-emerald-500'
                        : 'bg-rose-500'
                    }`}
                    style={{
                      width: `${Math.min(100, (telemetry.aspectDeformation / (filterParams.maxAspectDeformation * 2)) * 100)}%`,
                    }}
                  />
                </div>
              </div>

              {/* Pixel Shift Load */}
              <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-800/60">
                <span className="text-slate-400">Stage 1 Pixel Shift:</span>
                <span className="font-mono tabular-nums text-slate-300">
                  {telemetry.pixelShiftPercent.toFixed(1)}% of frame
                </span>
              </div>
            </div>

            {/* Verdict Explanation Box */}
            <div className={`p-3 rounded-lg text-xs space-y-1 ${
              telemetry.stage2Passed
                ? 'bg-emerald-950/40 border border-emerald-900/60 text-emerald-300'
                : 'bg-slate-950/70 border border-slate-800 text-slate-300'
            }`}>
              <div className="font-semibold text-slate-200">Current Pipeline Decision:</div>
              <div className="font-mono text-[11px]">
                {telemetry.dropReason}
              </div>
            </div>
          </div>

          {/* Hardware & Stream Stats */}
          <div className="p-4 bg-slate-900/70 border border-slate-800 rounded-xl space-y-2 text-xs">
            <span className="text-slate-400 font-semibold uppercase tracking-wider block text-[10px]">
              Active Stream Details
            </span>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2 bg-slate-950 rounded border border-slate-800">
                <span className="text-slate-500 block text-[10px]">Engine FPS</span>
                <span className="font-mono text-emerald-400 font-semibold">{fps} FPS</span>
              </div>
              <div className="p-2 bg-slate-950 rounded border border-slate-800">
                <span className="text-slate-500 block text-[10px]">Vectors Tracked</span>
                <span className="font-mono text-cyan-400 font-semibold">{telemetry.vectors.length} blocks</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
