/**
 * A coverage percentage rounded down to one decimal (so it never claims full coverage that is not
 * there), shown without the decimal when it is zero. A zero total reads `0%`.
 */
export function formatPercent(covered: number, total: number): string {
  if (total <= 0) return '0%';
  const tenths = Math.floor((covered * 1000) / total) / 10;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}%`;
}

/**
 * The location a store key stands for: `project:<file or dir>` → the file or directory;
 * `unowned:<results root>#<signature>` → the results root, without the signature.
 */
export function keyPath(key: string): string {
  const separator = key.indexOf(':');
  if (separator < 0) return key;
  const rest = key.slice(separator + 1);
  if (key.slice(0, separator) !== 'unowned') return rest;
  const hash = rest.indexOf('#');
  return hash < 0 ? rest : rest.slice(0, hash);
}
