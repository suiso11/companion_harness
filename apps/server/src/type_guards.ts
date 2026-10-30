// Canonical runtime object guard for server-owned boundary values.
// Field shapes are still validated by the caller; this only proves an object.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
