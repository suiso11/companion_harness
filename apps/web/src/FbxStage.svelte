<script lang="ts">
// FBX stage (lazy chunk: three.js loads only when an FBX model is set up).
//
// A BOOTH/VRChat package ships the raw FBX plus textures. The FBX carries
// VRChat viseme blendshapes (`vrc.v_aa` …) and eyelid blendshapes
// (`b_blink`), so lip sync and blinking work without a VRM conversion.
// Textures are not embedded: the optional `textures.json` in the avatar
// directory maps material name → file name, served same-origin.

import { onMount } from "svelte";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import {
  type AvatarRig,
  Blinker,
  capturePose,
  chainHead,
  damp,
  idleAngles,
  lookAngles,
  poseAngles,
  relaxArms,
  type WalkBones,
  walkOffsets,
} from "./lib/avatar_motion.js";

let {
  url,
  texturesUrl = null,
  version = "",
  level = 0,
  x = 0.5,
  facing = 1,
  walk = 0,
  walkPhase = 0,
  mode = "idle",
  rest = 0,
}: {
  url: string;
  texturesUrl?: string | null;
  version?: string;
  level?: number;
  /** Normalized screen position (0 = left, 1 = right). */
  x?: number;
  facing?: -1 | 1;
  /** Walk intensity 0..1 (fades the cycle in and out). */
  walk?: number;
  /** Walk-cycle phase in radians, driven by the distance travelled. */
  walkPhase?: number;
  /** Behavior mode; "walk" keeps the profile while moving. */
  mode?: "idle" | "walk" | "rest" | "interact";
  /** Rest intensity 0..1 (drooping head/chest, heavy lids). */
  rest?: number;
} = $props();

/**
 * The avatar package's lilToon material modes, keyed by material name:
 * `blend` = _SrcBlend 1 / _DstBlend 10 with no cutout, `doubleSide` = _Cull 0,
 * `hidden` = a textureless additive layer. Everything else is cutout 0.5.
 */
const MATERIAL_MODES: Readonly<
  Record<
    string,
    Readonly<{ blend?: boolean; doubleSide?: boolean; hidden?: boolean }>
  >
> = {
  body: { blend: true },
  body_option: { blend: true, doubleSide: true },
  body_b: {},
  hair: { doubleSide: true },
  hair_op: { hidden: true },
  cloth: { doubleSide: true },
  cloth2: { blend: true, doubleSide: true },
  chain: { blend: true, doubleSide: true },
  under: { blend: true, doubleSide: true },
  tail: {},
};

let host: HTMLDivElement;
let failed = $state(false);
let loading = $state(true);

