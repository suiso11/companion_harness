import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import { STDERR_CAP_BYTES } from "./config.js";

/** Structural view of a piped stderr stream without touching SDK privates. */
interface ReadableStderr {
  on(event: "data", listener: (chunk: unknown) => void): void;
  removeListener?(event: "data", listener: (chunk: unknown) => void): void;
}

interface RawWithStderr {
  stderr?: ReadableStderr | null;
}

export interface OwnedConnectionHooks {
  /**
   * Called SYNCHRONOUSLY and at most once when the owned stderr counter
   * crosses the 64KiB cap. The connector owns the stop/cleanup reaction.
   */
  onOverflow: (session: OwnedConnection) => void;
  /**
   * Called SYNCHRONOUSLY and at most once when the raw transport reports an
   * actual close event. `intentional` is true when the close belongs to an
   * already-requested bounded cleanup rather than a spontaneous loss. The
   * connector owns the state-invalidation/cleanup reaction.
   */
  onClosed: (session: OwnedConnection, info: { intentional: boolean }) => void;
  /** Bounded grace window for a late-start owned cleanup. */
  shutdownWaitMs: number;
  /** Fixed post-SIGKILL window for a late-start owned cleanup. */
  forceKillWaitMs: number;
}

/** Resolve `true` as soon as any promise settles, else `false` after `ms`. */
function waitForSettle(
  promises: Promise<unknown>[],
  ms: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(false), ms);
    if (promises.length === 0) {
      finish(true);
      return;
    }
    for (const promise of promises) {
      promise.then(
        () => finish(true),
        () => {
          // Rejections are already normalized by the callers; the remaining
          // promises or the deadline decide the outcome.
        },
      );
    }
  });
}

/** Byte length of a stream chunk without decoding or retaining it. */
function chunkByteLength(chunk: unknown): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  if (chunk !== null && typeof chunk === "object") {
    const length = (chunk as { length?: unknown }).length;
    if (typeof length === "number" && Number.isFinite(length) && length > 0) {
      return length;
    }
  }
  return 0;
}

/**
 * Boring owned connection record + structural Transport wrapper (C09-05/06).
 *
 * Created BEFORE any async dial. It is the single object that:
 * - installs the COUNT-ONLY stderr drain (before `start`, never buffers bytes),
 * - captures a real-SDK-stdio `pid` BEFORE `close()` clears the getter,
 * - exposes idempotent raw-close and "raw close observed" promises,
 * - fences every await with a synchronous `stop` flag,
 * - tracks cancellable in-flight SDK operations,
 * - implements Transport by delegating to the wrapped real transport while
 *   preserving preexisting callbacks and the Protocol callback chain.
 *
 * No SDK private fields are read; only public API and public class identity.
 */
export class OwnedConnection implements Transport {
  readonly client: Client;
  readonly raw: Transport;
  readonly isRealStdio: boolean;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;
  sessionId?: string;

  ready = false;
  stop = false;
  failureRecorded = false;
  stderrBytes = 0;
  stderrOverflow = false;
  /** Positive pid of the owned real-SDK-stdio child, else undefined. */
  ownedPid: number | undefined;
  /** True once the raw transport reported an actual close event. */
  closeSeen = false;

  private readonly hooks: OwnedConnectionHooks;
  private readonly closeObservedPromise: Promise<void>;
  private resolveCloseObserved!: () => void;
  private started = false;
  private rawClosePromise: Promise<void> | undefined;
  private clientClosePromise: Promise<void> | undefined;
  private boundedClosePromise: Promise<void> | undefined;
  /**
   * Latch for the CURRENT raw-close generation: true once that generation's
   * close promise has settled. A SUPERSEDED generation's late settlement must
   * never mutate it (identity-guarded in `closeRaw`).
   */
  private closeCompleted = false;
  /** Monotonic generation of the current raw-close memo. */
  private closeGeneration = 0;
  /** True once the current start attempt has settled (fulfilled OR rejected). */
  private handoffComplete = false;
  /**
   * True when a raw close was invoked (or observed) BEFORE the start handed
   * off its resource. Such a close cannot release a resource a late start
   * creates only when it settles, regardless of that close promise's own
   * settlement (which may still be pending, or its finally never run).
   */
  private preHandoffClose = false;
  private stderrStream: ReadableStderr | undefined;
  private stderrListener: ((chunk: unknown) => void) | undefined;
  private readonly active = new Set<AbortController>();

