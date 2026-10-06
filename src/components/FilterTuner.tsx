import React from 'react';
import { Sliders, RotateCcw, ShieldCheck, AlertCircle } from 'lucide-react';
import { FilterParameters } from '../types/pipeline';
import { DEFAULT_FILTER_PARAMS } from '../utils/motionSimulation';

interface FilterTunerProps {
  params: FilterParameters;
  onChange: (newParams: FilterParameters) => void;
}

export const FilterTuner: React.FC<FilterTunerProps> = ({ params, onChange }) => {
  const handleReset = () => {
    onChange(DEFAULT_FILTER_PARAMS);
  };

  const updateParam = (key: keyof FilterParameters, val: number) => {
    onChange({
      ...params,
      [key]: val,
    });
  };

  return (
    <div className="p-6 bg-slate-900/60 border border-slate-800 rounded-xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
            Parameter Calibration
          </span>
          <h3 className="text-lg font-bold text-white tracking-tight mt-0.5">
            Stage 2 Vector Filtering Sensitivity Controls
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Tune mathematical rejection thresholds live. Observe immediate impact on candidate classification in the simulator.
          </p>
        </div>

        <button
          onClick={handleReset}
          className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
          <span>Reset Hardware Defaults</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        {/* Slider 1: Angular Variance */}
        <div className="space-y-3 p-4 bg-slate-950 rounded-xl border border-slate-800/80">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300">Max Angular Variance (θ)</span>
            <span className="font-mono text-emerald-400 font-bold tabular-nums">
              {params.varianceThreshold}°
            </span>
          </div>
          <input
            type="range"
            min={15}
            max={75}
            step={1}
            value={params.varianceThreshold}
            onChange={(e) => updateParam('varianceThreshold', parseFloat(e.target.value))}
            className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
          <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
            <span>Strict (15°)</span>
            <span>Default (38°)</span>
            <span>Permissive (75°)</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            Filters erratic jitter. Moths &amp; insects typically exceed 60° variance.
          </p>
        </div>

        {/* Slider 2: Min Net Displacement Ratio */}
        <div className="space-y-3 p-4 bg-slate-950 rounded-xl border border-slate-800/80">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300">Min Net Displacement</span>
            <span className="font-mono text-cyan-400 font-bold tabular-nums">
              {(params.minNetDisplacement * 100).toFixed(0)}%
            </span>
          </div>
          <input
            type="range"
            min={0.15}
            max={0.85}
            step={0.05}
            value={params.minNetDisplacement}
            onChange={(e) => updateParam('minNetDisplacement', parseFloat(e.target.value))}
            className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
          />
          <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
            <span>15%</span>
            <span>Default (42%)</span>
            <span>85%</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            Ratio of net distance to gross path. Swaying trees oscillate near 0–15%.
          </p>
        </div>

        {/* Slider 3: Aspect Ratio Deformation */}
        <div className="space-y-3 p-4 bg-slate-950 rounded-xl border border-slate-800/80">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300">Max Aspect Deformation (ΔAR)</span>
            <span className="font-mono text-amber-400 font-bold tabular-nums">
              {params.maxAspectDeformation.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0.10}
            max={0.60}
            step={0.02}
            value={params.maxAspectDeformation}
            onChange={(e) => updateParam('maxAspectDeformation', parseFloat(e.target.value))}
            className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
          />
          <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
            <span>0.10</span>
            <span>Default (0.28)</span>
            <span>0.60</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            Rate of shape distortion per second. Tumbling plastic trash easily exceeds 0.40.
          </p>
        </div>

        {/* Slider 4 (v2): Temporal erratic score */}
        <div className="space-y-3 p-4 bg-slate-950 rounded-xl border border-slate-800/80">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300">Temporal Speculation</span>
            <label className="flex items-center gap-1.5 cursor-pointer text-slate-400">
              <input
                type="checkbox"
                checked={params.enableTemporal}
                onChange={(e) => onChange({ ...params, enableTemporal: e.target.checked })}
                className="accent-sky-500"
              />
              <span>{params.enableTemporal ? 'ON' : 'OFF (v1)'}</span>
            </label>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Max Erratic Score</span>
            <span className="font-mono text-sky-400 font-bold tabular-nums">
              {params.maxErraticScore.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0.02}
            max={0.6}
            step={0.01}
            value={params.maxErraticScore}
            disabled={!params.enableTemporal}
            onChange={(e) => updateParam('maxErraticScore', parseFloat(e.target.value))}
            className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-sky-500 disabled:opacity-40"
          />
          <p className="text-[11px] text-slate-400 leading-tight">
            Drops tracks whose motion a constant-velocity predictor can't anticipate. Default tuned on
            simulator data only; re-tune on real footage.
          </p>
        </div>
      </div>
    </div>
  );
};
