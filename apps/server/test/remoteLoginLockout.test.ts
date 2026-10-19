// Remote login lockout persistence (migration 0024).
//
// The global failure counter/lockout lives in one SQLite row so it
// survives process restarts. These tests use TWO connections to the same
// file DB: alternating failures must never lose an increment (single-row
// IMMEDIATE transaction), a fresh limiter instance must observe the
// persisted lock/deadline, and success must clear the row.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { createSqliteRemoteLoginRateLimiter } from "../src/remote_session.js";

const T0 = 1790000000000;

describe("persistent remote login lockout", () => {
  it("does not lose increments across connections and survives recreation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-login-lockout-"));
    const file = join(dir, "db.sqlite");
    const a = openKernelDatabase(file);
    await migrateKernelDatabase({ db: a.raw });
    const b = openKernelDatabase(file);
    try {
      const options = { maxFailures: 5, lockoutMs: 60_000 };
      const limiterA = createSqliteRemoteLoginRateLimiter(a.raw, options);
      const limiterB = createSqliteRemoteLoginRateLimiter(b.raw, options);

      // Alternate the first four failures between two live connections.
      for (let i = 0; i < 4; i += 1) {
        const limiter = i % 2 === 0 ? limiterA : limiterB;
        expect(limiter.recordFailure(T0 + i)).toBe(false);
      }
      // The fifth failure sees all four prior increments and locks.
      expect(limiterB.recordFailure(T0 + 4)).toBe(true);

      // A brand-new limiter (process restart) reads the same rows.
      const restarted = createSqliteRemoteLoginRateLimiter(a.raw, options);
      expect(restarted.isLocked(T0 + 5)).toBe(true);
      expect(restarted.isLocked(T0 + 4 + 60_000)).toBe(false);

      const row = a.raw
        .prepare(
          "SELECT failures, locked_until AS lockedUntil, updated_at AS updatedAt FROM remote_login_lockout WHERE id = 1",
        )
        .get() as {
        failures: number;
        lockedUntil: number;
        updatedAt: number;
      };
      // Locking resets the counter, exactly like the in-memory semantics.
      expect(row).toEqual({
        failures: 0,
        lockedUntil: T0 + 4 + 60_000,
        updatedAt: T0 + 4,
      });

      // A successful login clears both failures and the lockout.
      restarted.recordFailure(T0 + 60_001);
      restarted.reset(T0 + 60_002);
      expect(restarted.isLocked(T0 + 60_002)).toBe(false);
      const resetRow = a.raw
        .prepare(
          "SELECT failures, locked_until AS lockedUntil, updated_at AS updatedAt FROM remote_login_lockout WHERE id = 1",
        )
        .get();
      expect(resetRow).toEqual({
        failures: 0,
        lockedUntil: 0,
        updatedAt: T0 + 60_002,
      });
    } finally {
      closeKernelDatabase(b);
      closeKernelDatabase(a);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
