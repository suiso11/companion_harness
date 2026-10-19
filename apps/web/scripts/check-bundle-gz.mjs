// V1 bundle guard (plan llama_webui_vendoring §6): the self-hosted Svelte
// bundle stays gz ≤ 120KB total (JS + CSS). Run after `pnpm build`:
//   pnpm --filter @companion/web budget
// V1 actuals: svelte-app.js 87.99KB raw / 29.44KB gz,
//             svelte-app.css 7.31KB raw / 2.04KB gz (total gz ≈ 31.7KB).
import { readFileSync } from "node:fs";
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
const files = ["svelte-app.js", "svelte-app.css"];

let total = 0;
for (const name of files) {
  const raw = readFileSync(join(dir, name));
  const gz = gzipSync(raw, { level: 9 }).length;
  total += gz;
  console.log(
    `${name}: ${(raw.length / 1024).toFixed(2)}KB raw / ${(gz / 1024).toFixed(2)}KB gz`,
  );
}
console.log(
  `total gz: ${(total / 1024).toFixed(2)}KB (budget ${BUDGET_GZ_KB}KB)`,
);
if (total > BUDGET_GZ_KB * 1024) {
  console.error("bundle budget exceeded");
  process.exit(1);
}
