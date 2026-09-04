// Deterministic fake RunStrategy implementations for engine tests.
//
// These are test doubles, not production strategies: fixed outputs, no
// randomness, no I/O, and explicit cooperation/ignorance of the abort
// signal so cancel, watchdog, and drain semantics stay deterministic.

import type { RunResult } from "@companion/contracts";
import {
  type RunStrategy,
  type RunStrategyContext,
  StrategyError,
} from "./strategy.js";

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function successResult(text: string): RunResult {
  return { version: 1, text };
}

/** Resolves immediately with a fixed answer. */
export function immediateSuccess(text: string): RunStrategy {
  return async () => successResult(text);
}

/** Throws a fixed safe StrategyError. */
export function failingStrategy(errorCode: string): RunStrategy {
  return async () => {
    throw new StrategyError(errorCode);
  };
}

/** Throws a raw non-strategy error (engine must map it, never persist it). */
export function explodingStrategy(): RunStrategy {
  return async () => {
    throw new Error("raw boom with secrets that must never persist");
  };
}

/** Returns a candidate that fails RunResult validation. */
export function invalidResultStrategy(): RunStrategy {
  return async () => ({ version: 1, text: "" }) as unknown as RunResult;
}

export interface GateObserver {
  entered: string[];
  aborted: string[];
}

/**
 * Cooperative gate: waits for `gate` before succeeding, rejects promptly
 * with execution_cancelled on abort. Records entry/abort order for tests.
 */
export function gatedSuccess(
  gate: Deferred,
  text: string,
  runKey: string,
  observer: GateObserver,
): RunStrategy {
  return async (ctx: RunStrategyContext) => {
    observer.entered.push(runKey);
    if (ctx.signal.aborted) {
      observer.aborted.push(runKey);
      throw new StrategyError("execution_cancelled");
    }
    await Promise.race([
      gate.promise,
      new Promise<void>((_, reject) => {
        ctx.signal.addEventListener(
          "abort",
          () => {
            observer.aborted.push(runKey);
            reject(new StrategyError("execution_cancelled"));
          },
          { once: true },
        );
      }),
    ]);
    if (ctx.signal.aborted) {
      throw new StrategyError("execution_cancelled");
    }
    return successResult(text);
  };
}

/**
 * Non-cooperative strategy: ignores the abort signal entirely and
 * resolves after `ms` via the provided sleep. Late results must be
 * discarded by repository CAS.
 */
export function nonCooperativeDelayed(
  text: string,
  ms: number,
  sleep: (ms: number) => Promise<void>,
  runKey: string,
  observer: GateObserver,
): RunStrategy {
  return async () => {
    observer.entered.push(runKey);
    await sleep(ms);
    return successResult(text);
  };
}

/** Never resolves, even after abort: exercises the cancel watchdog. */
export function neverResolving(
  runKey: string,
  observer: GateObserver,
): RunStrategy {
  return async (_ctx: RunStrategyContext) => {
    observer.entered.push(runKey);
    await new Promise<never>(() => {});
    throw new StrategyError("execution_failed");
  };
}

/** Resolves only when aborted, recording the abort (fast cooperative cancel). */
export function abortOnly(runKey: string, observer: GateObserver): RunStrategy {
  return (ctx: RunStrategyContext) =>
    new Promise<RunResult>((_resolve, reject) => {
      observer.entered.push(runKey);
      if (ctx.signal.aborted) {
        observer.aborted.push(runKey);
        reject(new StrategyError("execution_cancelled"));
        return;
      }
      ctx.signal.addEventListener(
        "abort",
        () => {
          observer.aborted.push(runKey);
          reject(new StrategyError("execution_cancelled"));
        },
        { once: true },
      );
    });
}
