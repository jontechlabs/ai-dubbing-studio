import { describe, it, expect } from 'vitest';
import { workRemaining, type WorkForecast } from './workEstimate';

const forecast: WorkForecast = {
  pendingMs: 90000,
  pendingKnown: 3,
  pendingUnknown: 0,
  active: { jobId: 'job', estimatedMs: 60000, baselineElapsedMs: 120000 },
};
describe('remaining whole workflows', () => {
  it('subtracts only the current take, never the earlier batch duration or future work', () => {
    expect(workRemaining(forecast, 130000)).toEqual({
      ms: 140000,
      known: 4,
      unknown: 0,
      overrun: false,
    });
    expect(workRemaining(forecast, 160000).ms).toBe(110000);
    const before = structuredClone(forecast);
    workRemaining(forecast, 160000);
    expect(forecast).toEqual(before);
  });
  it('keeps future work when the active operation overruns and marks the total partial', () => {
    expect(workRemaining(forecast, 190000)).toEqual({
      ms: 90000,
      known: 3,
      unknown: 1,
      overrun: true,
    });
    expect(workRemaining(forecast, 990000).ms).toBe(90000);
  });
  it('never treats missing or stale active telemetry as zero remaining', () => {
    expect(workRemaining(forecast, null)).toMatchObject({ ms: 90000, known: 3, unknown: 1 });
    expect(
      workRemaining(
        { ...forecast, pendingUnknown: 2, active: { ...forecast.active!, estimatedMs: null } },
        130000,
      ),
    ).toMatchObject({ known: 3, unknown: 3 });
    expect(
      workRemaining({ pendingMs: 0, pendingKnown: 0, pendingUnknown: 8, active: null }, null),
    ).toMatchObject({ known: 0, unknown: 8 });
  });
});
