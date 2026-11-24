import path from 'node:path';
import type { FsReader } from './types';

/** The parts of a package.json the Node adapters read. */
export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export type PackageManager = 'yarn' | 'pnpm' | 'npm';

/** Default test file patterns of Jest and Vitest: files under `__tests__`, and `*.test.*` / `*.spec.*`. */
export const NODE_TEST_FILE = /(?:^|[\\/])__tests__[\\/](?:[^\\/]+[\\/])*[^\\/]+\.[mc]?[jt]sx?$|(?:^|[\\/.])(?:spec|test)\.[mc]?[jt]sx?$/;

const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ['yarn.lock', 'yarn'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
];

/**
 * The package manager of the nearest lockfile in `dir` or above it, up to `stopAt` (included) or the
 * file system root; npm when there is none.
 */
export async function packageManagerOf(dir: string, fs: FsReader, stopAt?: string): Promise<PackageManager> {
  const stop = stopAt === undefined ? undefined : path.resolve(stopAt);
  let current = path.resolve(dir);
  for (;;) {
    for (const [file, pm] of LOCKFILES) {
      if (await fs.exists(path.join(current, file))) return pm;
    }
    const parent = path.dirname(current);
    if (current === stop || parent === current) return 'npm';
    current = parent;
  }
}

/** Reads and parses a package.json; undefined when it is missing or not a JSON object. */
export async function readPackageJson(file: string, fs: FsReader): Promise<PackageJson | undefined> {
  const text = await fs.readText(file);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

/** Splits a script line into words, honoring quotes; undefined when it chains commands (`&&`, `||`, `;`, `|`). */
function tokenize(line: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else word = (word ?? '') + c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word = word ?? '';
    } else if (c === ';' || c === '|' || (c === '&' && line[i + 1] === '&')) {
      return undefined;
    } else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Node options that take their value as the next word. */
const NODE_OPTIONS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions']);

/** The tool name of a binary path: `node_modules/.bin/jest` → jest, `node_modules/jest/bin/jest.js` → jest. */
function toolName(word: string): string {
  const parts = word.split(/[\\/]/);
  const nm = parts.lastIndexOf('node_modules');
  if (nm >= 0 && nm + 1 < parts.length && parts[nm + 1] !== '.bin') {
    const pkg = parts[nm + 1].startsWith('@') ? parts[nm + 2] : parts[nm + 1];
    if (pkg !== undefined) return pkg;
  }
  return parts[parts.length - 1].replace(/\.(?:c?m?js|cmd|exe)$/i, '');
}

type Parsed = { kind: 'tool'; line: string } | { kind: 'script'; name: string };

/**
 * What a script line runs: either another script of the package (`npm run x`, `yarn x`, `pnpm x`...)
 * or a command, given as its tool name and arguments with env-var prefixes and wrappers removed.
 */
function parseLine(line: string, scripts: Record<string, string>): Parsed | undefined {
  const words = tokenize(line);
  if (words === undefined) return undefined;
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return undefined;
    if (ENV_ASSIGNMENT.test(w) || w === 'env' || w === 'cross-env') {
      i++;
    } else if (w === 'npx' || w === 'pnpx') {
      i++;
      while (words[i]?.startsWith('-')) i++;
    } else if ((w === 'yarn' || w === 'pnpm' || w === 'npm') && words[i + 1] === 'exec') {
      i += 2;
      while (words[i]?.startsWith('-')) i++;
      if (words[i] === '--') i++;
    } else if (w === 'npm' && (words[i + 1] === 'run' || words[i + 1] === 'run-script')) {
      const name = words[i + 2];
      return name === undefined ? undefined : { kind: 'script', name };
    } else if ((w === 'yarn' || w === 'pnpm') && words[i + 1] === 'run') {
      const name = words[i + 2];
      return name === undefined ? undefined : { kind: 'script', name };
    } else if ((w === 'yarn' || w === 'pnpm') && words[i + 1] !== undefined && !words[i + 1].startsWith('-')) {
      // `yarn x` runs the script x when there is one, and the binary x otherwise.
      if (Object.hasOwn(scripts, words[i + 1])) return { kind: 'script', name: words[i + 1] };
      i++;
    } else if (toolName(w) === 'node' && words[i + 1] !== undefined) {
      i++;
      while (words[i]?.startsWith('-')) {
        const option = words[i];
        i += NODE_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
      }
    } else {
      return { kind: 'tool', line: [toolName(w), ...words.slice(i + 1)].join(' ') };
    }
  }
}

/**
 * The name of the script that runs `tool` as its whole command: the `test` script, or the script it
 * redirects to (one level). `tool` is matched against the command with env-var prefixes, wrappers
 * (`npx`, `yarn`, `pnpm exec`, `node <flags>`) and the binary's directory removed, e.g. `jest --ci`.
 * Undefined when the line chains several commands or runs something else.
 */
export function scriptTailCalls(pkg: PackageJson, tool: RegExp): string | undefined {
  const scripts = pkg.scripts ?? {};
  let name = 'test';
  for (let depth = 0; depth < 2; depth++) {
    const line = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
    if (typeof line !== 'string') return undefined;
    const parsed = parseLine(line, scripts);
    if (parsed === undefined) return undefined;
    if (parsed.kind === 'tool') return tool.test(parsed.line) ? name : undefined;
    name = parsed.name;
  }
  return undefined;
}

/** Runs a package script with extra arguments: npm puts them after `--`, yarn and pnpm do not. */
export function scriptCommand(pm: PackageManager, script: string, extra: readonly string[]): { command: string; args: string[] } {
  if (pm === 'npm') return { command: 'npm', args: ['run', script, ...(extra.length > 0 ? ['--', ...extra] : [])] };
  return { command: pm, args: ['run', script, ...extra] };
}

/** Runs a binary installed in the project: `yarn <bin>`, `pnpm exec <bin>` or `npx --no-install <bin>`. */
export function localBin(pm: PackageManager, bin: string, extra: readonly string[]): { command: string; args: string[] } {
  if (pm === 'yarn') return { command: 'yarn', args: [bin, ...extra] };
  if (pm === 'pnpm') return { command: 'pnpm', args: ['exec', bin, ...extra] };
  return { command: 'npx', args: ['--no-install', bin, ...extra] };
}

/** `p` relative to `dir`, with forward slashes. */
export function relativePosix(dir: string, p: string): string {
  return path.relative(dir, p).split(path.sep).join('/');
}
