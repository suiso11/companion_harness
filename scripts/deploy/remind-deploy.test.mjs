// Unit tests for the CI-gate classifier embedded in remind-deploy.sh.
// The classifier is an inline `node --input-type=module -e` script; extract
// it from the shell source and eval it with CHECK_RUNS_JSON fixtures so the
// exact shipped parsing logic is what gets tested.
//
// Regression context (fix/remind-deploy-ci-parse): the old gh<--slurp
// fallback streamed check runs and joined them with whitespace inside
// "[...]" (no commas), so JSON.parse always failed and the deploy logged
// "CI not green ... (parse-error)" even when CI was green. The fetch now
// uses one ?per_page=100 request and the classifier reports
// too-many-checks clearly when total_count exceeds that page size.
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { backupRemindPreDeploy } from "./remind-backup.mjs";

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "remind-deploy.sh",
);

/** Extract the CI-gate classifier body (the `node -e '...'` script). */
function extractClassifier() {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const match = source.match(/node --input-type=module -e '([\s\S]*?)\n'\)"/);
  if (match === null) {
    throw new Error("classifier script not found in remind-deploy.sh");
  }
  return match[1];
}

/** Run the classifier with CHECK_RUNS_JSON=<raw>; it exits 0 always. */
function classify(raw) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", extractClassifier()],
      { env: { ...process.env, CHECK_RUNS_JSON: raw } },
      (err, stdout) => {
        if (err !== null) {
          reject(err);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function run(name, status = "completed", conclusion = "success") {
  return { name, status, conclusion };
}

const okPage = {
  total_count: 2,
  check_runs: [run("build-test"), run("lint")],
};
const failingPage = {
  total_count: 2,
  check_runs: [run("build-test"), run("build-test", "completed", "failure")],
};

describe("remind-deploy.sh CI-gate classifier", () => {
  it("judges a single page object green when all runs passed", async () => {
    expect(await classify(JSON.stringify(okPage))).toBe("green");
  });

  it("names the failing run for a single page object", async () => {
    expect(await classify(JSON.stringify(failingPage))).toBe(
      "not-green:build-test:completed/failure",
    );
  });

  it("treats skipped conclusions as green", async () => {
    const page = {
      total_count: 2,
      check_runs: [run("build-test"), run("e2e", "completed", "skipped")],
    };
    expect(await classify(JSON.stringify(page))).toBe("green");
  });

  it("aggregates a slurped array of pages across checks", async () => {
    const doc = JSON.stringify([
      { total_count: 2, check_runs: [run("a")] },
      {
        total_count: 2,
        check_runs: [run("b", "completed", "failure"), run("c")],
      },
    ]);
    expect(await classify(doc)).toBe("not-green:b:completed/failure");
  });

  it("accepts a flat array of check runs (legacy fallback form)", async () => {
    expect(
      await classify(
        JSON.stringify([run("a"), run("b", "completed", "failure")]),
      ),
    ).toBe("not-green:b:completed/failure");
  });

  it("reports no-checks for a page without check runs", async () => {
    expect(
      await classify(JSON.stringify({ total_count: 0, check_runs: [] })),
    ).toBe("no-checks");
    expect(await classify("[]")).toBe("no-checks");
  });

  it("reports too-many-checks when total_count exceeds the page size", async () => {
    const page = {
      total_count: 101,
      check_runs: Array.from({ length: 100 }, (_, i) => run(`run-${i}`)),
    };
    expect(await classify(JSON.stringify(page))).toBe("too-many-checks");
  });

  it("reports parse-error for malformed JSON instead of misjudging it", async () => {
    expect(await classify("{not json")).toBe("parse-error");
    // The historical regression: whitespace-joined page objects are invalid
    // JSON (`[ {..} {..} ]`), so the classifier must say parse-error, never
    // green, for it.
    expect(
      await classify(
        `${'[{"total_count":1,"check_runs":[]}]'.replace("]", " ")} `,
      ),
    ).toBe("parse-error");
  });
});

const PRE_DEPLOY = "pre-deploy DB backup";
const FLIP = 'mv -Tf "$CURRENT_LINK.tmp.$$" "$CURRENT_LINK"';

function shellSource() {
  return readFileSync(SCRIPT_PATH, "utf8");
}

/** The shell command that takes the pre-deploy backup (through its guard). */
function backupInvocation() {
  const source = shellSource();
  const start = source.indexOf("BACKUP_LINE=");
  const end = source.indexOf('log "pre-deploy DB backup', start);
  if (start < 0 || end < 0) {
    throw new Error("pre-deploy backup invocation not found");
  }
  return source.slice(start, end);
}

function makeDb(dir) {
  const dbPath = join(dir, "memory.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE t (x INTEGER)");
  db.exec("INSERT INTO t VALUES (1)");
  db.exec("PRAGMA user_version = 7");
  db.close();
  return dbPath;
}

describe("remind-deploy.sh pre-deploy DB backup", () => {
  it("takes the verified backup before the smoke run and the flip", () => {
    const source = shellSource();
    const backupAt = source.indexOf(`# --- ${PRE_DEPLOY}`);
    // The smoke runs the NEW release CLI against the LIVE config, so the
    // backup (the only pre-migration restore point) must be taken first.
    const smokeRequestAt = source.indexOf('SMOKE_REQUEST="$(SCOPE=');
    const smokeRunAt = source.indexOf('run_smoke_bounded "$SMOKE_TMP"');
    const flipAt = source.indexOf(FLIP, backupAt);
    expect(backupAt).toBeGreaterThan(0);
    expect(smokeRequestAt).toBeGreaterThan(backupAt);
    expect(smokeRunAt).toBeGreaterThan(backupAt);
    expect(flipAt).toBeGreaterThan(smokeRunAt);
    // The backup runs after the config path is resolved (it needs dbPath).
    expect(
      source.indexOf(
        'SMOKE_CONFIG="$(node "$SCRIPT_DIR/remindDeploy.mjs" field config',
      ),
    ).toBeLessThan(backupAt);
    // A backup failure routes into the existing rollback/exit-1 path.
    expect(backupInvocation()).toMatch(/\|\|\s*\n?\s*fail_refuse/);
    expect(backupInvocation()).toMatch(/--pre-deploy --sha "\$PREDEPLOY_SHA"/);
    const failRefuse = source.slice(
      source.indexOf("fail_refuse()"),
      source.indexOf("if ! SCOPE="),
    );
    expect(failRefuse).toMatch(/rollback/);
    expect(failRefuse).toMatch(/exit 1/);
  });

  it("prevents the smoke run and flip when the backup fails", () => {
    const source = shellSource();
    const backupAt = source.indexOf(`# --- ${PRE_DEPLOY}`);
    // Everything the backup guard can reach before the smoke invocation must
    // be the failure path: fail_refuse exits 1, so a failed backup can never
    // fall through to the smoke or the symlink flip.
    const beforeSmoke = source.slice(
      source.indexOf("BACKUP_LINE="),
      source.indexOf('SMOKE_REQUEST="$(SCOPE='),
    );
    expect(beforeSmoke).toMatch(/\|\|\s*\n?\s*fail_refuse/);
    expect(beforeSmoke).not.toMatch(/run_smoke_bounded/);
    expect(beforeSmoke).not.toMatch(/mv -Tf/);
    expect(source.indexOf('run_smoke_bounded "$SMOKE_TMP"')).toBeGreaterThan(
      backupAt,
    );
  });

  it("names the pre-deploy backup in the post-smoke failure message", () => {
    const source = shellSource();
    const messageAt = source.indexOf("smoke test failed for $TARGET");
    expect(messageAt).toBeGreaterThan(0);
    const message = source.slice(messageAt, source.indexOf("fi", messageAt));
    // Smoke may already have migrated the live DB: tell the operator which
    // backup to restore manually (the deploy never auto-restores it).
    expect(message).toMatch(/\$\{PREDEPLOY_BACKUP\}/);
    expect(message).toMatch(/restore that backup manually/i);
    // The shell extracts the full path emitted by the backup CLI.
    expect(
      source.slice(
        source.indexOf("BACKUP_LINE="),
        source.indexOf("SMOKE_REQUEST="),
      ),
    ).toMatch(/sed 's\/\.\* path=\/\//);
  });

  it("writes remind-pre-deploy-<UTC>-<sha7>.sqlite with 0600 and user_version", async () => {
    const work = mkdtempSync(join(tmpdir(), "predeploy-"));
    try {
      makeDb(work);
      const config = join(work, "memory.config.json");
      writeFileSync(config, JSON.stringify({ dbPath: "./memory.db" }));
      const res = await backupRemindPreDeploy({
        configPath: config,
        sha: "ABCDEF1234567890",
        now: new Date("2026-10-24T09:00:00Z"),
      });
      expect(res.skipped).toBe(false);
      expect(res.file).toBe(
        "remind-pre-deploy-20261024T090000Z-abcdef1.sqlite",
      );
      const path = join(work, "backups", res.file);
      // POSIX mode is best-effort on Windows (current-user ACL only).
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      expect(res.userVersion).toBe(7);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA integrity_check").get().integrity_check).toBe(
          "ok",
        );
        expect(db.prepare("PRAGMA user_version").get().user_version).toBe(7);
      } finally {
        db.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("retains only the newest 10 pre-deploy backups", async () => {
    const work = mkdtempSync(join(tmpdir(), "predeploy-"));
    try {
      makeDb(work);
      const config = join(work, "memory.config.json");
      writeFileSync(config, JSON.stringify({ dbPath: "./memory.db" }));
      for (let i = 0; i < 12; i += 1) {
        await backupRemindPreDeploy({
          configPath: config,
          sha: "abcdef1",
          now: new Date(Date.UTC(2026, 9, 24, 9, 0, i)),
        });
      }
      const backups = readdirSync(join(work, "backups")).filter((name) =>
        name.startsWith("remind-pre-deploy-"),
      );
      expect(backups).toHaveLength(10);
      expect(backups).not.toContain(
        "remind-pre-deploy-20261024T090000Z-abcdef1.sqlite",
      );
      expect(backups).not.toContain(
        "remind-pre-deploy-20261024T090001Z-abcdef1.sqlite",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("skips cleanly when the DB does not exist yet", async () => {
    const work = mkdtempSync(join(tmpdir(), "predeploy-"));
    try {
      const config = join(work, "memory.config.json");
      writeFileSync(config, JSON.stringify({ dbPath: "./memory.db" }));
      const res = await backupRemindPreDeploy({
        configPath: config,
        sha: "abcdef1",
      });
      expect(res).toMatchObject({
        skipped: true,
        reason: "database missing",
      });
      expect(existsSync(join(work, "backups"))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
