import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// PR-1 Svelte chat shell (plan frontend_ui_requirements §11 Q1/Q8, §12 PR-1).
// Builds a single self-hosted bundle into the server's dist tree
// (`apps/server/dist/svelte/`); the Hono app serves it behind the existing
// strict CSP (no CDN, no inline script/style). Filenames are fixed so the
// server asset routes stay stable and auditable.
export default defineConfig({
  // The server serves the entry bundle at `/assets/svelte-app.js`; a matching
  // base keeps Vite's dynamic-chunk preload URLs (`/assets/...`) correct.
  base: "/assets/",
  plugins: [svelte()],
  build: {
    outDir: "../server/dist/svelte",
    emptyOutDir: true,
    target: "es2022",
    minify: true,
    sourcemap: false,
    assetsDir: ".",
    rollupOptions: {
      output: {
        entryFileNames: "svelte-app.js",
        chunkFileNames: "svelte-app-[name].js",
        assetFileNames: "svelte-app.[ext]",
      },
    },
  },
});
