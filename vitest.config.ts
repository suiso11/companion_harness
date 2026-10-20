import { defineConfig } from "vitest/config";

// CI runners (notably windows-latest) thrash when every test file runs in
// its own fork at once: better-sqlite3 is synchronous/blocking and several
// suites hold real loopback servers, so even no-op tests approach the 5s
// timeout under full parallelism (PR29 PR-event run 38608822921 ground
// truth: 4 timeouts while the same-head push run 38608803181 passed).
// Cap workers on CI only; local `pnpm test` parallelism is unchanged.
const isCI =
  process.env.CI === "true" || process.env.GITHUB_ACTIONS !== undefined;

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "scripts/deploy/**/*.test.mjs",
    ],
    // Kernel SQLite suites take 3-7s on windows-latest (e.g. master push at
    // 3370434: action_readback_instant took 7012ms > vitest's 5s default),
    // so allow headroom repo-wide. Per-test timeouts larger than this keep
    // their own values; do not lower them to this default.
    testTimeout: 20_000,
    ...(isCI ? { maxWorkers: 2 } : {}),
  },
});
