import { defineConfig } from "vitest/config";

// D2 smoke:startup — exactly the covering startup test files (T3/T4
// actual-startServer smoke + the existing owned-port / B4 preflight /
// create-only startup regressions), runnable from apps/server.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/startup_smoke.test.ts",
      "test/rescheduleWriteStartup.test.ts",
      "test/createWriteStartup.test.ts",
    ],
  },
});
