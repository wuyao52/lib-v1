const MODERATION_CODES = new Set([
  'PROVIDER_MODERATION_ERROR',
  'CONTENT_MODERATION_FAILED',
  'MODERATION_FAILED',
  'CONTENT_POLICY_VIOLATION',
  'SAFETY_REJECTION',
]);

const BUSINESS_CODES = new Set([
  'USER_CANCELLED',
  'INSUFFICIENT_BALANCE',
  'UPSTREAM_BALANCE_INSUFFICIENT',
  'INVALID_REQUEST',
  'INVALID_PARAMETERS',
  'VALIDATION_ERROR',
  'INVALID_DURATION',
  'UNSUPPORTED_DURATION',
  'IMAGES_REQUIRED',
  'MISSING_IMAGES',
  'MODEL_NOT_SUPPORTED',
]);

function normalizedCode(job) {
  return String(job?.errorCode || job?.error?.code || '').trim().toUpperCase();
}

export function summarizeOperationalFailureCodes(jobs = [], limit = 5) {
  const counts = new Map();
  for (const job of jobs) {
    if (classifyGenerationFailure(job).kind !== 'operational') continue;
    const code = normalizedCode(job) || 'UNKNOWN_OPERATIONAL_FAILURE';
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, limit))
    .map(([code, count]) => ({ code, count }));
}

export function classifyGenerationFailure(job) {
  if (job?.status === 'cancelled') return { kind: 'excluded', reason: 'cancelled' };
  if (job?.status !== 'failed') return { kind: 'not_failed', reason: null };
  const code = normalizedCode(job);
  if (MODERATION_CODES.has(code) || code.includes('MODERATION') || code.includes('CONTENT_POLICY')) {
    return { kind: 'excluded', reason: 'moderation' };
  }
  if (BUSINESS_CODES.has(code)
    || code.startsWith('INVALID_')
    || code.startsWith('MISSING_')
    || code.startsWith('UNSUPPORTED_')) {
    return { kind: 'excluded', reason: 'business' };
  }
  return { kind: 'operational', reason: 'system' };
}

export function summarizeGenerationFailures(jobs = []) {
  const summary = {
    totalJobs: jobs.length,
    completed: 0,
    totalFailed: 0,
    operationalFailed: 0,
    excludedFailed: 0,
    moderationFailed: 0,
    businessFailed: 0,
    cancelled: 0,
    eligibleTerminalJobs: 0,
    operationalFailureRate: 0,
  };
  for (const job of jobs) {
    if (job?.status === 'completed') summary.completed += 1;
    const classification = classifyGenerationFailure(job);
    if (classification.kind === 'operational') {
      summary.totalFailed += 1;
      summary.operationalFailed += 1;
    } else if (classification.kind === 'excluded') {
      if (job?.status === 'failed') {
        summary.totalFailed += 1;
        summary.excludedFailed += 1;
        if (classification.reason === 'moderation') summary.moderationFailed += 1;
        else summary.businessFailed += 1;
      } else if (classification.reason === 'cancelled') summary.cancelled += 1;
    }
  }
  summary.eligibleTerminalJobs = summary.completed + summary.operationalFailed;
  summary.operationalFailureRate = summary.eligibleTerminalJobs
    ? Number((summary.operationalFailed / summary.eligibleTerminalJobs).toFixed(4))
    : 0;
  return summary;
}

export function generationFailureAlertConfig(env = process.env) {
  return {
    emailEnabled: String(env.ALERT_GENERATION_FAILURE_EMAIL_ENABLED || '').trim().toLowerCase() === 'true',
    threshold: Math.min(1, Math.max(0.01, Number(env.ALERT_FAILURE_RATE || '0.2') || 0.2)),
    minimumCount: Math.max(2, Number.parseInt(env.ALERT_FAILURE_MIN_COUNT || '2', 10) || 2),
    minimumSamples: Math.max(2, Number.parseInt(env.ALERT_FAILURE_MIN_SAMPLES || '10', 10) || 10),
    criticalCount: Math.max(2, Number.parseInt(env.ALERT_FAILURE_CRITICAL_COUNT || '5', 10) || 5),
    windowMinutes: Math.max(15, Number.parseInt(env.ALERT_FAILURE_WINDOW_MINUTES || '60', 10) || 60),
    confirmations: Math.max(1, Number.parseInt(env.ALERT_FAILURE_CONFIRMATIONS || '2', 10) || 2),
  };
}

export function shouldAlertGenerationFailures(summary, config) {
  if (summary.operationalFailed < config.minimumCount) return false;
  if (summary.operationalFailed >= config.criticalCount) return true;
  return summary.eligibleTerminalJobs >= config.minimumSamples
    && summary.operationalFailureRate >= config.threshold;
}
