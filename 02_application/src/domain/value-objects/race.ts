export const RACES = ["Terran", "Zerg", "Protoss", "Random", "Unknown"] as const;

export type Race = (typeof RACES)[number];

const NORMALIZED_RACES: Record<string, Race> = {
  terran: "Terran",
  terr: "Terran",
  t: "Terran",
  zerg: "Zerg",
  z: "Zerg",
  protoss: "Protoss",
  prot: "Protoss",
  p: "Protoss",
  random: "Random",
  r: "Random"
};

export function normalizeRace(value: unknown): Race {
  if (typeof value !== "string") {
    return "Unknown";
  }

  return NORMALIZED_RACES[value.trim().toLowerCase()] ?? "Unknown";
}
