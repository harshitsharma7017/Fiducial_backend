/** Escapes user text for a $regex, so it is matched literally and cannot form a costly pattern. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A key for sorting and duplicate checks: lower case, with runs of spaces made single. */
export function sortKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
