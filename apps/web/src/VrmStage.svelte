<script lang="ts">
// VRM stage (lazy chunk: three.js + @pixiv/three-vrm load only when a model
// is configured). The model is the user's own VRM served same-origin. The
// rest pose, idle motion and gaze come from lib/avatar_motion so the FBX and
// VRM stages look alive the same way; the mouth and eyes follow the audio
// level and a randomized blink timer. Any load failure flips to a visible
// notice, never a crash.

import { type VRM, VRMLoaderPlugin } from "@pixiv/three-vrm";
import { onMount } from "svelte";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  type AvatarRig,
  Blinker,
  capturePose,
  damp,
  idleAngles,
  lookAngles,
  type PoseBone,
  poseAngles,
  relaxArms,
} from "./lib/avatar_motion.js";

let { url, level = 0 }: { url: string; level?: number } = $props();

let host: HTMLDivElement;
let failed = $state(false);

/** Semantic bones from three-vrm's normalized humanoid rig. */
function buildRig(vrm: VRM): AvatarRig | null {
  const node = (
    name: Parameters<VRM["humanoid"]["getNormalizedBoneNode"]>[0],
  ) => vrm.humanoid.getNormalizedBoneNode(name);
  const hips = node("hips");
  const chest = node("chest");
  const head = node("head");
  const upperArmL = node("leftUpperArm");
  const upperArmR = node("rightUpperArm");
  const lowerArmL = node("leftLowerArm");
  const lowerArmR = node("rightLowerArm");
  if (
    hips === null ||
    head === null ||
    upperArmL === null ||
    upperArmR === null ||
    lowerArmL === null ||
    lowerArmR === null
  ) {
    return null;
  }
  return { hips, chest, head, upperArmL, upperArmR, lowerArmL, lowerArmR };
}

onMount(() => {
  let disposed = false;
  let cleanup: () => void = () => {};

  void (async () => {
    try {
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
      });
      // Transparent clear: the pet window shows the desktop around the model.
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(host.clientWidth, Math.max(host.clientHeight, 240));
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(
        30,
        host.clientWidth / Math.max(host.clientHeight, 240),
        0.1,
        20,
      );
      camera.position.set(0, 1.3, 3.2);
      camera.lookAt(0, 1.2, 0);
      scene.add(camera);

      scene.add(new THREE.AmbientLight(0xffffff, 1.2));
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(1, 2, 2);
      scene.add(key);

      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(url);
      if (disposed) {
        return;
      }
      const vrm = gltf.userData.vrm as VRM;
      // VRM 0.x models face away from the camera; three-vrm's rotateVRM0 is
      // exactly this (its type export is unavailable under NodeNext).
      if (vrm.meta?.metaVersion === "0") {
        vrm.scene.rotation.y = Math.PI;
      }
      scene.add(vrm.scene);

      // The eyes look at a point on the camera, so eye contact survives any
      // camera framing (Amica does the same with a camera-child target).
      const gazeTarget = new THREE.Object3D();
      camera.add(gazeTarget);
      if (vrm.lookAt !== undefined) {
        vrm.lookAt.target = gazeTarget;
      }

      const rig = buildRig(vrm);
      if (rig !== null) {
        relaxArms(rig);
      }
      const hipsPose: PoseBone | null =
        rig === null ? null : capturePose(rig.hips);
      const chestPose: PoseBone | null =
        rig === null || rig.chest === null ? null : capturePose(rig.chest);
      const headPose: PoseBone | null =
        rig === null ? null : capturePose(rig.head);

      // Gaze follows the pointer over the canvas; leaving recenters the head.
      const look = { yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0 };
      const onPointer = (event: PointerEvent): void => {
        const rect = renderer.domElement.getBoundingClientRect();
        const angle = lookAngles(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -(((event.clientY - rect.top) / rect.height) * 2 - 1),
        );
        look.targetYaw = angle.yaw;
        look.targetPitch = angle.pitch;
      };
      renderer.domElement.addEventListener("pointermove", onPointer);
      renderer.domElement.addEventListener("pointerleave", () => {
        look.targetYaw = 0;
        look.targetPitch = 0;
      });

      const expressions = vrm.expressionManager;
      const blinker = new Blinker(() => performance.now());
      const clock = new THREE.Clock();
      let opened = 0;
      let raf = 0;
      const frame = (): void => {
        if (disposed) {
          return;
        }
        const dt = Math.min(clock.getDelta(), 0.1);
        const idle = idleAngles(clock.elapsedTime);
        look.yaw = damp(look.yaw, look.targetYaw, 6, dt);
        look.pitch = damp(look.pitch, look.targetPitch, 6, dt);
        opened = damp(opened, Math.min(Math.max(level, 0), 1), 20, dt);
        if (hipsPose !== null) {
          poseAngles(hipsPose, 0, 0, idle.hipsZ);
        }
        if (chestPose !== null) {
          poseAngles(chestPose, idle.chestX, 0, -idle.hipsZ * 0.5);
        }
        if (headPose !== null) {
          poseAngles(
            headPose,
            idle.headX + look.pitch,
            idle.headY + look.yaw,
            0,
          );
        }
        expressions?.setValue("aa", opened);
        expressions?.setValue("blink", blinker.weight());
        vrm.update(dt);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
      };
      frame();

      const resize = (): void => {
        const width = host.clientWidth;
        const height = Math.max(host.clientHeight, 240);
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      window.addEventListener("resize", resize);

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", resize);
        renderer.dispose();
        host.removeChild(renderer.domElement);
      };
    } catch (error) {
      console.error("vrm stage failed", error);
      failed = true;
    }
  })();

  return () => {
    disposed = true;
    cleanup();
  };
});
</script>

<div class="vrm" bind:this={host} data-vrm-stage="true"></div>
{#if failed}
  <p class="notice">3Dモデルを読み込めませんでした（ファイルの配置を確認してください）</p>
{/if}

<style>
  .vrm {
    width: min(420px, 80vw);
    height: min(520px, 60vh);
  }
  .notice {
    color: var(--muted, #666);
    font-size: 0.9em;
  }
</style>
