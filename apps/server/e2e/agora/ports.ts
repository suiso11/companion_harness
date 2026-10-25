// Fixed loopback ports + deterministic fixture text for the AGORA
// real-browser E2E harness (isolated from the M3/Calendar/Memory harnesses).
//
//   4190  AGORA_APP_PORT             AGORA-enabled real server: success,
//                                    reject, session-switch scenarios.
//   4191  AGORA_AMBIGUOUS_APP_PORT   AGORA-enabled real server whose fake
//                                    transport throws (ambiguous outcome).
//   4192  AGORA_DISABLED_APP_PORT    Real server without COMPANION_AGORA_JSON
//                                    (endpoint 404 => panel hidden).
//   4193  AGORA_CONTROL_PORT         Loopback-only fixture observation
//                                    (transport attempts/posts + counters).
//
// Each AGORA-enabled app uses its own temp private SQLite store so the
// production shared write interval never couples two scenarios.

export const AGORA_APP_PORT = 4190;
export const AGORA_AMBIGUOUS_APP_PORT = 4191;
export const AGORA_DISABLED_APP_PORT = 4192;
export const AGORA_CONTROL_PORT = 4193;

export const AGORA_APP_ORIGIN = `http://127.0.0.1:${AGORA_APP_PORT}`;
export const AGORA_AMBIGUOUS_APP_ORIGIN = `http://127.0.0.1:${AGORA_AMBIGUOUS_APP_PORT}`;
export const AGORA_DISABLED_APP_ORIGIN = `http://127.0.0.1:${AGORA_DISABLED_APP_PORT}`;
export const AGORA_CONTROL_ORIGIN = `http://127.0.0.1:${AGORA_CONTROL_PORT}`;

/** Composer text that makes the synthetic gateway stage the malicious draft. */
export const AGORA_TEXT_PROPOSE = "agora-propose";
/** Composer text for a second pending draft that the human rejects. */
export const AGORA_TEXT_REJECT = "agora-reject";
/** Composer text for a draft whose Send outcome is ambiguous. */
export const AGORA_TEXT_AMBIGUOUS = "agora-ambiguous";

/**
 * Exact untrusted proposal content. Markup-significant characters and a
 * script payload prove text interpolation (never HTML execution).
 */
export const AGORA_TITLE =
  '<script>alert("agora-title-xss")</script> & <b>title</b> "quoted"';
export const AGORA_BODY =
  '<img src=x onerror="window.__agoraXss=1"> & ' +
  '<script>window.__agoraXss=2</script>\nsecond line "body"';
export const AGORA_REJECT_TITLE =
  '<script>alert("agora-reject-xss")</script> reject title';
export const AGORA_REJECT_BODY = 'rejected body <b>bold</b> & "quotes"';
export const AGORA_AMBIGUOUS_TITLE =
  '<script>alert("agora-unknown-xss")</script> unknown title';
export const AGORA_AMBIGUOUS_BODY = "ambiguous body <i>italic</i>";

/** Verified fake thread target returned by the success transport only. */
export const AGORA_RESULT_THREAD_ID = "thread-e2e-verified";
export const AGORA_RESULT_URL = `https://agora.grimoire-fio.workers.dev/t/${AGORA_RESULT_THREAD_ID}`;
