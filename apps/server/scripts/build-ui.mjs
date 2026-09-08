// M3 client bundle build (plan §16.1, §16.7).
//
// Bundles the vanilla TypeScript client (`src/ui/client.ts`, DOM API only,
// no framework) with esbuild into `dist/assets/client.js` and copies the
// self-hosted stylesheet to `dist/assets/client.css`. The server serves both
// as static assets; the SSR shell references nothing else (strict CSP).

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..");
const outDir = join(serverDir, "dist", "assets");

async function main() {
  const { build } = await import("esbuild");
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(serverDir, "src", "ui", "client.ts")],
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: join(outDir, "client.js"),
    logLevel: "info",
  });
  copyFileSync(
    join(serverDir, "src", "ui", "client.css"),
    join(outDir, "client.css"),
  );
}

await main();
