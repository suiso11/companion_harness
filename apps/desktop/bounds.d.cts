export interface PetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function pickBounds(
  saved: unknown,
  workAreas: ReadonlyArray<PetWorkArea>,
): Partial<PetBounds>;
