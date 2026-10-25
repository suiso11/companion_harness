// Bounded public-page fetch for the opt-in Web connector.
//
// The model never controls transport policy. This module resolves a host
// once, rejects every non-public resolved address, and pins that address in
// the request lookup so a DNS-rebinding answer cannot be used for the final
// connection. Redirects are rejected (no Location following), non-http(s)
// schemes and credential-bearing URLs are rejected, bodies are bounded, and
// cancellation destroys the socket.

import { lookup as dnsLookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { ToolError } from "./broker.js";

export const PUBLIC_FETCH_MAX_BYTES_DEFAULT = 512 * 1024;
export const PUBLIC_FETCH_TIMEOUT_MS_DEFAULT = 15_000;
export const PUBLIC_FETCH_MAX_REDIRECTS = 0;

export interface PublicPageFetchResult {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly title: string | null;
  readonly text: string;
  readonly bytes: number;
}

export interface PublicPageFetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test-only DNS override; production always uses node:dns. */
  readonly resolvedAddresses?: readonly string[];
  /** Test-only async DNS seam. Answers are still public-address checked. */
  readonly resolveAddresses?: (host: string) => Promise<readonly string[]>;
  /** Test-only transport seam; production always uses node:http(s). */
  readonly request?: PublicPageFetchTransport;
}

/** Test-only injection point; must preserve normal request semantics. */
export type PublicPageFetchTransport = (
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);

function ipv4Blocked(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a = 0, b = 0, c = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIpv6(address: string): number[] | null {
  const zone = address.indexOf("%");
  const clean = (zone === -1 ? address : address.slice(0, zone)).toLowerCase();
  if (clean === "::") return new Array(8).fill(0);
  if (clean === "::1") return [0, 0, 0, 0, 0, 0, 0, 1];
  const halves = clean.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const right =
    halves.length === 1 || halves[1] === "" ? [] : (halves[1] ?? "").split(":");
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  const raw = [...left, ...new Array(fill).fill("0"), ...right];
  const out: number[] = [];
  for (const group of raw) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(Number.parseInt(group, 16));
  }
  return out.length === 8 ? out : null;
}

/** True only for globally routable-looking addresses. */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !ipv4Blocked(address);
  }
  if (family !== 6) {
    return false;
  }
  const groups = expandIpv6(address);
  if (groups === null) return false;
  const [g0 = 0, g1 = 0] = groups;

  // IPv4-mapped ::ffff:0:0/96: allow only a public embedded IPv4 address.
  // This also covers mapped private forms such as ::ffff:10.0.0.1.
  const embedded =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (embedded) {
    const [g6 = 0, g7 = 0] = groups.slice(6);
    return !ipv4Blocked(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }

  // Be conservative: ordinary global unicast lives in 2000::/3. Everything
  // outside it is special-use, including ::/128, ::1, fc00::/7, fe80::/10,
  // ff00::/8, 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64 can embed private IPv4).
  if ((g0 & 0xe000) !== 0x2000) return false;

  // Special-purpose ranges inside 2000::/3 which either are not global or
  // embed an IPv4 address that could be private.
  if (g0 === 0x2001 && g1 === 0x0000) return false; // Teredo 2001::/32
  if (g0 === 0x2001 && g1 === 0x0002) return false; // benchmarking
  if (g0 === 0x2001 && g1 >= 0x0010 && g1 <= 0x002f) return false; // ORCHID
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return false; // 6to4 embeds IPv4
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false; // 3fff::/20 docs
  return true;
}

/** URL.hostname keeps IPv6 brackets; strip them once for address checks. */
export function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** Validate scheme/host before any DNS lookup. */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError("invalid_input");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new ToolError("invalid_input");
  }
  const host = unbracketHostname(url.hostname).toLowerCase().replace(/\.$/, "");
  if (
    host.length === 0 ||
    host.length > 253 ||
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host.includes("\0")
  ) {
    throw new ToolError("tool_denied");
  }
  if (isIP(host) !== 0 && !isPublicIpAddress(host)) {
    throw new ToolError("tool_denied");
  }
  return url;
}

async function resolvePublicAddress(
  host: string,
  override: readonly string[] | undefined,
  resolver: ((host: string) => Promise<readonly string[]>) | undefined,
): Promise<string> {
  if (isIP(host) !== 0) {
    if (!isPublicIpAddress(host)) {
      throw new ToolError("tool_denied");
    }
    return host;
  }
  let addresses: readonly string[];
  if (override !== undefined) {
    addresses = override;
  } else {
    try {
      if (resolver !== undefined) {
        addresses = await resolver(host);
      } else {
        const resolved = await dnsLookup(host, { all: true, verbatim: true });
        addresses = resolved.map((entry) => entry.address);
      }
    } catch {
      throw new ToolError("execution_failed");
    }
  }
  if (addresses.length === 0) {
    throw new ToolError("execution_failed");
  }
  for (const address of addresses) {
    if (!isPublicIpAddress(unbracketHostname(address))) {
      throw new ToolError("tool_denied");
    }
  }
  return unbracketHostname(addresses[0] as string);
}

