import { getDurationRange, getFixedDurations, normalizeModelDuration, type DurationRules } from '@/services/modelDuration';

interface VideoDurationControlProps {
  value: number;
  onChange: (value: number) => void;
  rules?: DurationRules;
  fallbackMin?: number;
  fallbackMax?: number;
  compact?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

export default function VideoDurationControl({
  value,
  onChange,
  rules,
  fallbackMin = 1,
  fallbackMax = 15,
  compact = false,
  disabled = false,
  ariaLabel = '视频时长',
}: VideoDurationControlProps) {
  const fixedDurations = getFixedDurations(rules);
  const range = getDurationRange(rules, fallbackMin, fallbackMax);
  const normalizedValue = normalizeModelDuration(value, rules, fallbackMin, fallbackMax);

  if (fixedDurations.length) {
    return (
      <select
        aria-label={ariaLabel}
        value={normalizedValue}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className={`${compact ? 'h-8 w-20 px-2 text-xs' : 'h-10 w-full px-3 text-sm'} rounded-md border border-dark-600 bg-dark-900 text-white outline-none focus:border-primary-500 disabled:opacity-50`}
      >
        {fixedDurations.map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
      </select>
    );
  }

  return (
    <div className={compact ? 'flex items-center gap-2' : 'space-y-2'}>
      <input
        aria-label={ariaLabel}
        type="range"
        min={range.min}
        max={range.max}
        value={normalizedValue}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className={`${compact ? 'w-24' : 'w-full'} accent-primary-500 disabled:opacity-50`}
      />
      {compact
        ? <span className="min-w-10 text-xs text-primary-300">{normalizedValue} 秒</span>
        : <div className="flex justify-between text-xs text-dark-400"><span>{range.min} 秒</span><span className="font-medium text-primary-400">{normalizedValue} 秒</span><span>{range.max} 秒</span></div>}
    </div>
  );
}
