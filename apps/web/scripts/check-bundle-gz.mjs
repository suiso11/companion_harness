// V1 bundle guard (plan llama_webui_vendoring §6): the worst-case single
// route load (entry + css + one dynamic route chunk) stays gz ≤ 120KB. Run
// after `pnpm build`:
//   pnpm --filter @companion/web budget
// PR-5: the build also emits dynamic per-route chunks (`svelte-app-*.js`,
// e.g. svelte-app-ShadowPage.js). They MUST be counted, or the budget
// silently excludes part of the served payload. Every chunk is reported
// per-chunk gz, and each route's total (entry + css + that chunk — the
// browser loads exactly these for one route) is reported; the budget is
// enforced on the WORST route total.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const BUDGET_GZ_KB = 120;
const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "server",
  "dist",
  "svelte",
);

const fixedFiles = ["svelte-app.js", "svelte-app.css"];
// Dynamic route chunks: anything matching the server's `/assets/:chunk`
// route (`svelte-app-*.js`), so the budget mirrors what the server serves.
const chunkFiles = readdirSync(dir)
  .filter((name) => /^svelte-app-.+\.js$/.test(name))
  .sort();

const gzOf = (name) => gzipSync(readFileSync(join(dir, name)), { level: 9 });

const kb = (bytes) => (bytes / 1024).toFixed(2);

let entryGz = 0;
let cssGz = 0;
for (const name of [...fixedFiles, ...chunkFiles]) {
  const raw = readFileSync(join(dir, name));
  const gz = gzOf(name).length;
  if (name === "svelte-app.js") entryGz = gz;
  if (name === "svelte-app.css") cssGz = gz;
  console.log(
    `${name}: ${(raw.length / 1024).toFixed(2)}KB raw / ${(gz / 1024).toFixed(2)}KB gz`,
  );
}

// Per-route total: entry + css + that route's dynamic chunk (each route
// chunk is imported only by its own page module; the entry + css always
// load). The BUDGET is enforced per route — the browser never loads two
// route chunks at once, so the sum over chunks is not the served payload.
let worstRouteGz = entryGz + cssGz;
for (const name of chunkFiles) {
  const routeTotal = entryGz + cssGz + gzOf(name).length;
  worstRouteGz = Math.max(worstRouteGz, routeTotal);
  console.log(`route ${name}: entry + css + chunk = ${kb(routeTotal)}KB gz`);
}

console.log(
  `worst-route total gz: ${(worstRouteGz / 1024).toFixed(2)}KB (budget ${BUDGET_GZ_KB}KB)`,
);
if (worstRouteGz > BUDGET_GZ_KB * 1024) {
  console.error("bundle budget exceeded");
  process.exit(1);
}
