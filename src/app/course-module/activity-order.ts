
const STORAGE_PREFIX = 'lms.activityOrder.';

/** "Ebook:12" / "Multimedia:5" - unique per row inside a section. */
export function activityOrderKey(kind: string, id: number): string {
  return `${kind}:${id}`;
}

/** The saved order of a section (empty = nothing was dragged yet, so the default order applies). */
export function readActivityOrder(sectionId: number): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + sectionId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function writeActivityOrder(sectionId: number, keys: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + sectionId, JSON.stringify(keys));
  } catch {
    // storage unavailable (private mode / quota): the order still applies until the page is reloaded
  }
}

/**
 * Sorts `items` (given in their default order) by the saved order.
 * Rows that are not in the saved order (added after the last drag) go after the known ones,
 * keeping their default order.
 */
export function applyActivityOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  saved: readonly string[],
): T[] {
  if (saved.length === 0) return [...items];
  const rank = new Map(saved.map((key, i) => [key, i] as const));
  return items
    .map((item, defaultIndex) => ({ item, position: rank.get(keyOf(item)) ?? 1e9 + defaultIndex }))
    .sort((a, b) => a.position - b.position)
    .map(entry => entry.item);
}