  constructor(
    raw: Transport,
    clientInfo: { name: string; version: string },
    hooks: OwnedConnectionHooks,
  ) {
    this.raw = raw;
    this.hooks = hooks;
    // Public class identity only: never a private field or pid-shaped duck type.
    this.isRealStdio = raw instanceof StdioClientTransport;
    this.client = new Client(clientInfo, { capabilities: {} });
    this.closeObservedPromise = new Promise<void>((resolve) => {
      this.resolveCloseObserved = resolve;
    });
    this.installRawCallbacks();
    this.attachStderrDrain();
  }

  /** Resolves when the raw transport reports an actual close event. */
  get closeObserved(): Promise<void> {
    return this.closeObservedPromise;
  }

  /**
   * Registers an owned operation controller so a stop/overflow can abort it
   * while caller-forwarding listeners are still attached. If already stopped,
   * the controller is aborted immediately and not tracked.
   */
  trackOp(controller: AbortController): void {
    if (this.stop) {
      try {
        controller.abort("cancelled");
      } catch {
        // ignore
      }
      return;
    }
    this.active.add(controller);
  }

  untrackOp(controller: AbortController): void {
    this.active.delete(controller);
  }

  /**
   * Synchronous stop: set the fence, clear ready, abort every owned in-flight
   * SDK operation with a fixed non-sensitive reason. Does not wait the mutex.
   */
  beginStop(): void {
    this.stop = true;
    this.ready = false;
    this.abortActive();
  }

