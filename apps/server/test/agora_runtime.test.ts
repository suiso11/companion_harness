// Executable AGORA runtime smoke: the REAL operator CLI entry is run as a
// subprocess on a temporary DB, with a test-only harness that injects a
// loopback HTTP server transport. Production still constructs its fixed-host
// transport; no arbitrary production destination is introduced here.
//
// Proves: unapproved/rejected proposals make zero transport hits; an exact
// hash approval sends once; a resend after process restart is refused;
// ambiguous HTTP outcomes are terminal. No public network, no production keys.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const KEY = "agora-runtime-local-key";
const SERVER_DIR = fileURLToPath(new URL("../", import.meta.url));
const CLI_URL = pathToFileURL(
  fileURLToPath(new URL("../src/agora_cli.ts", import.meta.url)),
).href;
const KERNEL_URL = pathToFileURL(
  fileURLToPath(
    new URL("../../../packages/kernel/src/index.ts", import.meta.url),
  ),
).href;

const HARNESS_SOURCE = `
import { request } from "node:http";
import { runAgoraCli, toSafeAgoraCliMessage } from ${JSON.stringify(CLI_URL)};
import { createAgoraStore } from ${JSON.stringify(KERNEL_URL)};

const baseUrl = process.env.AGORA_TEST_BASE_URL;
const dbPath = process.env.AGORA_TEST_DB;
if (baseUrl === undefined || dbPath === undefined) {
  throw new Error("missing agora test environment");
}
const base = new URL(baseUrl);

function requestJson(method, path, payload, headers) {
  return new Promise((resolve, reject) => {
    const body =
      payload === undefined
        ? null
        : Buffer.from(JSON.stringify(payload), "utf8");
    const req = request(
      {
        hostname: base.hostname,
        port: Number(base.port),
        path,
        method,
        headers: {
          ...headers,
          ...(body === null
            ? {}
            : { "content-length": String(body.byteLength) }),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(
              res.headers["content-type"] ?? "application/json",
            ),
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const transport = {
  get: (path) => requestJson("GET", path),
  post: (path, body, headers) => requestJson("POST", path, body, headers),
};

async function main() {
  const store = createAgoraStore({ path: dbPath, transport });
  try {
    process.stdout.write(
      await runAgoraCli(process.argv.slice(2), process.env, store),
    );
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(String(toSafeAgoraCliMessage(error)) + "\\n");
  process.exitCode = 1;
});
`;

interface Hit {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

type LocalHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
) => void;

interface LocalAgora {
  readonly url: string;
  readonly hits: Hit[];
  close(): Promise<void>;
}

interface Proposal {
  readonly id: string;
  readonly payloadHash: string;
  readonly status: string;
}

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, {
      recursive: true,
      force: true,
      maxRetries: 5,
    });
  }
});

async function startLocalAgora(handler: LocalHandler): Promise<LocalAgora> {
  const hits: Hit[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      hits.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body,
      });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("local AGORA test server failed to bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

function makeHarness(dir: string): string {
  // The harness lives outside the workspace, so give its temp directory an
  // explicit ESM scope; the CLI entry it imports uses top-level await.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), {
    mode: 0o600,
  });
  const path = join(dir, "agora_harness.ts");
  writeFileSync(path, HARNESS_SOURCE, { mode: 0o600 });
  return path;
}

