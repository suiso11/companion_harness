// Operator CLI behavior for AGORA: draft is never sent, proposals require
// exact-hash approval, sends consume once, and keys never appear in output.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgoraTransport, createAgoraStore } from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgoraCliError,
  runAgoraCli,
  toSafeAgoraCliMessage,
} from "../src/agora_cli.js";

const KEY = "agora-cli-secret";
const T0 = 1790000000000;
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

function fakeTransport(): {
  transport: AgoraTransport;
  posts: Array<{ path: string; body: unknown }>;
} {
  const posts: Array<{ path: string; body: unknown }> = [];
  return {
    posts,
    transport: {
      async get() {
        return {
          status: 200,
          contentType: "application/json",
          text: '{"name":"agora"}',
        };
      },
      async post(path, body) {
        posts.push({ path, body });
        if (path === "/api/register") {
          return { status: 201, text: JSON.stringify({ api_key: KEY }) };
        }
        return { status: 201, text: "{}" };
      },
    },
  };
}

function run(
  argv: string[],
  service: ReturnType<typeof createAgoraStore>,
): Promise<string> {
  return runAgoraCli(argv, {}, service);
}

describe("agora operator CLI", () => {
  it("prints a suggested registration draft without creating or sending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-cli-"));
    dirs.push(dir);
    const fake = fakeTransport();
    const store = createAgoraStore({
      path: join(dir, "agora.sqlite"),
      transport: fake.transport,
      clock: { now: () => T0 },
    });
    try {
      const out = JSON.parse(await run(["draft-register"], store)) as {
        suggested: { name: string; description: string };
        sent: boolean;
      };
      expect(out.sent).toBe(false);
      expect(out.suggested.name).toBe("Companion Harness");
      expect(store.list()).toHaveLength(0);
      expect(fake.posts).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("requires the exact hash and sends exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-cli-"));
    dirs.push(dir);
    const fake = fakeTransport();
    const store = createAgoraStore({
      path: join(dir, "agora.sqlite"),
      transport: fake.transport,
      clock: { now: () => T0 },
    });
    try {
      const proposal = JSON.parse(
        await run(
          ["propose-register", "Companion Harness", "Draft body"],
          store,
        ),
      ) as { id: string; payloadHash: string; status: string };
      expect(proposal.status).toBe("pending");

      await expect(
        run(["send", proposal.id, proposal.payloadHash], store),
      ).rejects.toThrow();
      expect(fake.posts).toHaveLength(0);

      await expect(
        run(["approve", proposal.id, "0".repeat(64)], store),
      ).rejects.toBeInstanceOf(AgoraCliError);
      expect(store.show(proposal.id).status).toBe("pending");

      const approved = JSON.parse(
        await run(["approve", proposal.id, proposal.payloadHash], store),
      ) as { status: string };
      expect(approved.status).toBe("approved");

      const sent = await run(
        ["send", proposal.id, proposal.payloadHash],
        store,
      );
      expect(sent).not.toContain(KEY);
      expect(JSON.parse(sent).kind).toBe("sent");
      expect(fake.posts).toHaveLength(1);

      await expect(
        run(["send", proposal.id, proposal.payloadHash], store),
      ).rejects.toThrow();
      expect(fake.posts).toHaveLength(1);
      expect(toSafeAgoraCliMessage(new Error("raw secret path"))).toBe(
        "agora command failed",
      );
    } finally {
      store.close();
    }
  });

  it("prints read-only AGORA content as untrusted JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-cli-"));
    dirs.push(dir);
    const fake = fakeTransport();
    const store = createAgoraStore({
      path: join(dir, "agora.sqlite"),
      transport: fake.transport,
      clock: { now: () => T0 },
    });
    try {
      const hello = JSON.parse(await run(["hello"], store)) as {
        untrusted: boolean;
        body: { name: string };
      };
      expect(hello.untrusted).toBe(true);
      expect(hello.body.name).toBe("agora");
      await expect(run(["thread", "../etc/passwd"], store)).rejects.toThrow();
    } finally {
      store.close();
    }
  });
});