  /** Abort every tracked operation with the fixed reason; never throws. */
  private abortActive(): void {
    for (const controller of this.active) {
      try {
        controller.abort("cancelled");
      } catch {
        // ignore
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("transport already started");
    this.started = true;
    // Guard BEFORE start: a connection stopped before the SDK ever started
    // must not spawn or begin a handshake at all.
    if (this.stop) throw new Error("mcp_unavailable");
    // `start()` spawns synchronously for the real stdio transport, so the pid
    // is knowable immediately after the invocation and again after the await.
    try {
      const started = this.raw.start();
      this.capturePid();
      await started;
      // A stop/close observed while the raw start was pending retires the
      // connection with the fixed code (no ready publication).
      if (this.stop) throw new Error("mcp_unavailable");
      this.capturePid();
      this.syncSessionId();
    } finally {
      // Resource-handoff point that runs for BOTH fulfilment and REJECTION: a
      // raw start may create its resource and only THEN reject, so a bounded
      // late handoff cleanup must never depend on post-fulfilment flow alone.
      // No readiness/session id is published from here.
      this.handoffComplete = true;
      if (this.stop) {
        await this.startLateCleanup();
      }
    }
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    await this.raw.send(message, options);
    this.syncSessionId();
  }

  close(): Promise<void> {
    return this.closeRaw();
  }

  setProtocolVersion(version: string): void {
    this.raw.setProtocolVersion?.(version);
  }

  /**
   * Idempotent bounded cleanup. Real stdio waits for the actual child close
   * event under the grace window, then SIGKILLs ONLY an owned positive pid and
   * waits the finite post-kill window for the same close event. Generic
   * transports settle by close resolution or close event with no process claim.
   */
  boundedClose(graceMs: number, forceKillWaitMs: number): Promise<void> {
    if (this.boundedClosePromise !== undefined) return this.boundedClosePromise;
    this.boundedClosePromise = this.runBoundedClose(graceMs, forceKillWaitMs);
    return this.boundedClosePromise;
  }

  private async runBoundedClose(
    graceMs: number,
    forceKillWaitMs: number,
  ): Promise<void> {
    this.beginStop();
    // The owned raw close is issued directly (memoized) so cleanup still
    // releases the physical transport even when the SDK Protocol has already
    // detached from it (its own onclose ran first).
    const rawClose = this.closeRaw();
    const clientClose = this.beginClientClose();
    if (!this.isRealStdio) {
      // No process-death claim is possible for an arbitrary transport; bound
      // the host-side wait so a hanging close() can never strand shutdown.
      await waitForSettle(
        [this.closeObservedPromise, clientClose, rawClose],
        graceMs,
      );
      return;
    }
    // Actual NODE child 'close' event is the only exit proof: `close()`
    // resolution and a null pid getter are deliberately NOT treated as proof.
    if (await waitForSettle([this.closeObservedPromise], graceMs)) return;
    if (this.ownedPid !== undefined && !this.closeSeen) {
      try {
        process.kill(this.ownedPid, "SIGKILL");
      } catch {
        // ESRCH / EPERM: SIGKILL delivery is never itself exit proof.
      }
      await waitForSettle([this.closeObservedPromise], forceKillWaitMs);
    }
  }

  /**
   * Bounded late-resource cleanup for a raw start that settles (fulfils OR
   * rejects) AFTER this connection was stopped.
   *
   * The trigger is the INVOCATION/handoff PHASE, never the earlier close
   * promise's settlement: a close invoked before the resource handoff cannot
   * release a resource the start creates only when it settles, even if that
   * close promise is still pending or its finally never runs. When such a
   * pre-handoff close exists the memo is dropped and ONE fresh owned raw close
   * is issued (memoized again, bounded by the configured grace + fixed
   * post-kill window).
   *
   * Real stdio spawns its child synchronously at the start invocation, so a
   * pre-handoff close already targeted the owned child; re-issuing there would
   * only risk a redundant force/new-pid interaction, so it is skipped.
   */
  private async startLateCleanup(): Promise<void> {
    // The invocation/handoff PHASE is authoritative. The settlement latch is
    // only a defensive fallback (a close that completed without ever observing
    // the resource); it never re-enables the old settlement-proxy behavior.
    const settlementFallback = this.closeCompleted && !this.closeSeen;
    if ((this.preHandoffClose || settlementFallback) && !this.isRealStdio) {
      this.rawClosePromise = undefined;
      this.boundedClosePromise = undefined;
      this.closeCompleted = false;
      this.preHandoffClose = false;
    }
    await this.boundedClose(
      this.hooks.shutdownWaitMs,
      this.hooks.forceKillWaitMs,
    );
  }

  private beginClientClose(): Promise<void> {
    if (this.clientClosePromise !== undefined) return this.clientClosePromise;
    this.clientClosePromise = Promise.resolve()
      .then(() => this.client.close())
      .catch(() => undefined);
    return this.clientClosePromise;
  }

  private closeRaw(): Promise<void> {
    if (this.rawClosePromise !== undefined) return this.rawClosePromise;
    // Capture the pid BEFORE `raw.close()` clears it (real stdio clears the
    // getter synchronously even though the child may still be alive).
    this.capturePid();
    this.closeGeneration += 1;
    const generation = this.closeGeneration;
    // Assign the memoized promise BEFORE the inner close can invoke the close
    // observer, so a reentrant sync-onclose cleanup cannot deadlock.
    let memo: Promise<void>;
    memo = Promise.resolve()
      .then(() => {
        // A close invoked before the start handed off cannot cover a resource
        // the late start creates afterwards: record the phase AT the physical
        // close invocation, not at memo creation. A gate release followed by an
        // immediate shutdown can finish the handoff before this deferred
        // continuation; flagging at scheduling time would then trigger a
        // needless SECOND generic physical close.
        if (!this.handoffComplete) this.preHandoffClose = true;
        return this.raw.close();
      })
      .catch(() => undefined)
      .finally(() => {
        // Identity guard: only the CURRENT generation may latch completion, so
        // a superseded memo's late settlement can never mutate fresh state.
        if (
          this.closeGeneration === generation &&
          this.rawClosePromise === memo
        ) {
          this.closeCompleted = true;
        }
      });
    this.rawClosePromise = memo;
    return memo;
  }

  private installRawCallbacks(): void {
    const raw = this.raw;
    const priorClose = raw.onclose;
    const priorError = raw.onerror;
    const priorMessage = raw.onmessage;
    raw.onclose = () => {
      this.handleRawClose();
      if (this.onclose !== undefined) {
        try {
          this.onclose();
        } catch {
          // Preserve the Protocol callback chain; never throw from close.
        }
      }
      if (priorClose !== undefined) {
        try {
          priorClose();
        } catch {
          // Preserve a preexisting handler.
        }
      }
    };
    raw.onerror = (error: Error) => {
      if (priorError !== undefined) {
        try {
          priorError(error);
        } catch {
          // Preserve a preexisting handler.
        }
      }
      this.onerror?.(error);
    };
    raw.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
      if (priorMessage !== undefined) priorMessage(message, extra);
      this.onmessage?.(message, extra);
    };
  }

  private handleRawClose(): void {
    if (this.closeSeen) return;
    // An already-requested stop means the close is part of an intentional
    // bounded cleanup; otherwise it is a spontaneous transport loss.
    const intentional = this.stop;
    this.closeSeen = true;
    // TERMINAL latch for the OWNED connection: fence every await, abort every
    // in-flight op non-throwing, clear readiness and invalidate the pid so a
    // later connector never kills a recycled number or a fresh peer.
    this.stop = true;
    this.ready = false;
    this.abortActive();
    this.ownedPid = undefined;
    this.detachStderrDrain();
    this.resolveCloseObserved();
    // The raw transport closed itself: memoize a completed owned close so the
    // routed bounded cleanup is idempotent and never double-closes the peer.
    // A later late-start cleanup drops this memo and re-issues a real close.
    if (this.rawClosePromise === undefined) {
      this.rawClosePromise = Promise.resolve();
      this.closeCompleted = true;
      // A close OBSERVED before the handoff also predates a resource the late
      // start may create afterwards; same phase rule as an invoked close.
      if (!this.handoffComplete) this.preHandoffClose = true;
    }
    // Synchronous identity-guarded connector reaction (invalidate current
    // state / record a single unexpected failure / route bounded cleanup).
    this.hooks.onClosed(this, { intentional });
  }

  private attachStderrDrain(): void {
    const raw = this.raw as unknown as RawWithStderr;
    const stream = raw.stderr;
    if (
      stream === null ||
      stream === undefined ||
      typeof stream.on !== "function"
    ) {
      return;
    }
    const listener = (chunk: unknown) => {
      this.noteStderr(chunk);
    };
    stream.on("data", listener);
    this.stderrStream = stream;
    this.stderrListener = listener;
  }

  private detachStderrDrain(): void {
    const stream = this.stderrStream;
    const listener = this.stderrListener;
    if (stream !== undefined && listener !== undefined) {
      stream.removeListener?.("data", listener);
    }
    this.stderrStream = undefined;
    this.stderrListener = undefined;
  }

  /**
   * COUNT-ONLY: saturates at the cap and latches once. Continues to receive
   * (and discard) later chunks so the child never backpressures while closing.
   */
  private noteStderr(chunk: unknown): void {
    if (this.stderrOverflow) return;
    const bytes = chunkByteLength(chunk);
    if (bytes <= 0) return;
    this.stderrBytes += bytes;
    if (this.stderrBytes > STDERR_CAP_BYTES) {
      this.stderrBytes = STDERR_CAP_BYTES;
      this.stderrOverflow = true;
      this.hooks.onOverflow(this);
    }
  }

  private capturePid(): void {
    if (!this.isRealStdio) return;
    const pid = (this.raw as StdioClientTransport).pid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
      this.ownedPid = pid;
    }
  }

  private syncSessionId(): void {
    const sid = this.raw.sessionId;
    if (sid !== undefined) {
      this.sessionId = sid;
    } else {
      delete this.sessionId;
    }
  }
}
