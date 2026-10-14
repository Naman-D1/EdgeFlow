# EdgeFlow

A browser-based prototype of a **motion-filtering cascade for edge cameras**: cheap motion cues decide whether an expensive AI model needs to run at all, so a wind-blown bag or a moth doesn't wake the heavy model but a person or vehicle does.

**Current version: v2.2.5** — temporal speculation (v2), bounding-box rigidity & size layer (v2.1), per-object blob tracker (v2.2), camera-motion guard (v2.2.2), configurable Stage 1 gate (v2.2.3), video-file analysis (v2.2.4) and moving-object count (v2.2.5). See the sections below.

> The project is a React + TypeScript + Vite app. Earlier versions of this README described a Python/OpenCV script (`edge_motion_filter.py`); that script is not in this repository. See [History](#history).

---

## How the cascade works:

```
Frame ──► Stage 1: pixel change ──► Stage 2: motion heuristics ──► Stage 3: heavy AI
          (is anything moving?)      (does it move like an agent?)   (what is it?)
```

**Stage 1: pixel motion.** Frame differencing on luminance; a frame counts as "moving" only if enough of it changed.

**Stage 2: motion heuristics.** Per object, over recent frames:

| Check | What it measures | Typical culprit it drops |
|---|---|---|
| Angular variance | How scattered the motion directions are | Insects |
| Net displacement ratio | Net distance ÷ total path length | Swaying foliage |
| Aspect deformation (ΔAR) | How fast the shape changes | Tumbling debris |
| **Temporal erratic score** *(v2)* | How badly a constant-velocity predictor misses the next position | Unpredictable movers (debris, insects) |
| **Minimum size** *(v2.1)* | Mean box area as a fraction of the frame | Insects and other specks |
| **BBox geometric chaos** *(v2.1, experimental, off by default)* | How much the box's area and aspect ratio wobble around their trend | Crumpling bags and litter |

**Stage 3: heavy AI.** Runs only on objects that pass Stage 2. **It is a stub** (see [Known limitations](#known-limitations)).

---

## Running it

Requires a recent Node.js (tested on Node 22).

```bash
npm install
npm run dev      # http://localhost:3000
```

Other scripts: `npm run build` (production build), `npm run lint` (type-check).

No API key is needed. `.env.example` contains a Gemini key placeholder inherited from the Google AI Studio template, but nothing in `src/` uses it.

The camera tab asks for webcam permission. Browsers only allow this on `localhost` or HTTPS.

### The app's tabs

| Tab | What it is |
|---|---|
| **Device Camera (OpenCV)** | Live webcam through the frame-differencing + block-matching engine in `src/utils/opencvAdapter.ts` |
| **Synthetic Simulator** | Scripted objects (person, vehicle, trash, insect, foliage) through the full cascade. **Best place to see v2.** |
| **Architecture Spec** | Walkthrough of the cascade design |
| **Signal Profiles** | The Stage 2 criteria and the signal signature each object class produces |
| **Hardware Benchmarks** | Modelled power figures for example SoCs (`src/utils/hardwareProfiles.ts`) |
| **TCO calculator** | Fleet cost model built on those same figures |

The hardware and TCO tabs show **modelled** numbers, hardcoded constants. Nothing in this repo measures real hardware.

---

## What's new in v2: temporal speculation

v2 adds a per-object score for how *predictable* its motion has been, and a projection of where it will go next.

**How it works** (`src/utils/temporalSpeculation.ts`, one pure function, `speculate(history)`):

1. **Prediction error:** predict each step from the previous two with a constant-velocity model, and measure the miss relative to the object's speed.
2. **Turn rate:** mean heading change per frame on frames where the object is actually moving.
3. **Straightness:** net displacement ÷ path length.
4. These combine into an **erratic score** (0 = smooth, 1 = erratic) and a class: `smooth_translating`, `oscillating`, `erratic`, or `warmup`.
5. The next 12 positions are projected with damping that grows with the erratic score, so uncertain tracks fade toward standing still.

**In the simulator:**
- Dashed blue ghost paths show each object's projected route, fading with confidence.
- The Stage 2 panel has a new **Temporal Erratic Score** row.
- The tuner has a **Temporal Speculation** card with an ON / OFF (v1) switch and a max-score slider, so v1 and v2 can be compared live.
- Tracks above the cutoff are dropped with the reason `UNPREDICTABLE_TRAJECTORY`.

**Simulator A/B result** (60 randomized runs; share of frames passed on to Stage 3):

| Object | v1 | v2 |
|---|---|---|
| Person | 100% | 100% |
| Child | 100% | 100% |
| Vehicle | 100% | 100% |
| Windblown trash | 100% | ~0.6% |
| Swaying foliage | ~38% | ~0.6% |
| Insect | ~4% | 0% |

**Read these numbers carefully.** They come from the simulator's own synthetic, noiseless motion, and the default cutoff (`0.1`) was chosen against that same data. They show the gate works as designed, not how it will perform on real footage. Real tracked-box centroids jitter, so real people will score higher than the simulated ones and the cutoff will need re-tuning on real clips.

**Other change:** `package.json` pinned `esbuild ^0.25`, which conflicted with Vite 8's peer range, so a clean `npm install` failed with `ERESOLVE`. It is now `^0.27`.

---

## v2.1: BBox rigidity & geometric stability

A second verification layer that looks only at the track's bounding-box history (`src/utils/bboxStability.ts`, `analyzeBBox(boxes, frameArea)`).

1. **Size gate:** tracks whose mean area is below a fraction of the frame (default 0.1%) are dropped as `BELOW_MIN_SIZE`.
2. **Rigidity:** area and aspect ratio are measured in log units, a straight line is fitted and **removed**, and the RMS of what's left becomes the **chaos score**. Removing the trend matters: a car driving toward the camera grows steadily, and that systematic growth is not counted as deformation.
3. Chaos at or above the cutoff (default `0.2`) is dropped as `UNSTABLE_BBOX_GEOMETRY`.

The two gates are **independent switches**. The size gate is **on** by default. Rigidity is **off** by default, because it is the least validated gate and the one most likely to drop a real person (see below). Both are skipped while a track has too little history.

In the simulator the Stage 2 panel shows the chaos score, a verdict (`rigid` / `flexing` / `chaotic` / `too small`) and the box's share of the frame; the tuner has two cards, **Size Gate** and **BBox Rigidity (experimental)**, each with its own switch and slider. The numbers keep updating while a gate is off, tagged "(gate off)", so you can see what it would have done.

**Ablation on the simulator** (share of frames passed to Stage 3; person, child and vehicle stayed at **100%** in every row):

| Temporal gate | Size gate | Rigidity | Trash | Foliage | Insect |
|---|---|---|---|---|---|
| off (v1) | off | off | 100% | 38% | 3.5% |
| off | on | off | 100% | 37% | 0% |
| off | off | on | 12.6% | 39% | 2.3% |
| on (cutoff 0.10) | off | off | 0.8% | 0.4% | 0% |
| on (cutoff 0.10) | on | off *(default)* | 0.5% | 0.5% | 0% |
| on (cutoff 0.10) | on | on | 0% | 0.5% | 0% |
| loosened (cutoff 0.30) | on | off | 58% | 3.2% | 0% |
| loosened (cutoff 0.30) | on | on | 2.2% | 3.0% | 0% |

How to read it:
- **Rigidity only matters when the temporal gate is loose or off.** With the temporal cutoff at its default, it removes almost nothing extra. That, plus its risk to real people, is why it is off by default.
- **The size gate adds little in the simulator** because v1's other checks already drop most simulated insects. Its value would be for specks and noise that the simulator doesn't produce, which is untested.
- Neither catches swaying foliage on its own; that is the job of the net-displacement check.

**What this layer cannot do (tested on synthetic box histories):**

- **Rigid litter passes.** A cardboard box sliding along keeps a constant box, so it scores as perfectly stable. Rigidity separates *deforming* trash from agents; it does not separate trash from agents in general.
- **A person can fail it.** With the box width swinging ±20% (a large arm swing) the chaos score is about 0.14-0.17, below the default cutoff. A flailing or running person with ±35% swing scores about 0.26-0.28, the same range as a crumpling bag (about 0.23-0.26). Amplitude alone cannot tell those apart. Since the goal is to never miss a real person, treat this as a real risk.
- **Noisy boxes shrink the margin.** Boxes built from frame differencing jitter. With 3-8% random noise on width and height, a perfectly rigid box scores 0.04-0.11, close to the `chaotic` cutoff.
- **The size gate drops distant people.** A person far from the camera can be smaller than a bug near it. The minimum size is a scene-dependent setting, not a universal rule.

These magnitudes (arm swing, noise) are assumptions used for stress-testing, not measurements from real footage.

---

## v2.2: per-object tracking on the live camera path

The live path used to put one box around everything that moved. It now has an optional per-object mode (on by default, toggle "Per-object tracking" above the camera view) in `src/utils/blobTracker.ts`:

1. Active macroblocks are grouped into blobs (union-find; `linkRadius` bridges the gaps frame differencing leaves inside an object).
2. Blobs are matched to tracks greedily, nearest to each track's predicted position, with a per-pair gate. Unmatched tracks coast on their prediction for a few frames.
3. Each track keeps its own 24-sample box history and runs the same gates as the simulator: angular variance, net displacement, aspect deformation, temporal speculation, size gate, and (optionally) rigidity.
4. Votes over the last 5 frames decide the state, and the vote is deliberately asymmetric: 4 drop votes to start dropping a track, 2 or fewer to release it. A track is `WATCHING` until it has 8 samples, and `WATCHING` is never treated as trash. When in doubt, it passes.

Real boxes jitter by a pixel or two, which made slow smooth movers look erratic to the temporal gate. `speculate()` now takes an optional `noiseFloor` (px); prediction error below it is ignored. The tracker uses 4 px at 320x240; the simulator keeps 0.

`npx tsx scripts/trackerSim.ts -v` runs synthetic scenes (person, vehicle, flutter, tumbling cloth, mixed) through the real engine and prints per-scene verdict rates.

**What the synthetic runs showed** (320x240, no sensor noise, correlated textures): a lone person and a lone vehicle are kept ~100% / ~98% of frames; tumbling cloth is dropped 90-100%; a 14x14 flutterer never reaches Stage 2 because Stage 1's 0.45% gate removes it first. When trash and a real object overlap or cross, blobs merge and the real object's verdict degrades (person + flutter: kept 68%; vehicle + cloth: kept 35%). In the in-app virtual scenes the person is kept ~75% of sampled frames, and the debris scene still shows brief KEEP states. These are synthetic scenes written by the same author as the thresholds: they check the logic, not accuracy on real footage.

### Evaluating on CDNet 2014

`scripts/evalCDNet.ts` runs the engine on CDNet-2014-layout sequences and reports, per sequence and overall, object recall, empty frames forwarded, and total frames forwarded for: forward-all, Stage 1 only, the legacy single-box path, and per-object tracking (strict and lenient). Foreground is ground truth label 255, so dynamic background (trees, water) counts as trash and real objects as keep.

```
npm i --no-save jpeg-js pngjs
npx tsx scripts/evalCDNet.ts path/to/dynamicBackground
```

Frames are scaled to at most 320 px wide. The harness was checked for plumbing on generated JPEG/PNG data; it has not yet been run on the real dataset.

### First check on real footage (no ground truth)

`scripts/runFrames.ts` runs the filter on any folder of frames and prints how many frames each filter forwards, how long tracks live, and why tracks were dropped; it also saves annotated frames. It was run on OpenCV's sample pedestrian video `vtest.avi` (795 frames at 10 fps, scaled to 320x240; people walking in a car park, no trash in the scene). Before merge/split handling (below), with the default thresholds, 61% of the track-frames in tracks lasting 20+ frames were labelled TRASH and 23% KEEP, so **the defaults wrongly drop walking pedestrians on real footage**. The main causes were the temporal gate (box jitter at low resolution) and the aspect-deformation gate. Loosening them (noise floor 10 px, erratic cutoff 0.5, aspect limit 0.8) gave 76% KEEP and 7% TRASH, but a clip with no trash cannot show what the loosened thresholds let through. The synthetic-video thresholds do not transfer; they need calibrating on real footage with both objects and trash.

**Merge/split handling (v2.2.1).** Diagnosing the real clip showed walkers in groups merging into one blob and splitting again, so box size and centre jumped and tripped the temporal, aspect and angular gates. The tracker now (1) treats a matched blob whose area differs from the track's last box by more than `mergeRatio` (1.3x) as a suspected merge/split only if another track that just lost its blob, or a new unmatched blob, is nearby; for up to `suspectMax` frames it then holds the old size, follows the prediction, and the frame does not vote; and (2) blends each measured box with the prediction (`smoothAlpha` 0.85). Both are now `DEFAULT_TRACKER_OPTS`. The "neighbour" condition matters: without it the hold-back also hid the size swings of a lone tumbling object, and the app's own debris and flutter demos passed as KEEP.

**Guarded search that chose it.** `scripts/tuneSweep.ts` random-searches thresholds, tracker settings and these options. A config is only eligible if it still keeps the synthetic person and vehicle (>=95%) and the app's human demo (>=90%), and drops synthetic tumbling cloth and a mid-size erratic shaker (>=90%), while the app's flutter demo stays <=20% KEEP and its debris demo <=35% (as the old defaults do). The real frames are split in halves: choose on one, score on the other. On `vtest.avi`, tracks lasting 20+ frames:

| | KEEP | TRASH |
|---|---|---|
| Defaults before (whole clip) | 22.6% | 61.1% |
| Defaults now (whole clip) | 50.4% | 33.2% |
| Chosen on half A, scored on half B (old defaults on B: 14.8 / 68.3) | 40.7% | 41.6% |
| Chosen on half B, scored on half A (old defaults on A: 31.2 / 53.0) | 60.9% | 23.9% |

The best eligible config kept every other threshold at its default, so the gain comes from the tracker change, not from loosening gates. Looser thresholds (erratic cutoff 0.5, aspect limit 1.2, larger noise floors) looked better on the real clip but failed the guard rails: they pass erratic trash. Remaining weakness: about a third of pedestrian track-frames are still labelled TRASH, and mixed scenes where trash overlaps a real object still degrade (synthetic vehicle + cloth: 54% of frames carry a KEEP track). One real clip with no trash was used, so the cost of the changes on real trash is untested.

## Known limitations

- **Per-object tracking is new and only tested on synthetic video.** Objects that touch or cross become one blob, and the real one can inherit the trash verdict. With tracking switched off, the live path still uses one global box. The 4 px noise floor and the 0.1 temporal cutoff were tuned on synthetic clips and need real footage.
- **The simulator partly grades itself.** Stage 3 labels and `strideFrequency` are looked up from the object's `type`, not computed from motion, and the object kinematics were written to look like their class. Simulator results demonstrate the pipeline's logic, not detection accuracy.
- **Stage 3 is a stub.** No model runs; "AI classification" is a lookup.
- **Thresholds are unvalidated** against real footage (Stage 2 defaults, the v2 cutoff, and the v2.1 chaos and size cutoffs alike).
- **v2.1 inherits the box quality problem.** Rigidity needs a box that follows the object; frame-difference boxes flicker at the edges.
- **No automated tests.**

## Roadmap

1. **Merge/split handling** for the tracker (crossing objects), and a Stage 1 gate that does not hide small objects.
2. **Calibrate on real clips** (people, vehicles, debris) and replace hand-picked thresholds with fitted ones, including the v2.1 chaos cutoff, where real human box variation decides whether it can drop tracks safely.
3. **Gait periodicity** as a human-specific feature. This needs a longer history than the current 24-frame window.
4. **A real Stage 3** model, and measured (not modelled) hardware numbers.

---

## History

The previous README documented **v0.1**, a Python/OpenCV prototype using MOG2 background subtraction, nearest-centroid tracking and hand-tuned motion heuristics, with a simulated heavy-AI stub. That script is not in this repository's current files. The old README text is still available in git history: `git show c80c464:README.md`.

## Credits

Original EdgeFlow project: [soumyadhoke-sys](https://github.com/soumyadhoke-sys). v2 temporal speculation: Naman Sharma ([Naman-D1](https://github.com/Naman-D1)).

## Camera-motion guard (v2.2.2)

Found on a real PTZ parking-lot clip (Wikimedia, 316 s, 3163 frames at 10 fps): when the camera pans or zooms, most macroblocks go active at once and every track was judged TRASH. `processFrame` now treats a frame as camera motion when more than `globalMotionFrac` (default 0.5) of the grid is active, resets the tracker and reports no tracks for that frame (`engine.cameraMotion`).

| Parking-lot clip, full 316 s | before | after |
|---|---|---|
| camera-motion frames | - | 221 (7.0%) |
| tracks created | 125 | 20 |
| long tracks: TRASH share | 39.8% | 6.0% |
| long tracks: KEEP share | 39.5% | 37.0% |

Synthetic scenes and the vtest clip are unchanged (guard never fires there). Caveats: no ground truth, one clip, cutoff 0.5 chosen from a 0.3-0.7 sweep that barely changed the result; a large object filling over half the frame would also be skipped.

## Hand-labelled spot check and the Stage 1 gate (v2.2.3)

116 frames sampled at even intervals from three clips (vtest pedestrians, the PTZ parking lot, a night-storm camera) were labelled by hand and blind ("is a real person or vehicle moving?"), see `hand-labels.csv`. One labeller, one sample: a spot check, not a benchmark.

The Stage 1 gate (share of pixels that must change before blobs are extracted) was hard-coded at 0.45% and hid small, distant objects. It is now `motionPercent` (tracking path only; the legacy path keeps 0.45). Sweep on the 116 labels:

| motionPercent | KEEP recall | junk skipped | KEEP-or-watching recall | junk skipped |
|---|---|---|---|---|
| 0.45 (old) | 57% | 89% | 67% | 66% |
| **0.25 (new default)** | 60% | 79% | 75% | 59% |
| 0.12 | 65% | 82% | 80% | 59% |

0.12 scores better on the labels but lets the synthetic small-flutter scene through (94% pass), so 0.25 is the default. MOG2 + blob on the same frames: recall 80%, junk skipped 46%. All synthetic guards and the app demo scenes still pass at 0.25. Remaining gap: small distant objects (parking lot recall is still low) and debris at night (storm clip is far from empty).

## Analyze a video file (v2.2.4)

The Live Camera tab has an **Analyze Video File** button. Pick any video your browser can play (MP4/H.264 or WebM). It runs the same engine and the same settings as the live camera, draws the per-object boxes on the video, and fills a results panel: share of frames forwarded (KEEP), KEEP or watching, frames with a TRASH track, frames skipped as camera motion, and the top reasons tracks were dropped. **Download CSV** gives one row per analysed frame.

Frames are analysed at 10 per second of video time (the rate the thresholds were evaluated at), at 320 px wide with the clip's own aspect ratio, whatever the file's frame rate. Playback can be 1x, 2x or 4x; at higher speeds a slow computer may skip some samples, and the panel shows how many frames were actually analysed. Nothing is uploaded: the file is read by the browser only.

Check: the 267-frame night-storm clip, analysed in headless Chromium at 4x, gave 26.0% KEEP and 59.0% KEEP-or-watching, against 26.2% and 59.2% from `scripts/runFrames.ts`.

The project is a React + TypeScript + Vite app. 
How the cascade works
Frame ──► Stage 1: pixel change ──► Stage 2: motion heuristics ──► Stage 3: heavy AI
          (is anything moving?)      (does it move like an agent?)   (what is it?)

### Object count (v2.2.5)
The video results panel now shows **Moving objects counted** (distinct tracks that were ever KEEP) and **Most at once** (peak KEEP tracks in one frame). EdgeFlow does not recognise people, so this is a count of filtered moving objects. On the pedestrian test clip the total over-counts (51 tracks over 600 frames, because tracks break and restart) and the peak (5) is the more trustworthy number; on the parking-lot clip it gave 3 / 2.

### Ablation (v2.2.5)
`npx tsx scripts/synAblation.ts <framesDir>` switches off one component at a time (temporal speculation, size gate, merge/split, voting, angular variance, net displacement, aspect deformation) and reports the synthetic-scene scores. On the real labelled frames, temporal speculation changes little but on the synthetic scenes removing it drops cloth rejection from 100% to 35%; the camera-motion guard accounts for about 13 points of junk skipped; removing the size gate, angular-variance or net-displacement tests changed nothing on this data.

See [docs/thresholds.md](docs/thresholds.md) for every threshold and tracker parameter.
