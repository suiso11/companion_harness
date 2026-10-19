// Parity guard: run-google-readonly.sh literals must equal the pinned
// GOOGLE_READONLY_WIRE_HASHES (fork cefb63c). Prevents drift back to the
// superseded 6939311 hashes. No network, no secrets, no OAuth.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GOOGLE_READONLY_WIRE_HASHES } from "../src/calendarReadonlyProfile.js";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "..", "..", "run-google-readonly.sh");

describe("run-google-readonly.sh wire hash parity", () => {
  it("embeds exactly the pinned cefb63c live-wire hashes", () => {
    const script = readFileSync(scriptPath, "utf8");
    for (const tool of ["list-events", "search-events", "get-event"] as const) {
      const hash = GOOGLE_READONLY_WIRE_HASHES[tool];
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(script).toContain(hash);
    }
  });

  it("does not contain the superseded 6939311 list/search hashes", () => {
    const script = readFileSync(scriptPath, "utf8");
    expect(script).not.toContain(
      "81222b89482cba77b12a707c2097c66df383cab7929c14dca03cc303846d794c",
    );
    expect(script).not.toContain(
      "d48ba36e7f280d92eaba9550323e90aa7a6d7c758812932ad62012f4514558b7",
    );
  });

  it("execs the server (systemd signal propagation) and needs no TTY", () => {
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toMatch(/^\s*exec pnpm start/m);
    expect(script).not.toMatch(/read\s+(-p|-[^\s]*p)/);
  });
});
