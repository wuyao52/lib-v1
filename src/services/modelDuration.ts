import type { AIModelConfig } from '@/types';

export type DurationRules = {
  managed?: boolean;
  minDurationSec?: number | null;
  maxDurationSec?: number | null;
  allowedDurationsSec?: number[];
};

export function getFixedDurations(rules?: DurationRules | null): number[] {
  if (!rules?.managed) return [];
  return [...new Set((rules.allowedDurationsSec || [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
}

export function getDurationRange(rules?: DurationRules | null, fallbackMin = 1, fallbackMax = 15) {
  if (!rules?.managed) return { min: fallbackMin, max: fallbackMax };
  const min = Number(rules.minDurationSec) || fallbackMin;
  const max = Number(rules.maxDurationSec) || fallbackMax;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

export function normalizeModelDuration(value: number, rules?: DurationRules | null, fallbackMin = 1, fallbackMax = 15): number {
  const fixed = getFixedDurations(rules);
  const requested = Number(value);
  if (fixed.length) {
    if (fixed.includes(requested)) return requested;
    return fixed.reduce((closest, candidate) => (
      Math.abs(candidate - requested) < Math.abs(closest - requested) ? candidate : closest
    ), fixed[0]);
  }
  const { min, max } = getDurationRange(rules, fallbackMin, fallbackMax);
  return Math.min(max, Math.max(min, Number.isFinite(requested) ? requested : min));
}

export function describeModelDuration(rules?: DurationRules | null): string {
  if (!rules?.managed) return '自定义时长';
  const fixed = getFixedDurations(rules);
  if (fixed.length) return `固定时长：${fixed.join('、')} 秒`;
  if (rules.minDurationSec || rules.maxDurationSec) {
    const { min, max } = getDurationRange(rules, 1, 15);
    return `支持时长：${min}-${max} 秒`;
  }
  return '支持时长：未设置';
}

export function videoDurationRules(model?: AIModelConfig | null): DurationRules {
  return {
    managed: Boolean(model?.managed),
    minDurationSec: model?.minDurationSec,
    maxDurationSec: model?.maxDurationSec,
    allowedDurationsSec: model?.allowedDurationsSec,
  };
}
