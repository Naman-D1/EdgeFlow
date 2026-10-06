# EdgeFlow

A browser-based prototype of a **motion-filtering cascade for edge cameras**: cheap motion cues decide whether an expensive AI model needs to run at all, so a wind-blown bag or a moth doesn't wake the heavy model but a person or vehicle does.

**Current version: v2.1** — temporal speculation (v2) plus a bounding-box rigidity & size layer (v2.1). See [What's new in v2](#whats-new-in-v2-temporal-speculation) and [v2.1: BBox rigidity](#v21-bbox-rigidity--geometric-stability).

> The project is a React + TypeScript + Vite app. Earlier versions of this README described a Python/OpenCV script (`edge_motion_filter.py`); that script is not in this repository. See [History](#history).

---

## How the cascade works

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
