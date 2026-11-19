// Explicit session deep link (`?session=<uuid>`) for feature pages.
//
// The shared session store otherwise adopts the last chat session from
// localStorage; a loop-proposal notice links straight to the session whose
// /trials list holds the proposal (912dcf8a…, not the chat the user reads).

const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valid lowercase session id from a location search string, else null. */
export function sessionFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("session");
  return raw !== null && SESSION_UUID.test(raw) ? raw.toLowerCase() : null;
}
