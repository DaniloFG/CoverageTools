/**
 * Minimal glob matching (no dependency): `**` spans any number of path segments, `*` and `?` stay
 * within one segment, `{a,b}` matches either alternative. Paths are compared with forward slashes.
 */

const SPECIAL = /[.+^$()|[\]\\]/;

/** Index of the `}` closing the `{` at `open`, or -1 when it is not closed. */
function closingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth++;
    else if (glob[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Splits the inside of a brace group at its top-level commas. */
function alternatives(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '{') depth++;
    else if (inner[i] === '}') depth--;
    else if (inner[i] === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out;
}

function translate(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      let j = i + 1;
      while (glob[j] === '*') j++;
      const segmentStart = i === 0 || glob[i - 1] === '/';
      const segmentEnd = j === glob.length || glob[j] === '/';
      if (j - i > 1 && segmentStart && segmentEnd) {
        if (j < glob.length) {
          out += '(?:[^/]*/)*'; // `**/`: zero or more directories
          i = j; // the slash is consumed
        } else if (out.endsWith('/')) {
          out = `${out.slice(0, -1)}(?:/.*)?`; // trailing `/**`: the directory and everything below it
          i = j - 1;
        } else {
          out += '.*';
          i = j - 1;
        }
      } else {
        out += '[^/]*';
        i = j - 1;
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{' && closingBrace(glob, i) > 0) {
      const close = closingBrace(glob, i);
      out += `(?:${alternatives(glob.slice(i + 1, close)).map(translate).join('|')})`;
      i = close;
    } else {
      out += SPECIAL.test(c) || c === '{' || c === '}' ? `\\${c}` : c;
    }
  }
  return out;
}

/** Compiled globs by their forward-slash spelling: the hot paths (file events, discovery) ask for the same few again and again. */
const compiled = new Map<string, RegExp>();
/** Bounds the memo; user settings hold a handful of globs, so this is only reached by unusual input. */
const MAX_COMPILED = 512;

/**
 * The expression a glob stands for, compiled once per spelling. The expression has no `g` or `y`
 * flag, so `test` keeps no state and one instance can be shared.
 */
export function globToRegExp(glob: string): RegExp {
  const key = glob.replace(/\\/g, '/');
  let re = compiled.get(key);
  if (re === undefined) {
    if (compiled.size >= MAX_COMPILED) compiled.clear();
    compiled.set(key, (re = new RegExp(`^${translate(key)}$`)));
  }
  return re;
}

/** How many globs are compiled and kept (for tests). */
export function globCacheSize(): number {
  return compiled.size;
}

/** Whether `path` (either separator) matches one of `globs`. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  const normalized = path.replace(/\\/g, '/');
  return globs.some(g => globToRegExp(g).test(normalized));
}

/** The plain globs a glob with brace groups stands for (nested groups included), in order. */
export function expandBraces(glob: string): string[] {
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] !== '{') continue;
    const close = closingBrace(glob, i);
    if (close < 0) return [glob];
    const head = glob.slice(0, i);
    const tails = expandBraces(glob.slice(close + 1));
    return alternatives(glob.slice(i + 1, close)).flatMap(alt => expandBraces(alt).flatMap(a => tails.map(t => head + a + t)));
  }
  return [glob];
}

/**
 * `globs` as one glob with at most one brace group (VS Code's glob matcher does not nest them);
 * undefined for no globs.
 */
export function oneGlob(globs: readonly string[]): string | undefined {
  const flat = [...new Set(globs.flatMap(expandBraces))];
  if (flat.length === 0) return undefined;
  return flat.length === 1 ? flat[0] : `{${flat.join(',')}}`;
}
