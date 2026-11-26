/**
 * The value of the `coverageTools.runnablePaths` context key, which the Explorer menu tests with
 * `resourcePath in coverageTools.runnablePaths`: each path spelled as VS Code spells `resourcePath`
 * (`normalize` is `p => vscode.Uri.file(p).fsPath`, which lower-cases a Windows drive letter).
 */
export function runnableContextValue(paths: Iterable<string>, normalize: (p: string) => string): Record<string, true> {
  const value: Record<string, true> = {};
  for (const p of paths) value[normalize(p)] = true;
  return value;
}

/** Sets the context key after each discovery, but only when the set of paths changed. */
export class RunnablePathsContext {
  private last: Record<string, true> | undefined;

  constructor(private readonly normalize: (p: string) => string, private readonly setContext: (value: Record<string, true>) => void) {}

  /** Returns whether the context key was set. */
  update(paths: Iterable<string>): boolean {
    const value = runnableContextValue(paths, this.normalize);
    if (this.last !== undefined && sameKeys(this.last, value)) return false;
    this.last = value;
    this.setContext(value);
    return true;
  }
}

function sameKeys(a: Record<string, true>, b: Record<string, true>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.prototype.hasOwnProperty.call(b, k));
}
