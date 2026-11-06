/// <reference lib="dom" />
// Autonomous behavior for the desktop pet: a small hierarchical state machine
// plus 1-D screen locomotion. Pure and seeded so it can be unit-tested; the
// stage only consumes the snapshot.
//
// States: idle (small gestures) → walk (pick a destination) or rest (sit /
// doze), and interact (the user has the character's attention). Walk speed is
// integrated with acceleration and deceleration, and the walk cycle phase is
// advanced from the distance actually travelled, never from wall time, so the
// feet cannot slide when the speed changes.

export type BehaviorMode = "idle" | "walk" | "rest" | "interact";

export interface BehaviorSnapshot {
  /** Normalized screen position, 0 = left margin, 1 = right margin. */
  readonly x: number;
  readonly facing: -1 | 1;
  readonly mode: BehaviorMode;
  /** Current speed as a fraction of the configured maximum (0..1). */
  readonly speed: number;
  /** Walk-cycle phase in radians (one cycle = two steps). */
  readonly walkPhase: number;
}

export interface BehaviorOptions {
  readonly minX?: number;
  readonly maxX?: number;
  /** Normalized units per second at full speed. */
  readonly maxSpeed?: number;
  /** Normalized units per second squared. */
  readonly acceleration?: number;
  readonly idleSeconds?: readonly [number, number];
  readonly restSeconds?: readonly [number, number];
  /** A destination closer than this (normalized) is re-rolled. */
  readonly minTravel?: number;
  /** One full walk cycle (two steps) per this many normalized units. */
  readonly stride?: number;
}

const DEFAULTS = {
  minX: 0.08,
  maxX: 0.92,
  maxSpeed: 0.16,
  acceleration: 0.35,
  idleSeconds: [2.5, 8] as const,
  restSeconds: [4, 10] as const,
  minTravel: 0.18,
  stride: 0.2,
};

type Options = Required<BehaviorOptions>;

export class BehaviorBrain {
  readonly #random: () => number;
  readonly #options: Options;
  #x = 0.5;
  #targetX = 0.5;
  #velocity = 0;
  #facing: -1 | 1 = 1;
  #mode: BehaviorMode = "idle";
  #timer: number;
  #walkPhase = 0;

  constructor(
    random: () => number = Math.random,
    options: BehaviorOptions = {},
  ) {
    this.#random = random;
    this.#options = { ...DEFAULTS, ...options };
    this.#timer = this.#nextIdle();
  }

  snapshot(): BehaviorSnapshot {
    const { maxSpeed } = this.#options;
    return {
      x: this.#x,
      facing: this.#facing,
      mode: this.#mode,
      speed: Math.min(Math.abs(this.#velocity) / maxSpeed, 1),
      walkPhase: this.#walkPhase,
    };
  }

  /** The user has the character's attention: stop and stay put. */
  interrupt(): void {
    this.#mode = "interact";
    this.#velocity = 0;
  }

  /** Give the character back to its own devices. */
  resume(): void {
    this.#mode = "idle";
    this.#velocity = 0;
    this.#targetX = this.#x;
    this.#timer = this.#nextIdle();
  }

  update(dt: number): BehaviorSnapshot {
    const { minX, maxX, maxSpeed, acceleration, stride } = this.#options;
    const step = Math.min(Math.max(dt, 0), 0.05);
    if (this.#mode === "interact") {
      return this.snapshot();
    }
    if (this.#mode === "walk") {
      const distance = this.#targetX - this.#x;
      const direction = Math.sign(distance) || 1;
      this.#facing = direction > 0 ? 1 : -1;
      // Square-root braking keeps the stop smooth at any distance.
      const desired =
        direction *
        Math.min(maxSpeed, Math.sqrt(2 * acceleration * Math.abs(distance)));
      const maxDelta = acceleration * step;
      this.#velocity += Math.max(
        -maxDelta,
        Math.min(maxDelta, desired - this.#velocity),
      );
      // Never step past the target: clamping here (not after the fact)
      // removes the overshoot/backtrack jitter at the stop.
      const before = this.#x;
      const next = before + this.#velocity * step;
      const crossed = (this.#targetX - next) * distance <= 0;
      this.#x = crossed ? this.#targetX : next;
      const travelled = this.#x - before;
      // Feet track the ground: phase moves with the distance, not the clock.
      this.#walkPhase += (Math.abs(travelled) / stride) * Math.PI * 2;
      if (
        crossed ||
        (Math.abs(distance) < 0.002 && Math.abs(this.#velocity) < 0.01)
      ) {
        this.#x = this.#targetX;
        this.#velocity = 0;
        this.#mode = "idle";
        this.#timer = this.#nextIdle();
      }
    } else {
      this.#timer -= step;
      if (this.#timer <= 0) {
        if (this.#mode === "rest") {
          this.#mode = "idle";
          this.#timer = this.#nextIdle();
        } else if (this.#random() < 0.75 && this.#pickDestination()) {
          this.#mode = "walk";
        } else {
          this.#mode = "rest";
          this.#timer = this.#between(...this.#options.restSeconds);
        }
      }
    }
    this.#x = Math.max(minX, Math.min(maxX, this.#x));
    return this.snapshot();
  }

  #pickDestination(): boolean {
    const { minX, maxX, minTravel } = this.#options;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = minX + this.#random() * (maxX - minX);
      if (Math.abs(candidate - this.#x) > minTravel) {
        this.#targetX = candidate;
        return true;
      }
    }
    return false;
  }

  #between(min: number, max: number): number {
    return min + this.#random() * (max - min);
  }

  #nextIdle(): number {
    return this.#between(...this.#options.idleSeconds);
  }
}
