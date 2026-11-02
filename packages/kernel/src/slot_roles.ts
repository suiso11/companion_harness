// Slot-role taxonomy for the pre-write confirmation gate.
//
// An ASR error is not equally damaging in every position: a wrong digit in a
// date or a dropped negation changes WHAT GETS WRITTEN, while a wrong
// particle only reads strangely. The gate therefore looks at the SLOT a value
// ends up in, never at the transcript, and only for tools that mutate
// something (durably, externally, or by adopting a draft in the same call).
// Read tools are never listed and are never gated.
//
// Roles are deliberately coarse:
// - `number`  — a date, time, duration, or quantity the model chose.
// - `entity`  — a name, id, quote, or free-text body the user dictated. A
//   dropped negation cannot be a separate field in any current tool schema;
//   it lands inside one of these content slots, so gating the slot also
//   covers negation errors.
// - `other`   — enums, versions, and lookup ids that are not user content.
//
// Values are only ever compared as non-empty strings; nothing here is
// persisted (the broker stores the post-Zod args hash, never the values).

export type SlotRole = "number" | "entity" | "other";

export const SLOT_ROLES_BY_TOOL: Readonly<
  Record<string, Readonly<Record<string, SlotRole>>>
> = {
  "calendar.reschedule": { start: "number", end: "number", reason: "entity" },
  "calendar.create": { title: "entity", start: "number", end: "number" },
  "memory.correct": { correctionBody: "entity", handle: "entity" },
  "memory.retire": { handle: "entity" },
  "memory.reactivate": { handle: "entity" },
  "purpose.propose": {
    scope: "entity",
    sourceQuote: "entity",
    interpretation: "entity",
  },
  "task.propose": {
    scope: "entity",
    sourceQuote: "entity",
    interpretation: "entity",
  },
  "trial.propose": {
    objective: "entity",
    acceptance: "entity",
    literalPatchPaths: "entity",
    expiryMinutes: "number",
  },
};

/**
 * Non-empty values of the risky (`number`/`entity`) slots in one validated
 * tool input. String arrays count as one risky value each; absent, empty, and
 * non-string values are ignored. An empty result means "nothing to confirm".
 */
export function riskySlotValues(toolName: string, input: unknown): string[] {
  const roles = SLOT_ROLES_BY_TOOL[toolName];
  if (roles === undefined || typeof input !== "object" || input === null) {
    return [];
  }
  // Post-Zod tool inputs are plain objects; the schema fixed the shape.
  const fields = input as Record<string, unknown>;
  const values: string[] = [];
  for (const [slot, role] of Object.entries(roles)) {
    if (role !== "number" && role !== "entity") {
      continue;
    }
    const value = fields[slot];
    if (typeof value === "string" && value.trim().length > 0) {
      values.push(value);
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      values.push(String(value));
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim().length > 0) {
          values.push(item);
        }
      }
    }
  }
  return values;
}
