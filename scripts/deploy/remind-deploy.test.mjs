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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
