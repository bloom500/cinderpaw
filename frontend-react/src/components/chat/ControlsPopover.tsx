import { Settings2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useModel, type InferParamsUI } from '@/stores/model';

function ParamRow({
  label,
  value,
  min,
  max,
  step,
  decimals,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-xs text-text-secondary">{label}</span>
        <input
          type="number"
          value={decimals === 0 ? String(value) : value.toFixed(decimals)}
          min={min}
          max={max}
          step={step}
          className="w-16 text-right text-xs bg-transparent border-none outline-none text-text-primary [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          onChange={(e) => {
            const v = decimals === 0 ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
            if (!isNaN(v) && v >= min && v <= max) onChange(v);
          }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = decimals === 0 ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
          onChange(v);
        }}
        className="w-full h-1 rounded-full appearance-none bg-white/10 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/80 [&::-webkit-slider-thumb]:cursor-pointer"
      />
    </div>
  );
}

const ROWS: Array<{
  key: keyof InferParamsUI;
  label: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
}> = [
  { key: 'temperature', label: 'Temperature', min: 0,    max: 2,    step: 0.01,  decimals: 2 },
  { key: 'top_p',       label: 'Top-P',        min: 0.01, max: 1,    step: 0.01,  decimals: 2 },
  { key: 'max_tokens',  label: 'Max Tokens',   min: 128,  max: 8192, step: 128,   decimals: 0 },
];

export function ControlsPopover() {
  const inferParams    = useModel((s) => s.inferParams);
  const setInferParams = useModel((s) => s.setInferParams);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center justify-center h-full px-2.5 text-text-muted hover:text-text-secondary transition-colors outline-none">
          <Settings2 size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-60">
        <p className="text-xs font-medium text-text-secondary mb-3">Controls</p>
        {ROWS.map(({ key, label, min, max, step, decimals }) => (
          <ParamRow
            key={key}
            label={label}
            value={inferParams[key]}
            min={min}
            max={max}
            step={step}
            decimals={decimals}
            onChange={(v) => setInferParams({ [key]: v })}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
