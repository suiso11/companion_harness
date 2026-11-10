// Main-conversation persona instructions (migration 0047).
//
// A single optional block appended to the immutable AGENT_SYSTEM_PROMPT by
// the agent strategy. It can add tone/persona guidance but never replaces
// the base safety contract. No row means "base prompt only".

import type Database from "better-sqlite3";
import { RepositoryValidationError } from "./errors.js";

export const MAX_MAIN_PERSONA_INSTRUCTIONS = 4000;

export interface MainPersona {
  readonly instructions: string;
  readonly updatedAt: number;
}

export interface MainPersonaStore {
  get(): MainPersona | null;
  /** Empty instructions clear the row. */
  set(instructions: string, now: number): MainPersona | null;
}

export function createMainPersonaStore(options: {
  db: Database.Database;
}): MainPersonaStore {
  const { db } = options;
  const get = (): MainPersona | null =>
    (db
      .prepare(
        "SELECT instructions, updated_at AS updatedAt FROM main_persona WHERE id = 1",
      )
      .get() as MainPersona | undefined) ?? null;

  return {
    get,
    set(instructions, now) {
      if (typeof instructions !== "string") {
        throw new RepositoryValidationError("instructions must be a string");
      }
      if (instructions.length > MAX_MAIN_PERSONA_INSTRUCTIONS) {
        throw new RepositoryValidationError(
          `instructions must be at most ${MAX_MAIN_PERSONA_INSTRUCTIONS} chars`,
        );
      }
      if (instructions.includes("\0")) {
        throw new RepositoryValidationError(
          "instructions must not contain NUL",
        );
      }
      if (instructions.length === 0) {
        db.prepare("DELETE FROM main_persona WHERE id = 1").run();
        return null;
      }
      db.prepare(
        "INSERT INTO main_persona (id, instructions, updated_at) VALUES (1, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET instructions = excluded.instructions, updated_at = excluded.updated_at",
      ).run(instructions, now);
      return get();
    },
  };
}
