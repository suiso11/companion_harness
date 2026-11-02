/// <reference lib="dom" />
// Avatar life shared by the VRM and FBX stages: rest pose, idle motion, gaze,
// blinking and mouth smoothing.
//
// Both stages expose the same semantic bones (hips, chest, head, arms) but
// their local axes differ, so every offset here is authored as a WORLD-space
// rotation and conjugated into the bone's local frame once at load. That also
// covers VRM 0.x scenes, which are rotated by PI.
//
// FBXLoader chains a duplicate of each bone under the original for every extra
// skinned mesh (the configured model has 13), so callers pose the chain head
// only (`chainHead`): the clones inherit the transform.

import * as THREE from "three";

/** Semantic bones both stages provide. */
export interface AvatarRig {
  readonly hips: THREE.Object3D;
  readonly chest: THREE.Object3D | null;
  readonly head: THREE.Object3D;
  readonly upperArmL: THREE.Object3D;
  readonly upperArmR: THREE.Object3D;
  readonly lowerArmL: THREE.Object3D;
  readonly lowerArmR: THREE.Object3D;
}

/** First bone named `name` whose ancestors never repeat that name. */
export function chainHead(
  root: THREE.Object3D,
  name: string,
): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((object) => {
    if (found !== null || !(object as THREE.Bone).isBone) {
      return;
    }
    if (object.name !== name) {
      return;
    }
    let parent = object.parent;
    while (parent !== null) {
      if (parent.name === name) {
        return;
      }
      parent = parent.parent;
    }
    found = object;
  });
  return found;
}

/**
 * A bone's transform is always rebuilt as `rest * localDelta`, where the
 * delta is the local image of a world-space rotation captured at load.
 */
export interface PoseBone {
  readonly bone: THREE.Object3D;
  readonly rest: THREE.Quaternion;
  readonly worldInverse: THREE.Quaternion;
  /** Local directions of world X/Y/Z under this bone's captured pose. */
  readonly axisX: THREE.Vector3;
  readonly axisY: THREE.Vector3;
  readonly axisZ: THREE.Vector3;
}

export function capturePose(bone: THREE.Object3D): PoseBone {
  bone.updateWorldMatrix(true, false);
  const world = new THREE.Quaternion();
  bone.getWorldQuaternion(world);
  const inverse = world.clone().invert();
  return {
    bone,
    rest: bone.quaternion.clone(),
    worldInverse: inverse,
    axisX: new THREE.Vector3(1, 0, 0).applyQuaternion(inverse),
    axisY: new THREE.Vector3(0, 1, 0).applyQuaternion(inverse),
    axisZ: new THREE.Vector3(0, 0, 1).applyQuaternion(inverse),
  };
}

const deltaA = new THREE.Quaternion();
const deltaB = new THREE.Quaternion();
const deltaC = new THREE.Quaternion();

/** Rebuild the pose from rest plus world-axis rotations rx/ry/rz (radians). */
export function poseAngles(
  pose: PoseBone,
  rx: number,
  ry: number,
  rz: number,
): void {
  pose.bone.quaternion
    .copy(pose.rest)
    .multiply(deltaA.setFromAxisAngle(pose.axisX, rx))
    .multiply(deltaB.setFromAxisAngle(pose.axisY, ry))
    .multiply(deltaC.setFromAxisAngle(pose.axisZ, rz));
}

const deltaQ = new THREE.Quaternion();

/** Rebuild the pose from rest plus one world-space rotation. */
export function poseWorldQuat(
  pose: PoseBone,
  worldRotation: THREE.Quaternion,
): void {
  deltaQ
    .copy(pose.worldInverse)
    .multiply(worldRotation)
    .multiply(pose.worldInverse.clone().invert());
  pose.bone.quaternion.copy(pose.rest).multiply(deltaQ);
}

const armFrom = new THREE.Vector3();
const armTo = new THREE.Vector3();
const armTarget = new THREE.Vector3();
const armRotation = new THREE.Quaternion();
const elbowRotation = new THREE.Quaternion();

/**
 * Drop the arms out of the T-pose: align shoulder→elbow with a slightly
 * outward, hanging direction, then bend both elbows a little forward.
 */
export function relaxArms(rig: AvatarRig): void {
  for (const [upper, lower, side] of [
    [rig.upperArmL, rig.lowerArmL, 1],
    [rig.upperArmR, rig.lowerArmR, -1],
  ] as const) {
    upper.updateWorldMatrix(true, false);
    lower.updateWorldMatrix(true, false);
    upper.getWorldPosition(armFrom);
    lower.getWorldPosition(armTo);
    armTo.sub(armFrom);
    if (armTo.lengthSq() === 0) {
      continue;
    }
    armTo.normalize();
    armTarget.set(side * 0.16, -1, 0.05).normalize();
    armRotation.setFromUnitVectors(armTo, armTarget);
    poseWorldQuat(capturePose(upper), armRotation);
  }
  // The forearms moved with the shoulders: capture them in the new pose.
  for (const lower of [rig.lowerArmL, rig.lowerArmR]) {
    poseWorldQuat(
      capturePose(lower),
      elbowRotation.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.18),
    );
  }
}

/** One-pole approach: frame-rate independent, no overshoot. */
export function damp(
  current: number,
  target: number,
  rate: number,
  dt: number,
): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Pointer position in [-1, 1] per axis → head yaw/pitch (radians). */
export function lookAngles(
  nx: number,
  ny: number,
): { yaw: number; pitch: number } {
  return { yaw: nx * 0.45, pitch: -ny * 0.25 };
}

export interface IdleAngles {
  readonly hipsZ: number;
  readonly chestX: number;
  readonly headX: number;
  readonly headY: number;
}

/** Breathing, weight shift and micro head motion at time `t` (seconds). */
export function idleAngles(t: number): IdleAngles {
  return {
    hipsZ: 0.012 * Math.sin(2 * Math.PI * 0.07 * t),
    chestX: 0.018 * Math.sin(2 * Math.PI * 0.22 * t),
    headX: 0.01 * Math.sin(2 * Math.PI * 0.13 * t + 1.1),
    headY: 0.02 * Math.sin(2 * Math.PI * 0.05 * t),
  };
}

/** Blink duration and the closed-fraction curve within one blink. */
export const BLINK_MS = 160;

export function blinkEnvelope(progress: number): number {
  if (progress <= 0 || progress >= 1) {
    return 0;
  }
  const smooth = (x: number): number => x * x * (3 - 2 * x);
  if (progress < 0.3) {
    return smooth(progress / 0.3);
  }
  if (progress < 0.45) {
    return 1;
  }
  return 1 - smooth((progress - 0.45) / 0.55);
}

/** Random-interval blink state machine; `weight` is 0..1 closed. */
export class Blinker {
  #startedAt = -1;
  #nextAt = 0;
  readonly #random: () => number;
  readonly #now: () => number;

  constructor(now: () => number, random: () => number = Math.random) {
    this.#now = now;
    this.#random = random;
  }

  weight(): number {
    const now = this.#now();
    if (this.#startedAt < 0) {
      this.#startedAt = now;
      this.#nextAt = now + 2200;
      return 0;
    }
    if (now < this.#nextAt) {
      return 0;
    }
    const progress = (now - this.#nextAt) / BLINK_MS;
    if (progress >= 1) {
      this.#nextAt = now + 2400 + this.#random() * 3600;
      return 0;
    }
    return blinkEnvelope(progress);
  }
}
