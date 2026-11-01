// Character page acceptance: /character renders the avatar, speaks a draft
// through POST /api/speech (the audio track's contract), and does so under
// the strict production CSP with no inline styles.
//
// /api/speech is mocked here because the audio track is a parallel effort;
// everything else (routing, shell, CSP, Web Audio) is real.

import { expect, test } from "@playwright/test";

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

  await page.goto("/character");
  await expect(page.locator("[data-character-avatar]")).toBeVisible();
  await expect(page.locator("[data-character-panel]")).toBeVisible();

  await page.getByPlaceholder("試聴する文").fill("テストです");
  await page.getByRole("button", { name: "試聴", exact: true }).click();

  await expect(
    page.locator("[data-character-panel] .stage"),
  ).toHaveAttribute("data-speaking", "true", { timeout: 10_000 });
  await expect(page.locator("[data-character-status]")).toContainText(
    "話しています",
  );
  expect(speechCalls).toBe(1);

  expect(cspViolations).toEqual([]);
});
