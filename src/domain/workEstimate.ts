export interface WorkForecast {
  pendingMs: number;
  pendingKnown: number;
  pendingUnknown: number;
  active: { jobId: string; estimatedMs: number | null; baselineElapsedMs: number } | null;
}
/** Subtract time only from the active operation; future work never counts down. */
export function workRemaining(forecast: WorkForecast, activeElapsed: number | null) {
  let ms = Math.max(0, Number.isFinite(forecast.pendingMs) ? forecast.pendingMs : 0);
  let known = Math.max(0, forecast.pendingKnown);
  let unknown = Math.max(0, forecast.pendingUnknown);
  let overrun = false;
  const a = forecast.active;
  if (a) {
    if (
      a.estimatedMs === null ||
      !Number.isFinite(a.estimatedMs) ||
      a.estimatedMs <= 0 ||
      a.estimatedMs > 86400000 ||
      activeElapsed === null ||
      !Number.isFinite(activeElapsed) ||
      !Number.isFinite(a.baselineElapsedMs) ||
      a.baselineElapsedMs < 0
    )
      unknown++;
    else {
      const remaining = a.estimatedMs - Math.max(0, activeElapsed - a.baselineElapsedMs);
      if (remaining <= 0) {
        overrun = true;
        unknown++;
      } else {
        ms += remaining;
        known++;
      }
    }
  }
  return { ms, known, unknown, overrun };
}
