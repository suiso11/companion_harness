// Window-bounds restore for the pet window. Pure so it can be tested without
// Electron: a saved rectangle is restored only when it is integral, big
// enough, and still overlaps a display work area (a monitor may be gone).
"use strict";

const KEYS = ["x", "y", "width", "height"];

/**
 * @param {unknown} saved parsed pet-window.json
 * @param {ReadonlyArray<{x: number, y: number, width: number, height: number}>} workAreas
 * @returns {Partial<{x: number, y: number, width: number, height: number}>}
 */
function pickBounds(saved, workAreas) {
  if (typeof saved !== "object" || saved === null) {
    return {};
  }
  if (!KEYS.every((key) => Number.isInteger(saved[key]))) {
    return {};
  }
  const { x, y, width, height } = saved;
  if (width < 100 || height < 100) {
    return {};
  }
  const visible = workAreas.some(
    (area) =>
      x < area.x + area.width &&
      x + width > area.x &&
      y < area.y + area.height &&
      y + height > area.y,
  );
  return visible ? { x, y, width, height } : {};
}

module.exports = { pickBounds };