// Async spawn is required here: the loopback test server lives in this
// process, so a synchronous child would deadlock the server event loop.
function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  harness: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", harness, ...args],
      {
        cwd: SERVER_DIR,
        env: { ...env, PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

async function cliJson<T>(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  harness: string,
): Promise<T> {
  const result = await runCli(args, env, harness);
  if (result.status !== 0) {
    throw new Error(`agora CLI failed: ${result.stderr.slice(0, 200)}`);
  }
  return JSON.parse(result.stdout) as T;
}

describe("AGORA executable CLI runtime", () => {
  it("never hits transport without exact approval, sends once, and refuses resend after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-runtime-"));
    dirs.push(dir);
    const harness = makeHarness(dir);
    const local = await startLocalAgora((_request, response) => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ api_key: KEY }));
    });
    const env: NodeJS.ProcessEnv = {
      AGORA_TEST_DB: join(dir, "state", "agora.sqlite"),
      AGORA_TEST_BASE_URL: local.url,
    };
    const registerArgs = [
      "propose-register",
      "Companion Harness",
      "Draft body",
    ];
    try {
      const pending = await cliJson<Proposal>(registerArgs, env, harness);
      expect(pending.status).toBe("pending");

      // Unapproved: the subprocess fails before any transport call.
      expect(
        (await runCli(["send", pending.id, pending.payloadHash], env, harness))
          .status,
      ).not.toBe(0);
      expect(local.hits).toHaveLength(0);

      // A wrong hash approves nothing and still never reaches transport.
      expect(
        (await runCli(["approve", pending.id, "0".repeat(64)], env, harness))
          .status,
      ).not.toBe(0);
      expect(local.hits).toHaveLength(0);

      // Rejected is terminal: send refuses without a transport hit.
      expect(
        (await cliJson<Proposal>(["reject", pending.id], env, harness)).status,
      ).toBe("rejected");
      expect(
        (await runCli(["send", pending.id, pending.payloadHash], env, harness))
          .status,
      ).not.toBe(0);
      expect(local.hits).toHaveLength(0);

      // A fresh proposal approved by its exact hash sends exactly once.
      const proposal = await cliJson<Proposal>(registerArgs, env, harness);
      expect(proposal.id).not.toBe(pending.id);
      expect(
        (
          await cliJson<Proposal>(
            ["approve", proposal.id, proposal.payloadHash],
            env,
            harness,
          )
        ).status,
      ).toBe("approved");
      const sent = await runCli(
        ["send", proposal.id, proposal.payloadHash],
        env,
        harness,
      );
      expect(sent.status).toBe(0);
      expect(sent.stdout).not.toContain(KEY);
      expect((JSON.parse(sent.stdout) as { kind: string }).kind).toBe("sent");
      expect(local.hits).toEqual([
        {
          method: "POST",
          path: "/api/register",
          body: JSON.stringify({
            name: "Companion Harness",
            description: "Draft body",
          }),
        },
      ]);

      // Every CLI invocation is a new process. Resending after restart must
      // be refused by the durable one-use approval, with no second POST.
      expect(
        (
          await runCli(
            ["send", proposal.id, proposal.payloadHash],
            env,
            harness,
          )
        ).status,
      ).not.toBe(0);
      expect(local.hits).toHaveLength(1);
      expect(
        (await cliJson<Proposal>(["show", proposal.id], env, harness)).status,
      ).toBe("sent");
    } finally {
      await local.close();
    }
  }, 30_000);

  it("marks an ambiguous HTTP result terminal and refuses resend after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-runtime-"));
    dirs.push(dir);
    const harness = makeHarness(dir);
    const local = await startLocalAgora((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("unavailable");
    });
    const env: NodeJS.ProcessEnv = {
      AGORA_TEST_DB: join(dir, "state", "agora.sqlite"),
      AGORA_TEST_BASE_URL: local.url,
    };
    try {
      const proposal = await cliJson<Proposal>(
        ["propose-register", "Companion Harness", "Draft body"],
        env,
        harness,
      );
      await cliJson<Proposal>(
        ["approve", proposal.id, proposal.payloadHash],
        env,
        harness,
      );
      const sent = await runCli(
        ["send", proposal.id, proposal.payloadHash],
        env,
        harness,
      );
      expect(sent.status).toBe(0);
      expect((JSON.parse(sent.stdout) as { kind: string }).kind).toBe(
        "unknown",
      );
      expect(local.hits).toHaveLength(1);
      expect(
        (await cliJson<Proposal>(["show", proposal.id], env, harness)).status,
      ).toBe("unknown");

      // A new subprocess (restart) cannot resend an ambiguous outcome.
      expect(
        (
          await runCli(
            ["send", proposal.id, proposal.payloadHash],
            env,
            harness,
          )
        ).status,
      ).not.toBe(0);
      expect(local.hits).toHaveLength(1);
      expect(
        (await cliJson<Proposal>(["show", proposal.id], env, harness)).status,
      ).toBe("unknown");
    } finally {
      await local.close();
    }
  }, 30_000);
});
