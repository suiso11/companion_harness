/**
 * Demand-driven reconnect backoff (§17.6, exact): 1s / 2s / 5s / 10s / max 30s.
 * `failures` is the count of consecutive connection failures (>= 1).
 * Pure function so the schedule is unit-testable without timers.
 */
export function nextBackoffMs(failures: number): number {
  const schedule = [1000, 2000, 5000, 10000, 30000];
  if (!Number.isInteger(failures) || failures < 1) return schedule[0] as number;
  const index = Math.min(failures - 1, schedule.length - 1);
  return schedule[index] as number;
}