/**
 * Pin one already-vetted address for the actual connection. Node 24's
 * autoSelectFamily path asks with `all: true` and requires an address record
 * array; returning a bare string there can let a second DNS answer through.
 */
export function createPinnedLookup(address: string): LookupFunction {
  const family = isIP(address) === 6 ? 6 : 4;
  return ((
    _hostname: string,
    lookupOptions: { all?: boolean },
    callback: (
      error: NodeJS.ErrnoException | null,
      result: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ) => {
    if (lookupOptions.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  }) as unknown as LookupFunction;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d{1,7});/g, (_match, value: string) => {
      const code = Number(value);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

const HTML_TEXT_MAX_CHARS = 512 * 1024;
const HTML_TITLE_MAX_CHARS = 1024;

function isHtmlSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function isTagNameCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 58 ||
    code === 45
  );
}

function closingTagAt(html: string, lt: number, tag: string): boolean {
  if (html.charCodeAt(lt + 1) !== 47) return false; // '/'
  let j = lt + 2;
  while (j < html.length && isHtmlSpace(html.charCodeAt(j))) j += 1;
  if (html.slice(j, j + tag.length).toLowerCase() !== tag) return false;
  const next = html.charCodeAt(j + tag.length);
  return Number.isNaN(next) || next === 62 || next === 47 || isHtmlSpace(next);
}

/**
 * Bounded, linear-time HTML text extraction. Tags/comments are scanned once;
 * unclosed script/style/noscript blocks consume the remainder without any
 * backtracking regex. Output text is capped independently of input size.
 */
export function htmlToText(html: string): {
  title: string | null;
  text: string;
} {
  const parts: string[] = [];
  const titleParts: string[] = [];
  let titleChars = 0;
  let textChars = 0;
  let inTitle = false;
  let skipTag: string | null = null;
  const pushText = (value: string): void => {
    if (value.length === 0) return;
    if (inTitle && titleChars < HTML_TITLE_MAX_CHARS) {
      const remainder = HTML_TITLE_MAX_CHARS - titleChars;
      const piece =
        value.length > remainder ? value.slice(0, remainder) : value;
      titleParts.push(piece);
      titleChars += piece.length;
    }
    if (textChars < HTML_TEXT_MAX_CHARS) {
      const remainder = HTML_TEXT_MAX_CHARS - textChars;
      const piece =
        value.length > remainder ? value.slice(0, remainder) : value;
      parts.push(piece);
      textChars += piece.length;
    }
  };

  let i = 0;
  while (i < html.length) {
    if (skipTag !== null) {
      const lt = html.indexOf("<", i);
      if (lt === -1) break;
      if (closingTagAt(html, lt, skipTag)) {
        const end = html.indexOf(">", lt + 2 + skipTag.length);
        i = end === -1 ? html.length : end + 1;
        skipTag = null;
        pushText(" ");
      } else {
        i = lt + 1;
      }
      continue;
    }

    const lt = html.indexOf("<", i);
    const textEnd = lt === -1 ? html.length : lt;
    if (textEnd > i) pushText(html.slice(i, textEnd));
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt + 9);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const marker = html.charCodeAt(lt + 1);
    if (marker === 33 || marker === 63) {
      // <!DOCTYPE ...> or <?processing instruction?>
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    let j = lt + 1;
    let closing = false;
    if (html.charCodeAt(j) === 47) {
      closing = true;
      j += 1;
    }
    while (j < html.length && isHtmlSpace(html.charCodeAt(j))) j += 1;
    const nameStart = j;
    while (j < html.length && isTagNameCode(html.charCodeAt(j))) j += 1;
    const tag = html.slice(nameStart, j).toLowerCase();
    if (tag.length === 0) {
      // A literal '<' which does not begin a tag.
      pushText("<");
      i = lt + 1;
      continue;
    }
    const end = html.indexOf(">", j);
    if (end === -1) break;
    i = end + 1;

    if (
      !closing &&
      (tag === "script" || tag === "style" || tag === "noscript")
    ) {
      skipTag = tag;
      continue;
    }
    if (tag === "title") {
      inTitle = !closing;
      if (closing) pushText(" ");
      continue;
    }
    pushText(" ");
  }

  const titleRaw = decodeEntities(
    titleParts.join("").replace(/\s+/g, " ").trim(),
  );
  const title = titleRaw.length > 0 ? titleRaw.slice(0, 512) : null;
  const text = decodeEntities(parts.join("")).replace(/\s+/g, " ").trim();
  return { title, text };
}

function isTextContentType(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    base === "text/html" ||
    base === "application/xhtml+xml" ||
    base === "text/plain" ||
    base === "text/markdown" ||
    base === "text/x-markdown" ||
    // The AGORA hello API answers JSON; it is returned as bounded text like
    // any other non-HTML body (never parsed here).
    base === "application/json" ||
    base.endsWith("+json")
  );
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/** Fetch one public page, rejecting redirects and non-public targets. */
export async function fetchPublicPage(
  rawUrl: string,
  options: PublicPageFetchOptions = {},
): Promise<PublicPageFetchResult> {
  const url = assertPublicHttpUrl(rawUrl);
  const maxBytes = options.maxBytes ?? PUBLIC_FETCH_MAX_BYTES_DEFAULT;
  const timeoutMs = options.timeoutMs ?? PUBLIC_FETCH_TIMEOUT_MS_DEFAULT;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 8 * 1024 * 1024 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new ToolError("invalid_input");
  }
  if (options.signal?.aborted) {
    throw abortError();
  }
  const host = unbracketHostname(url.hostname).toLowerCase();

  return await new Promise<PublicPageFetchResult>((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      error: Error | null,
      value?: PublicPageFetchResult,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error !== null) {
        try {
          request?.destroy();
        } catch {
          // The failure is already known; destroy is best effort.
        }
        reject(error);
      } else if (value !== undefined) {
        resolve(value);
      }
    };
    const onAbort = (): void => {
      finish(abortError());
    };

    // Deadline and cancellation start before DNS so a stalled lookup cannot
    // outlive the caller's budget or keep a cancelled fetch alive.
    timer = setTimeout(() => {
      finish(new ToolError("execution_timeout"));
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    resolvePublicAddress(
      host,
      options.resolvedAddresses,
      options.resolveAddresses,
    ).then(
      (address) => {
        // A late DNS answer must never lead to a send after cancellation or
        // deadline settlement.
        if (settled) return;
        if (options.signal?.aborted) {
          finish(abortError());
          return;
        }
        const pinnedLookup = createPinnedLookup(address);
        const defaultRequest =
          url.protocol === "https:" ? httpsRequest : httpRequest;
        const requestFn =
          options.request ??
          (defaultRequest as unknown as PublicPageFetchTransport);
        const req = requestFn(
          {
            protocol: url.protocol,
            hostname: host,
            port: url.port === "" ? undefined : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: {
              host: url.host,
              accept:
                "text/html,application/xhtml+xml,application/json,text/plain;q=0.9",
              "user-agent": "companion-harness-web/1",
            },
            lookup: pinnedLookup,
            servername:
              url.protocol === "https:" && isIP(host) === 0 ? host : undefined,
          },
          (response) => {
            if (settled) {
              response.destroy();
              return;
            }
            const status = response.statusCode ?? 0;
            const contextType = response.headers["content-type"] ?? "";
            const contentType = Array.isArray(contextType)
              ? (contextType[0] ?? "")
              : contextType;
            const rejectResponse = (error: ToolError): void => {
              // Never leave an endless rejected body draining in the
              // background: close the response and its request immediately.
              response.destroy();
              finish(error);
            };
            if (status >= 300 && status < 400) {
              rejectResponse(new ToolError("execution_failed"));
              return;
            }
            if (status < 200 || status >= 300) {
              rejectResponse(new ToolError("execution_failed"));
              return;
            }
            if (!isTextContentType(contentType)) {
              rejectResponse(new ToolError("output_invalid"));
              return;
            }
            const declared = Number(response.headers["content-length"]);
            if (Number.isFinite(declared) && declared > maxBytes) {
              rejectResponse(new ToolError("output_too_large"));
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              if (settled) return;
              bytes += chunk.byteLength;
              if (bytes > maxBytes) {
                rejectResponse(new ToolError("output_too_large"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("error", () => {
              finish(new ToolError("execution_failed"));
            });
            response.on("end", () => {
              if (settled) return;
              const buffer = Buffer.concat(chunks);
              let text: string;
              try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
              } catch {
                finish(new ToolError("output_invalid"));
                return;
              }
              const base =
                contentType.split(";")[0]?.trim().toLowerCase() ?? "";
              let title: string | null = null;
              if (base === "text/html" || base === "application/xhtml+xml") {
                const extracted = htmlToText(text);
                title = extracted.title;
                text = extracted.text;
              } else {
                text = text.replace(/\r\n/g, "\n").trim();
              }
              finish(null, {
                url: rawUrl,
                finalUrl: url.toString(),
                status,
                contentType: base,
                title,
                text,
                bytes: buffer.byteLength,
              });
            });
          },
        );
        request = req;
        req.on("error", () => {
          finish(new ToolError("execution_failed"));
        });
        if (settled) {
          req.destroy();
          return;
        }
        if (options.signal?.aborted) {
          req.destroy();
          finish(abortError());
          return;
        }
        req.end();
      },
      (error: unknown) => {
        finish(
          error instanceof Error ? error : new ToolError("execution_failed"),
        );
      },
    );
  });
}
