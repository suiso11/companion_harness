<script lang="ts">
// Desktop pet surface: the avatar alone on a transparent page, served at
// `/pet` and loaded by apps/desktop. It has no chrome, so it can be dragged
// by the window manager (`-webkit-app-region: drag` in app.css) and speaks
// new answers automatically.
import { onMount } from "svelte";
import CharacterPanel from "./CharacterPanel.svelte";

onMount(() => {
  document.documentElement.dataset.pet = "1";
  return () => {
    delete document.documentElement.dataset.pet;
  };
});
</script>

<svelte:head>
  <title>ペット · Companion Harness</title>
</svelte:head>

<CharacterPanel pet={true} />
