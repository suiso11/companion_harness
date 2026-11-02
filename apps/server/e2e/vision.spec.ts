// Camera vision E2E: the character page grabs one camera frame, asks
// /api/vision for a description, posts it as a user turn, and speaks the
// companion's reply. /api/vision is mocked (the local model is opt-in); the
// browser's fake camera and the real conversation/auto-speak path are real.

import { expect, test } from "@playwright/test";
import { E2E_CONTROL_ORIGIN } from "./ports.js";

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
    buffer.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000),
      44 + i * 2,
    );
  }
  return buffer;
}

test.use({
  permissions: ["camera"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
});

test("one camera frame becomes an observation turn and is spoken", async ({
  page,
  request,
}) => {
  await request.post(`${E2E_CONTROL_ORIGIN}/reset`);
  let sawJpeg = false;
  await page.route("**/api/vision", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      imageBase64?: unknown;
    };
    sawJpeg =
      typeof body.imageBase64 === "string" &&
      body.imageBase64.startsWith("/9j/");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        text: "机の上に湯呑みがあります",
      }),
    });
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

  await page.goto("/character");
  await page.locator("label.toggle input").check();
  await page.getByRole("button", { name: "カメラで見る" }).click();

  // The frame reached the endpoint as JPEG, and the description is shown.
  await expect(page.locator("[data-character-status]")).toContainText(
    "机の上に湯呑みがあります",
    { timeout: 20_000 },
  );
  expect(sawJpeg).toBe(true);

  // The observation became a turn: the answer is auto-spoken.
  await expect(page.locator("[data-character-panel] .stage")).toHaveAttribute(
    "data-speaking",
    "true",
    { timeout: 30_000 },
  );
  expect(speechCalls).toBeGreaterThan(0);
});
