import { randomUUID } from "node:crypto";

export type EntityId = string;

// Match anything that is not a Unicode letter or digit. Using \p{L}\p{N} keeps
// Cyrillic / CJK / Greek nicknames intact instead of collapsing them to a
// single "-" — without this fix, a player named "Игорь" produces an empty
// slug and createStableEntityId throws, silently breaking detection.
const NON_SLUG_CHARS = /[^\p{L}\p{N}]+/gu;

export function createEntityId(prefix: string, entropy = randomUUID()): EntityId {
  const safePrefix = slugify(prefix);

  if (!safePrefix) {
    throw new Error("Entity id prefix must contain at least one alphanumeric character.");
  }

  return `${safePrefix}_${entropy}`;
}

export function createStableEntityId(prefix: string, value: string): EntityId {
  const safePrefix = slugify(prefix);
  const safeValue = slugify(value);

  if (!safePrefix || !safeValue) {
    throw new Error("Stable entity id requires non-empty prefix and value.");
  }

  return `${safePrefix}_${safeValue}`;
}

export function slugify(value: string): string {
  return value.trim().toLowerCase().replace(NON_SLUG_CHARS, "-").replace(/^-|-$/g, "");
}
