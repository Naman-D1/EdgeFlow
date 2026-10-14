EdgeFlow

A browser-based prototype of a motion-filtering cascade for edge cameras: cheap motion cues decide whether an expensive AI model needs to run at all, so a wind-blown bag or a moth doesn't wake the heavy model but a person or vehicle does.

Current version: v2: temporal speculation.

*See What's new in v2...*

The project is a React + TypeScript + Vite app. 
How the cascade works
Frame ──► Stage 1: pixel change ──► Stage 2: motion heuristics ──► Stage 3: heavy AI
          (is anything moving?)      (does it move like an agent?)   (what is it?)

Stage 1: pixel motion. Frame differencing on luminance; a frame counts as "moving" only if enough of it changed.

Stage 2: motion heuristics. Per object, over recent frames:

Check	What it measures	Typical culprit it drops
Angular variance	How scattered the motion directions are	Insects
Net displacement ratio	Net distance ÷ total path length	Swaying foliage
Aspect deformation (ΔAR)	How fast the shape changes	Tumbling debris
Temporal erratic score (v2)	How badly a constant-velocity predictor misses the next position	Unpredictable movers (debris, insects)

Stage 3: heavy AI. Runs only on objects that pass Stage 2. It is a stub (see Known limitations).

Running it

Requires a recent Node.js (tested on Node 22).

bash
npm install
npm run dev      # http://localhost:3000

Other scripts: npm run build (production build), npm run lint (type-check).

No API key is needed. .env.example contains a Gemini key placeholder inherited from the Google AI Studio template, but nothing in src/ uses it.

The camera tab asks for webcam permission. Browsers only allow this on localhost or HTTPS.

The app's tabs
Tab	What it is
Device Camera (OpenCV)	Live webcam through the frame-differencing + block-matching engine in src/utils/opencvAdapter.ts
Synthetic Simulator	Scripted objects (person, vehicle, trash, insect, foliage) through the full cascade. Best place to see v2.
Architecture Spec	Walkthrough of the cascade design
Signal Profiles	The Stage 2 criteria and the signal signature each object class produces
Hardware Benchmarks	Modelled power figures for example SoCs (src/utils/hardwareProfiles.ts)
TCO calculator	Fleet cost model built on those same figures

The hardware and TCO tabs show modelled numbers, hardcoded constants. Nothing in this repo measures real hardware.

What's new in v2: temporal speculation

v2 adds a per-object score for how predictable its motion has been, and a projection of where it will go next.

How it works (src/utils/temporalSpeculation.ts, one pure function, speculate(history)):

Prediction error: predict each step from the previous two with a constant-velocity model, and measure the miss relative to the object's speed.
Turn rate: mean heading change per frame on frames where the object is actually moving.
Straightness: net displacement ÷ path length.
These combine into an erratic score (0 = smooth, 1 = erratic) and a class: smooth_translating, oscillating, erratic, or warmup.
The next 12 positions are projected with damping that grows with the erratic score, so uncertain tracks fade toward standing still.

In the simulator:

Dashed blue ghost paths show each object's projected route, fading with confidence.
The Stage 2 panel has a new Temporal Erratic Score row.
The tuner has a Temporal Speculation card with an ON / OFF (v1) switch and a max-score slider, so v1 and v2 can be compared live.
Tracks above the cutoff are dropped with the reason UNPREDICTABLE_TRAJECTORY.

Simulator A/B result (60 randomized runs; share of frames passed on to Stage 3):

Object	v1	v2
Person	100%	100%
Child	100%	100%
Vehicle	100%	100%
Windblown trash	100%	~0.6%
Swaying foliage	~38%	~0.6%
Insect	~4%	0%

Read these numbers carefully. They come from the simulator's own synthetic, noiseless motion, and the default cutoff (0.1) was chosen against that same data. They show the gate works as designed, not how it will perform on real footage. Real tracked-box centroids jitter, so real people will score higher than the simulated ones and the cutoff will need re-tuning on real clips.

Other change: package.json pinned esbuild ^0.25, which conflicted with Vite 8's peer range, so a clean npm install failed with ERESOLVE. It is now ^0.27.

Known limitations
The live-camera path does not use v2. It draws a single bounding box around everything that changed in the frame, with no per-object tracking, so a person and a plastic bag in view merge into one object. Temporal scoring needs per-object tracks. (historyTrajectories in opencvAdapter.ts is collected but not used in the decision.)
The simulator partly grades itself. Stage 3 labels and strideFrequency are looked up from the object's type, not computed from motion, and the object kinematics were written to look like their class. Simulator results demonstrate the pipeline's logic, not detection accuracy.
Stage 3 is a stub. No model runs; "AI classification" is a lookup.
Thresholds are unvalidated against real footage (Stage 2 defaults and the v2 cutoff alike).
No automated tests.
Roadmap
Blob tracker for the live path: group active macroblocks into blobs, match them to tracks using speculate()'s predicted positions, and run the Stage 2 gate per track.
Calibrate on real clips (people, vehicles, debris) and replace hand-picked thresholds with fitted ones.
Gait periodicity as a human-specific feature. This needs a longer history than the current 24-frame window.
A real Stage 3 model, and measured (not modelled) hardware numbers.
History

The previous README documented v0.1, a Python/OpenCV prototype using MOG2 background subtraction, nearest-centroid tracking and hand-tuned motion heuristics, with a simulated heavy-AI stub. That script is not in this repository's current files. The old README text is still available in git history: git show c80c464:README.md.

Credits

Original EdgeFlow project: soumyadhoke-sys. v2 temporal speculation: Naman Sharma (Naman-D1).
