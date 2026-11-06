// Avatar motion math: the rest pose and idle loop must not depend on a rig's
// local axes, and FBXLoader's clone chains must be posed from their head.
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  Blinker,
  blinkEnvelope,
  capturePose,
  chainHead,
  damp,
  idleAngles,
  lookAngles,
  poseAngles,
  relaxArms,
  walkOffsets,
} from "../src/lib/avatar_motion.js";

function worldQuat(object: THREE.Object3D): THREE.Quaternion {
  object.updateWorldMatrix(true, false);
  const quat = new THREE.Quaternion();
  object.getWorldQuaternion(quat);
  return quat;
}

function addBone(parent: THREE.Object3D, name: string): THREE.Bone {
  const bone = new THREE.Bone();
  bone.name = name;
  parent.add(bone);
  return bone;
}

describe("chainHead", () => {
  test("returns the topmost bone when FBXLoader clones a name", () => {
    const root = new THREE.Object3D();
    const head = addBone(root, "Hips");
    const clone = addBone(head, "Hips");
    addBone(clone, "Hips");
    expect(chainHead(root, "Hips")).toBe(head);
    expect(chainHead(root, "Nope")).toBeNull();
  });
});

describe("poseAngles", () => {
  test("applies a world-space rotation on top of the rest pose", () => {
    const parent = new THREE.Object3D();
    parent.rotation.y = Math.PI / 2;
    const bone = addBone(parent, "Chest");
    const before = worldQuat(bone);
    const pose = capturePose(bone);

    poseAngles(pose, 0.3, 0, 0);

    const expected = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3)
      .multiply(before);
    const actual = worldQuat(bone);
    expect(actual.angleTo(expected)).toBeLessThan(1e-6);
  });

  test("repeated frames do not accumulate", () => {
    const bone = addBone(new THREE.Object3D(), "Chest");
    const pose = capturePose(bone);
    poseAngles(pose, 0.2, 0, 0);
    const once = worldQuat(bone).clone();
    poseAngles(pose, 0.2, 0, 0);
    expect(worldQuat(bone).angleTo(once)).toBeLessThan(1e-6);
  });
});

describe("relaxArms", () => {
  test("hangs both arms downward from a T-pose", () => {
    const root = new THREE.Object3D();
    const chest = addBone(root, "Chest");
    const head = addBone(chest, "Head");
    const upperL = addBone(chest, "Upperarm_L");
    upperL.position.set(0.08, 1.1, 0);
    const lowerL = addBone(upperL, "Lowerarm_L");
    lowerL.position.set(0.21, 0, 0);
    const upperR = addBone(chest, "Upperarm_R");
    upperR.position.set(-0.08, 1.1, 0);
    const lowerR = addBone(upperR, "Lowerarm_R");
    lowerR.position.set(-0.21, 0, 0);

    relaxArms({
      hips: head,
      chest,
      head,
      upperArmL: upperL,
      upperArmR: upperR,
      lowerArmL: lowerL,
      lowerArmR: lowerR,
    });

    for (const [upper, lower, side] of [
      [upperL, lowerL, 1],
      [upperR, lowerR, -1],
    ] as const) {
      const from = new THREE.Vector3();
      const to = new THREE.Vector3();
      upper.getWorldPosition(from);
      lower.getWorldPosition(to);
      const direction = to.sub(from).normalize();
      expect(direction.y).toBeLessThan(-0.9);
      expect(Math.sign(direction.x)).toBe(side);
    }
  });
});

describe("damp", () => {
  test("approaches the target monotonically without overshoot", () => {
    let value = 0;
    for (let i = 0; i < 60; i += 1) {
      value = damp(value, 1, 6, 1 / 60);
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(value).toBeGreaterThan(0.99);
  });

  test("is frame-rate independent for small steps", () => {
    const coarse = damp(0, 1, 8, 0.1);
    let fine = 0;
    for (let i = 0; i < 10; i += 1) {
      fine = damp(fine, 1, 8, 0.01);
    }
    expect(Math.abs(coarse - fine)).toBeLessThan(1e-3);
  });
});

describe("blinkEnvelope", () => {
  test("closes, holds and opens within one blink", () => {
    expect(blinkEnvelope(0)).toBe(0);
    expect(blinkEnvelope(1)).toBe(0);
    expect(blinkEnvelope(0.35)).toBe(1);
    expect(blinkEnvelope(0.15)).toBeGreaterThan(0);
    expect(blinkEnvelope(0.7)).toBeLessThan(1);
  });

  test("the blink state machine waits, closes then schedules again", () => {
    let now = 0;
    const blinker = new Blinker(
      () => now,
      () => 0.5,
    );
    expect(blinker.weight()).toBe(0);
    now = 2250;
    expect(blinker.weight()).toBeGreaterThan(0.9);
    now = 2600;
    expect(blinker.weight()).toBe(0);
    now = 3000;
    expect(blinker.weight()).toBe(0);
  });
});

describe("lookAngles", () => {
  test("turns the head toward the pointer", () => {
    expect(lookAngles(1, 0).yaw).toBeGreaterThan(0);
    expect(lookAngles(-1, 0).yaw).toBeLessThan(0);
    expect(lookAngles(0, 1).pitch).toBeLessThan(0);
    expect(lookAngles(0, -1).pitch).toBeGreaterThan(0);
  });
});

describe("idleAngles", () => {
  test("stays subtle and keeps breathing", () => {
    const samples = Array.from({ length: 200 }, (_, i) => idleAngles(i * 0.05));
    for (const sample of samples) {
      expect(Math.abs(sample.chestX)).toBeLessThan(0.03);
      expect(Math.abs(sample.hipsZ)).toBeLessThan(0.02);
      expect(Math.abs(sample.headX)).toBeLessThan(0.02);
    }
    const chest = samples.map((sample) => sample.chestX);
    expect(Math.max(...chest) - Math.min(...chest)).toBeGreaterThan(0.02);
  });
});

describe("walkOffsets", () => {
  test("is neutral when the walk weight is zero", () => {
    const still = walkOffsets(1.3, 0);
    for (const value of Object.values(still)) {
      expect(Math.abs(value)).toBe(0);
    }
  });

  test("swings the legs in opposite directions", () => {
    expect(walkOffsets(Math.PI / 2, 1).upperLegL).toBeGreaterThan(0);
    expect(walkOffsets(Math.PI / 2, 1).upperLegR).toBeLessThan(0);
  });

  test("only bends knees backwards and keeps them inside the cycle", () => {
    for (let phase = 0; phase < Math.PI * 4; phase += 0.1) {
      const step = walkOffsets(phase, 1);
      expect(step.lowerLegL).toBeLessThanOrEqual(0);
      expect(step.lowerLegR).toBeLessThanOrEqual(0);
      expect(Math.abs(step.upperLegL)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(step.bob)).toBeLessThanOrEqual(0.018);
    }
  });

  test("scales linearly with the walk weight", () => {
    const half = walkOffsets(0.7, 0.5);
    const full = walkOffsets(0.7, 1);
    expect(half.upperLegL * 2).toBeCloseTo(full.upperLegL, 10);
    expect(half.bob * 2).toBeCloseTo(full.bob, 10);
  });

  test("bobs twice per stride cycle", () => {
    expect(walkOffsets(0, 0.4).bob).toBeCloseTo(
      walkOffsets(Math.PI, 0.4).bob,
      10,
    );
  });
});
