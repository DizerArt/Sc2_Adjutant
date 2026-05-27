export function normalizeBattleTag(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /#\d{3,}$/.test(normalized) ? normalized : undefined;
}

export function normalizeBattleTagKey(value: string | undefined): string {
  return normalizeBattleTag(value)?.toLowerCase() ?? "";
}

export function battleTagsMatch(first: string | undefined, second: string | undefined): boolean {
  const firstKey = normalizeBattleTagKey(first);
  const secondKey = normalizeBattleTagKey(second);
  return Boolean(firstKey && secondKey && firstKey === secondKey);
}
