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

let {
  url,
  texturesUrl = null,
  level = 0,
}: { url: string; texturesUrl?: string | null; level?: number } = $props();

let host: HTMLDivElement;
let failed = $state(false);

onMount(() => {
  let disposed = false;
  let cleanup: () => void = () => {};

  void (async () => {
    try {
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
                texture = textureLoader.load(`/avatar/${file}`);
                textures.set(file, texture);
              }
              material.map = texture;
              material.color.set(0xffffff);
              material.transparent = file.includes("trans");
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
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
      scene.add(group);

      const camera = new THREE.PerspectiveCamera(
        30,
        host.clientWidth / Math.max(host.clientHeight, 240),
        0.1,
        20,
      );
      camera.position.set(0, centerY + height * 0.08, height * 1.55);
      camera.lookAt(0, centerY, 0);

      // Relax the T-pose: lower both upper arms so the model stands naturally.
      group.traverse((child) => {
        if (!(child instanceof THREE.Bone)) {
          return;
        }
        if (child.name === "Upperarm_L") {
          child.rotation.z += 1.05;
        } else if (child.name === "Upperarm_R") {
          child.rotation.z -= 1.05;
        }
      });

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
        for (const name of ["vrc.v_aa", "vrc.v_oh"]) {
          const index = dictionary[name];
          if (index !== undefined) {
            visemes.push({ mesh: object, index });
          }
        }
        const blink = dictionary["b_blink"];
        if (blink !== undefined) {
          blinks.push({ mesh: object, index: blink });
        }
      });

      let blinkAt = 0;
      let raf = 0;
      const frame = (): void => {
        if (disposed) {
          return;
        }
        const open = Math.min(Math.max(level, 0), 1);
        for (const { mesh, index } of visemes) {
          const influences = mesh.morphTargetInfluences;
          if (influences !== undefined) {
            influences[index] = open;
          }
        }
        const now = performance.now();
        if (blinkAt === 0) {
          blinkAt = now + 2400;
        } else if (now > blinkAt) {
          const closed = now > blinkAt + 120 ? 0 : 1;
          for (const { mesh, index } of blinks) {
            const influences = mesh.morphTargetInfluences;
            if (influences !== undefined) {
              influences[index] = closed;
            }
          }
          if (closed === 0) {
            blinkAt = now + 2400 + Math.random() * 2600;
          }
        }
        // FBX is not animated here; update world matrices for skinning.
        group.updateMatrixWorld(true);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
      };
      frame();

      const resize = (): void => {
        const width = host.clientWidth;
        const heightPx = Math.max(host.clientHeight, 240);
        renderer.setSize(width, heightPx);
        camera.aspect = width / heightPx;
        camera.updateProjectionMatrix();
      };
      window.addEventListener("resize", resize);

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", resize);
        renderer.dispose();
        host.removeChild(renderer.domElement);
      };
    } catch {
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
