/// <reference lib="dom" />
// PR-1 chat API surface (same endpoints as the vanilla client, §16.x).
// No mocks, no external origins: same-origin fetch only. Every helper
// returns `{ status, body }` so callers apply the exact client notices;
// 401 surfaces through `onAuthExpired` so the UI keeps the draft and shows
// the inline re-login (Q10) instead of dropping input.

export type AuthHandler = () => void;

let authHandler: AuthHandler | null = null;

export function onAuthExpired(handler: AuthHandler | null): void {
  authHandler = handler;
}

function notifyAuthExpired(): void {
  if (authHandler !== null) {
    try {
      authHandler();
    } catch {
      // Best effort: auth UX never throws into the request path.
    }
  }
}

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchJson(path: string): Promise<ApiResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  } catch {
    return { status: 0, body: null };
  }
  if (response.status === 401) {
    notifyAuthExpired();
  }
  return { status: response.status, body: await readJson(response) };
}

export async function postJson(
  path: string,
  body: unknown,
  key: string | null,
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (key !== null) {
    headers["Idempotency-Key"] = key;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 0, body: null };
  }
  if (response.status === 401) {
    notifyAuthExpired();
  }
  return { status: response.status, body: await readJson(response) };
}

export function randomUuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return "00000000-0000-4000-8000-000000000000";
  }
}

export function errorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export async function loginRemote(password: string): Promise<ApiResult> {
  return postJson("/api/remote/login", { password }, null);
}

export async function logoutRemote(): Promise<ApiResult> {
  return postJson("/api/remote/logout", {}, null);
}
