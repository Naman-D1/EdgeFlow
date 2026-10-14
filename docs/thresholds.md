# EdgeFlow v2.2.5 — thresholds and parameters

Values as in the code on branch `v2` / `main` (`src/utils/motionSimulation.ts`, `src/utils/blobTracker.ts`, `src/utils/opencvAdapter.ts`).
Chosen by guarded random search on the pedestrian clip, constrained by synthetic guard-rail scenes (see report, Section IV-G). They were not derived analytically.

## Pipeline

| Parameter | Value | Meaning |
|---|---|---|
| Stage 1 pixel-change gate (`motionPercent`) | 0.25 % of pixels | Below this the frame is treated as still and stops at Stage 1 (legacy single-box path keeps 0.45 %) |
| Macroblock size | 20 px | Grid cell for block matching |
| Block-matching search range | ±8 px | Sum-of-absolute-differences search window |
| Blob grouping | 1-block gap bridged | Adjacent active blocks join into one blob |
| Camera-motion guard (`globalMotionFrac`) | > 50 % of blocks active | Frame treated as camera motion; tracker reset, no tracks reported |
| Evaluation resolution / rate | 320 px wide, 10 fps | Also the sample rate of the video-upload analysis |

## Per-object tests

| Test | Parameter | Value | Meaning |
|---|---|---|---|
| Angular variance | `varianceThreshold` | 38° | Spread of motion directions; above it the object is trash |
| Net displacement | `minNetDisplacement` | 0.42 | Net distance ÷ path length; below it the object is trash |
| Aspect deformation | `maxAspectDeformation` | 0.28 | Max rate of aspect-ratio change |
| Temporal speculation | `maxErraticScore` | 0.1 | Erratic score above this is trash |
| | weights | 0.65 prediction miss + 0.35 turn rate | Combined into the erratic score |
| | minimum straightness | 0.45 | |
| | minimum history | 8 frames | |
| | noise floor (`noiseFloor`) | 4 px | Box jitter ignored by the temporal test |
| | speculated path (`horizon`) | 12 frames | Length of the predicted path overlay |
| Size gate | `minAreaFrac` | 0.1 % of the frame | Smaller objects are dropped as specks |
| Rigidity (off by default) | `maxBBoxChaos` | 0.2 | Box area/aspect wobble |

## Tracker

| Parameter | Value | Meaning |
|---|---|---|
| `maxHistory` | 24 samples | History kept per track |
| `maxCoast` | 6 frames | Frames a track may go unmatched before deletion |
| `confirmFrames` | 8 frames | Younger tracks are PENDING and never treated as trash |
| `gateScale` | 0.75 | Association gate = max(1.5 blocks, 0.75 × largest box side) |
| `voteWindow` | 5 frames | Verdicts that vote |
| `dropEnter` | 4 of 5 | Trash votes needed to drop a track |
| `dropLeave` | ≤ 2 of 5 | A dropped track passes again at or below this |
| `mergeRatio` | 1.3 | Box area change (or 1/1.3) flagged as a merge/split |
| `suspectMax` | 6 frames | Hold-back time for a suspected merge/split |
| `smoothAlpha` | 0.85 | Blend of measurement (0.85) and prediction (0.15) |

## Unused leftovers (simulator only, not in the live tracker)

`minPersistenceFrames` = 5, `strideFrequencyMin` = 1.0, `strideFrequencyMax` = 3.5. Do not present these as part of the current method.

## Stage 1 gate alternatives (116 labelled frames, recall / junk skipped, %)

| Gate | KEEP only | KEEP or watching |
|---|---|---|
| 0.45 % (original) | 57 / 89 | 67 / 66 |
| 0.25 % (default) | 60 / 79 | 75 / 59 |
| 0.12 % | 65 / 82 | 80 / 59 |

0.12 % scores higher but lets synthetic small flutter through in 94 % of frames, so 0.25 % was kept. These labels also helped choose the gate, so these figures are not held-out.
