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
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    ...(isCI ? { maxWorkers: 2 } : {}),
  },
});
