// Character page acceptance: /character renders the avatar, speaks a draft
// through POST /api/speech (the audio track's contract), and does so under
// the strict production CSP with no inline styles.
//
// /api/speech is mocked here because the audio track is a parallel effort;
// everything else (routing, shell, CSP, Web Audio) is real.

import { inflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { TEXT_OK } from "./ports.js";

/** Alpha plane of an 8-bit RGBA PNG (Playwright screenshot with omitBackground). */
function pngAlpha(png: Buffer): {
  readonly width: number;
  readonly height: number;
  readonly colorType: number;
  readonly alpha: (x: number, y: number) => number;
} {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") {
      width = png.readUInt32BE(offset + 8);
      height = png.readUInt32BE(offset + 12);
      colorType = png[offset + 17] as number;
    } else if (type === "IDAT") {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const row = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const here = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? (here[x - bpp] ?? 0) : 0;
      const up = prev === null ? 0 : (prev[x] ?? 0);
      const upLeft = prev === null || x < bpp ? 0 : (prev[x - bpp] ?? 0);
      let value = row[x] ?? 0;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      here[x] = value & 255;
    }
  }
  return {
    width,
    height,
    colorType,
    alpha: (x, y) =>
      bpp === 4 ? (out[y * stride + x * bpp + 3] as number) : 255,
  };
}

/** 0.4s 8kHz mono 16-bit sine wave. */
function wavTone(): Buffer {
  const sampleRate = 8000;
  const samples = 3200;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000,
    );
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  return buffer;
}

test("character page renders the avatar and speaks a draft", async ({
  page,
}) => {
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /content security policy/i.test(message.text())
    ) {
      cspViolations.push(message.text());
    }
  });

  let speechCalls = 0;
  await page.route("**/api/speech", async (route) => {
    speechCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: wavTone(),
    });
  });

  // No VRM is configured in the e2e harness: the server reports null and the
  // panel falls back to the SVG avatar.
  const config = await page.request.get("/api/character/config");
  expect(config.ok()).toBe(true);
  expect(await config.json()).toEqual({ version: 1, avatar: null });
  const model = await page.request.get("/avatar/model.vrm");
  expect(model.status()).toBe(404);

  await page.goto("/character");
  await expect(page.locator("[data-character-avatar]")).toBeVisible();
  await expect(page.locator("[data-character-panel]")).toBeVisible();

  await page.getByPlaceholder("試聴する文").fill("テストです");
  await page.getByRole("button", { name: "試聴", exact: true }).click();

  await expect(page.locator("[data-character-panel] .stage")).toHaveAttribute(
    "data-speaking",
    "true",
    { timeout: 10_000 },
  );
  await expect(page.locator("[data-character-status]")).toContainText(
    "話しています",
  );
  expect(speechCalls).toBe(1);

  expect(cspViolations).toEqual([]);
});

test("the pet page speaks the newest answer without page chrome", async ({
  page,
  request,
}) => {
  let speechCalls = 0;
  await page.route("**/api/speech", async (route) => {
    speechCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: wavTone(),
    });
  });

  await page.goto("/pet");
  const panel = page.locator("[data-character-panel]");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/pet/);
  // No controls, no status line: the window is the avatar.
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.locator("[data-character-status]")).toHaveCount(0);
  // The page is transparent so the desktop shows through around the avatar.
  expect(await page.getAttribute("html", "data-pet")).toBe("1");
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  // An answer that completes while the pet is open is voiced (an answer
  // from before the launch is not replayed).
  const created = await request.post("/api/sessions", {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: {},
  });
  expect(created.status()).toBe(201);
  const { sessionId } = (await created.json()) as { sessionId: string };
  const posted = await request.post(`/api/sessions/${sessionId}/messages`, {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: { text: TEXT_OK, uiContext: {} },
  });
  expect(posted.status()).toBe(202);
  await expect(panel.locator(".stage")).toHaveAttribute(
    "data-speaking",
    "true",
    { timeout: 20_000 },
  );
  expect(speechCalls).toBe(1);
});

test("the pet surface is transparent around the avatar", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 560 });
  await page.goto("/pet");
  await expect(page.locator("[data-character-panel]")).toBeVisible();
  const shot = pngAlpha(await page.screenshot({ omitBackground: true }));
  // RGBA (not flattened) and a transparent corner: the desktop shows through.
  expect(shot.colorType).toBe(6);
  expect(shot.width).toBe(360);
  expect(shot.alpha(0, 0)).toBe(0);
  expect(shot.alpha(shot.width - 1, 0)).toBe(0);
  // The avatar itself is opaque somewhere in the middle band.
  let opaque = 0;
  for (let y = 0; y < shot.height; y += 4) {
    for (let x = 0; x < shot.width; x += 4) {
      if (shot.alpha(x, y) === 255) {
        opaque += 1;
      }
    }
  }
  expect(opaque).toBeGreaterThan(50);
});

test("a configured but broken VRM fails gracefully", async ({ page }) => {
  await page.route("**/api/character/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        avatar: { kind: "vrm", url: "/avatar/model.vrm", texturesUrl: null },
      }),
    });
  });
  await page.route("**/avatar/model.vrm", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "model/gltf-binary",
      body: Buffer.from("not a vrm"),
    });
  });

  await page.goto("/character");
  // The 3D chunk loads and the loader fails; the panel keeps the notice and
  // the rest of the page usable instead of crashing.
  await expect(page.getByText("3Dモデルを読み込めませんでした")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByPlaceholder("試聴する文")).toBeVisible();
});

test("a configured but broken FBX fails gracefully", async ({ page }) => {
  await page.route("**/api/character/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        avatar: { kind: "fbx", url: "/avatar/model.fbx", texturesUrl: null },
      }),
    });
  });
  await page.route("**/avatar/model.fbx", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: Buffer.from("not an fbx"),
    });
  });

  await page.goto("/character");
  await expect(page.getByText("3Dモデルを読み込めませんでした")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByPlaceholder("試聴する文")).toBeVisible();
});
