// RunStrategy contract + replaceable registry (M0 §3, §11).
//
// Ownership: the RunEngine alone owns the Run lifecycle. A RunStrategy
// (Agent is only a FUTURE strategy — never the owner) receives an
// immutable run/turn view, the frozen turn context, and an AbortSignal,
// and returns a candidate RunResult or throws a fixed safe error.
// Strategies never touch the database: they are given no connection,
// no repository, and no mutable state.

import {
  type FrozenContext,
  RunErrorCodeSchema,
  type RunResult,
  type TurnInputV1,
} from "@companion/contracts";

/** Immutable run identity handed to a strategy. */
export interface StrategyRunView {
  readonly id: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly strategy: string;
}

/** Immutable turn view handed to a strategy (input + frozen context). */
export interface StrategyTurnView {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly input: TurnInputV1;
  readonly frozenContext: FrozenContext;
}

/** The only input a strategy may observe. Deeply frozen by the engine. */
export interface RunStrategyContext {
  readonly run: StrategyRunView;
  readonly turn: StrategyTurnView;
  readonly signal: AbortSignal;
}

/**
 * A replaceable execution strategy. Returns a CANDIDATE RunResult (the
 * engine validates it and commits via repository CAS only) or throws a
 * fixed safe error (prefer StrategyError with a redact-safe code).
 * Raw thrown values are never persisted; the engine maps them to a
 * fixed `error_code`.
 */
export type RunStrategy = (ctx: RunStrategyContext) => Promise<RunResult>;

/**
 * Fixed safe error a strategy throws to request a specific redacted
 * failure code. The code is validated at construction: free-text or
 * raw errors cannot pass through.
 */
export class StrategyError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message?: string) {
    const code = RunErrorCodeSchema.parse(errorCode);
    super(message ?? code);
    this.name = "StrategyError";
    this.errorCode = code;
  }
}

/** Replaceable name -> strategy map. Re-registering a name replaces it. */
export class StrategyRegistry {
  private readonly strategies = new Map<string, RunStrategy>();

  register(name: string, strategy: RunStrategy): void {
    if (typeof name !== "string" || name.length === 0 || name.length > 128) {
      throw new Error("strategy name must be 1..128 chars");
    }
    if (typeof strategy !== "function") {
      throw new Error(`strategy ${name} must be a function`);
    }
    this.strategies.set(name, strategy);
  }

  unregister(name: string): boolean {
    return this.strategies.delete(name);
  }

  resolve(name: string): RunStrategy | undefined {
    return this.strategies.get(name);
  }

  has(name: string): boolean {
    return this.strategies.has(name);
  }

  names(): string[] {
    return [...this.strategies.keys()];
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    const record = value as Record<string | symbol, unknown>;
    for (const key of Reflect.ownKeys(record)) {
      deepFreeze(record[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Build the deeply-frozen strategy view. The AbortSignal stays live. */
export function freezeStrategyContext(
  run: StrategyRunView,
  turn: Omit<StrategyTurnView, "input" | "frozenContext"> & {
    input: TurnInputV1;
    frozenContext: FrozenContext;
  },
  signal: AbortSignal,
): RunStrategyContext {
  return Object.freeze({
    run: Object.freeze({ ...run }),
    turn: Object.freeze({
      id: turn.id,
      sessionId: turn.sessionId,
      seq: turn.seq,
      input: deepFreeze(structuredClone(turn.input)),
      frozenContext: deepFreeze(structuredClone(turn.frozenContext)),
    }),
    signal,
  });
}
