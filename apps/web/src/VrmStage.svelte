<script lang="ts">
// VRM stage (lazy chunk: three.js + @pixiv/three-vrm load only when a model
// is configured). The model is the user's own VRM served same-origin; the
// mouth follows the audio level passed by the panel, and the eyes blink on a
// simple timer. Any load failure flips to a visible notice, never a crash.

import { onMount } from "svelte";
import { VRMLoaderPlugin, type VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

let { url, level = 0 }: { url: string; level?: number } = $props();

let host: HTMLDivElement;
let failed = $state(false);

onMount(() => {
  let disposed = false;
  let cleanup: () => void = () => {};

  void (async () => {
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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
      camera.position.set(0, 1.3, 2.2);
      camera.lookAt(0, 1.25, 0);

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

      const clock = new THREE.Clock();
      let blinkAt = 0;
      let raf = 0;
      const frame = (): void => {
        if (disposed) {
          return;
        }
        const delta = clock.getDelta();
        vrm.update(delta);
        vrm.expressionManager?.setValue("aa", level);
        const now = performance.now();
        if (blinkAt === 0) {
          blinkAt = now + 2400;
        } else if (now > blinkAt) {
          vrm.expressionManager?.setValue("blink", 1);
          if (now > blinkAt + 120) {
            vrm.expressionManager?.setValue("blink", 0);
            blinkAt = now + 2400 + Math.random() * 2600;
          }
        }
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