/** Semantic bones from the VRChat-style FBX rig (chain heads only). */
function buildRig(root: THREE.Object3D): AvatarRig | null {
  const hips = chainHead(root, "Hips");
  const chest = chainHead(root, "Chest");
  const head = chainHead(root, "Head");
  const upperArmL = chainHead(root, "Upperarm_L");
  const upperArmR = chainHead(root, "Upperarm_R");
  const lowerArmL = chainHead(root, "Lowerarm_L");
  const lowerArmR = chainHead(root, "Lowerarm_R");
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
      // Let the loading notice paint before the (synchronous, ~9s for a
      // 17MB FBX) parse blocks the main thread.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const loader = new FBXLoader();
      const group = await loader.loadAsync(url);
      if (disposed) {
        return;
      }

      if (texturesUrl !== null) {
        try {
          const response = await fetch(texturesUrl, {
            credentials: "same-origin",
          });
          const mapping = (await response.json()) as Record<string, string>;
          const textureLoader = new THREE.TextureLoader();
          const textures = new Map<string, THREE.Texture>();
          group.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) {
              return;
            }
            const materials = Array.isArray(object.material)
              ? object.material
              : [object.material];
            for (const material of materials) {
              if (!(material instanceof THREE.MeshPhongMaterial)) {
                continue;
              }
              const file = mapping[material.name];
              if (typeof file !== "string") {
                continue;
              }
              let texture = textures.get(file);
              if (texture === undefined) {
                texture = textureLoader.load(
                  version === ""
                    ? `/avatar/${file}`
                    : `/avatar/${file}?v=${version}`,
                );
                // Albedo atlases are sRGB; without this three reads them as
                // linear and the whole model renders washed out. The FBX UVs
                // already match three's default V direction: flipping them
                // moves the eyes and mouth to the wrong atlas tiles.
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.flipY = true;
                textures.set(file, texture);
              }
              material.map = texture;
              material.color.set(0xffffff);
              const mode = MATERIAL_MODES[material.name] ?? {};
              material.alphaTest = mode.blend === true ? 0 : 0.5;
              material.transparent = mode.blend === true;
              material.side =
                mode.doubleSide === true ? THREE.DoubleSide : THREE.FrontSide;
              material.visible = mode.hidden !== true;
              material.needsUpdate = true;
            }
          });
        } catch {
          // A missing mapping keeps the untextured materials; the model still
          // renders, so this is never fatal.
        }
      }

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
      });
      // Transparent clear: the pet window shows the desktop around the model.
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setSize(host.clientWidth, Math.max(host.clientHeight, 240));
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 1.4));
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(1, 2, 2);
      scene.add(key);

      const box = new THREE.Box3().setFromObject(group);
      const height = Math.max(box.max.y - box.min.y, 0.5);
      const centerY = (box.max.y + box.min.y) / 2;
      // Locomotion moves/turns this wrapper, never the rig's own root.
      const avatarRoot = new THREE.Group();
      avatarRoot.add(group);
      scene.add(avatarRoot);

      const camera = new THREE.PerspectiveCamera(
        30,
        host.clientWidth / Math.max(host.clientHeight, 240),
        0.1,
        20,
      );
      camera.position.set(0, centerY + height * 0.03, height * 2.05);
      camera.lookAt(0, centerY + height * 0.02, 0);

      // Relax the T-pose arms, then capture the bones the idle/gaze loop
      // drives. Posing the chain head moves every FBXLoader bone clone.
      const rig = buildRig(group);
      if (rig !== null) {
        relaxArms(rig);
      }
      const hipsPose = rig === null ? null : capturePose(rig.hips);
      const chestPose =
        rig === null || rig.chest === null ? null : capturePose(rig.chest);
      const headPose = rig === null ? null : capturePose(rig.head);
      // Walk cycle: resolved separately so a rig without legs still idles.
      const walkBones: WalkBones | null = (() => {
        const upperLegL = chainHead(group, "Upperleg_L");
        const upperLegR = chainHead(group, "Upperleg_R");
        const lowerLegL = chainHead(group, "Lowerleg_L");
        const lowerLegR = chainHead(group, "Lowerleg_R");
        if (
          upperLegL === null ||
          upperLegR === null ||
          lowerLegL === null ||
          lowerLegR === null ||
          rig === null
        ) {
          return null;
        }
        return {
          upperLegL,
          upperLegR,
          lowerLegL,
          lowerLegR,
          footL: chainHead(group, "Foot_L"),
          footR: chainHead(group, "Foot_R"),
          upperArmL: rig.upperArmL,
          upperArmR: rig.upperArmR,
        };
      })();
      const walkPoses =
        walkBones === null
          ? null
          : {
              upperLegL: capturePose(walkBones.upperLegL),
              upperLegR: capturePose(walkBones.upperLegR),
              lowerLegL: capturePose(walkBones.lowerLegL),
              lowerLegR: capturePose(walkBones.lowerLegR),
              footL:
                walkBones.footL === null ? null : capturePose(walkBones.footL),
              footR:
                walkBones.footR === null ? null : capturePose(walkBones.footR),
              armL: capturePose(walkBones.upperArmL),
              armR: capturePose(walkBones.upperArmR),
            };
      // Horizontal travel range at the model plane: the visible width minus
      // the body so the model (and tail) never clip at the margins.
      const visibleHeight =
        2 * (height * 2.05) * Math.tan((camera.fov * Math.PI) / 360);
      const avatarWidth = Math.max(box.max.x - box.min.x, height * 0.2);
      const spanFor = (aspect: number): number =>
        Math.max(visibleHeight * aspect - avatarWidth, visibleHeight * 0.15);
      let walkSpan = spanFor(camera.aspect);

      // Viseme + blink channels (VRChat naming). Missing channels are skipped.
      const visemes: Array<{ mesh: THREE.Mesh; index: number }> = [];
      const blinks: Array<{ mesh: THREE.Mesh; index: number }> = [];
      group.traverse((object) => {
        if (
          !(object instanceof THREE.Mesh) ||
          object.morphTargetDictionary === undefined
        ) {
          return;
        }
        const dictionary = object.morphTargetDictionary;
        const aa = dictionary["vrc.v_aa"];
        if (aa !== undefined) {
          visemes.push({ mesh: object, index: aa });
        }
        // One lid channel only: b_blink already drives both eyes on most
        // rigs, and adding the L/R pair would double the weight.
        const blink = dictionary.b_blink;
        if (blink !== undefined) {
          blinks.push({ mesh: object, index: blink });
        } else {
          for (const name of ["b_blink_L", "b_blink_R"] as const) {
            const lid = dictionary[name];
            if (lid !== undefined) {
              blinks.push({ mesh: object, index: lid });
            }
          }
        }
      });

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

      const blinker = new Blinker(() => performance.now());
      const clock = new THREE.Clock();
      let opened = 0;
      let raf = 0;
      let heading = 0;
      let restAmount = 0;
      const frame = (): void => {
        if (disposed) {
          return;
        }
        const dt = Math.min(clock.getDelta(), 0.1);
        const t = clock.elapsedTime;
        const idle = idleAngles(t);
        const amount = Math.min(Math.max(walk, 0), 1);
        const step = walkOffsets(walkPhase, amount);
        restAmount = damp(restAmount, Math.min(Math.max(rest, 0), 1), 3, dt);
        look.yaw = damp(look.yaw, look.targetYaw, 6, dt);
        look.pitch = damp(look.pitch, look.targetPitch, 6, dt);
        opened = damp(opened, Math.min(Math.max(level, 0), 1), 20, dt);
        if (hipsPose !== null) {
          poseAngles(hipsPose, 0.05 * amount, 0, idle.hipsZ);
        }
        if (chestPose !== null) {
          poseAngles(
            chestPose,
            idle.chestX * (1 - 0.5 * restAmount) + 0.06 * restAmount,
            0,
            -idle.hipsZ * 0.5,
          );
        }
        if (headPose !== null) {
          poseAngles(
            headPose,
            idle.headX + look.pitch + 0.24 * restAmount,
            idle.headY + look.yaw,
            0,
          );
        }
        if (walkPoses !== null) {
          poseAngles(walkPoses.upperLegL, step.upperLegL, 0, 0);
          poseAngles(walkPoses.upperLegR, step.upperLegR, 0, 0);
          poseAngles(walkPoses.lowerLegL, step.lowerLegL, 0, 0);
          poseAngles(walkPoses.lowerLegR, step.lowerLegR, 0, 0);
          if (walkPoses.footL !== null) {
            poseAngles(walkPoses.footL, step.footL, 0, 0);
          }
          if (walkPoses.footR !== null) {
            poseAngles(walkPoses.footR, step.footR, 0, 0);
          }
          poseAngles(walkPoses.armL, step.armL, 0, 0);
          poseAngles(walkPoses.armR, step.armR, 0, 0);
        }
        // Locomotion: the wrapper carries horizontal travel and the turn.
        avatarRoot.position.x = (Math.min(Math.max(x, 0), 1) - 0.5) * walkSpan;
        avatarRoot.position.y = step.bob * height;
        // Profile only while the brain is walking; idle/rest/interact face
        // the viewer. Driving this from speed would snap mid-stride.
        const headingTarget = mode === "walk" ? (facing * Math.PI) / 2 : 0;
        const headingDelta = Math.atan2(
          Math.sin(headingTarget - heading),
          Math.cos(headingTarget - heading),
        );
        heading += headingDelta * (1 - Math.exp(-8 * dt));
        avatarRoot.rotation.y = heading;
        for (const { mesh, index } of visemes) {
          const influences = mesh.morphTargetInfluences;
          if (influences !== undefined) {
            influences[index] = opened;
          }
        }
        // Resting eyes stay half shut even between blinks.
        const closed = Math.max(blinker.weight(), 0.45 * restAmount);
        for (const { mesh, index } of blinks) {
          const influences = mesh.morphTargetInfluences;
          if (influences !== undefined) {
            influences[index] = closed;
          }
        }
        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
      };
      loading = false;
      frame();

      const resize = (): void => {
        const width = host.clientWidth;
        const heightPx = Math.max(host.clientHeight, 240);
        renderer.setSize(width, heightPx);
        camera.aspect = width / heightPx;
        camera.updateProjectionMatrix();
        walkSpan = spanFor(camera.aspect);
      };
      window.addEventListener("resize", resize);

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", resize);
        renderer.dispose();
        host.removeChild(renderer.domElement);
      };
    } catch (error) {
      console.error("fbx stage failed", error);
      loading = false;
      failed = true;
    }
  })();

  return () => {
    disposed = true;
    cleanup();
  };
});
</script>

<div class="fbx" bind:this={host} data-fbx-stage="true"></div>
{#if loading}
  <p class="notice" data-fbx-loading="true">
    3Dモデルを読み込み中…（初回は数秒かかります）
  </p>
{/if}
{#if failed}
  <p class="notice">3Dモデルを読み込めませんでした（ファイルの配置を確認してください）</p>
{/if}

<style>
  .fbx {
    width: min(420px, 80vw);
    height: min(520px, 60vh);
  }
  .notice {
    color: var(--muted, #666);
    font-size: 0.9em;
  }
</style>
