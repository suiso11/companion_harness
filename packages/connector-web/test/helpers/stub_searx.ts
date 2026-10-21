import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

/**
 * Minimal SearXNG JSON stub for connector tests. Binds to 127.0.0.1 with an
 * OS-assigned port; never contacts a real SearXNG instance.
 */
export interface StubServerOptions {
  /** Single fixed status (default 200). */
  readonly status?: number;
  /** Raw response body (default ""). */
  readonly body?: string;
  /** Respond nothing at all ( hangs ) — for timeout tests. */
  readonly neverRespond?: boolean;
  /** `location` header for a 3xx status. */
  readonly redirectLocation?: string;
  /** Optional request hook. */
  readonly onRequest?: (req: IncomingMessage, url: URL) => void;
}

export interface RunningStubServer {
  readonly server: Server;
  readonly addr: string;
  readonly url: string;
  readonly requests: { url: URL; headers: IncomingMessage["headers"] }[];
  close(): Promise<void>;
}

export function startSearxStub(
  options: StubServerOptions = {},
): Promise<RunningStubServer> {
  const requests: RunningStubServer["requests"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      requests.push({ url: requestUrl, headers: req.headers });
      options.onRequest?.(req, requestUrl);
    } catch {
      // never let hook errors break the stub
    }
    void req.resume();
    if (options.neverRespond === true) {
      return; // hang until the client aborts
    }
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
    };
    if (options.redirectLocation !== undefined) {
      headers.location = options.redirectLocation;
    }
    res.writeHead(options.status ?? 200, headers);
    res.end(options.body ?? "");
  });
  return new Promise<RunningStubServer>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("stub server did not bind");
      }
      resolve({
        server,
        addr: `127.0.0.1:${address.port}`,
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/** A minimal successful SearXNG JSON fixture. */
export function searxJsonFixture(
  results: readonly { url: string; title: string; content: string }[],
): string {
  return JSON.stringify({ results });
}
