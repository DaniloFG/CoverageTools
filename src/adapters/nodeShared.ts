import path from 'node:path';
import type { FsReader, Project } from './types';

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

/**
 * Splits a script line into words, honoring quotes; undefined when it is more than one plain command:
 * chained (`&&`, `||`, `;`, `|`), run in the background (`&`) or redirected (`>`, `<`).
 */
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
    } else if (c === ';' || c === '|' || c === '&' || c === '>' || c === '<') {
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
export function toolName(word: string): string {
  const parts = word.split(/[\\/]/);
  const nm = parts.lastIndexOf('node_modules');
  if (nm >= 0 && nm + 1 < parts.length && parts[nm + 1] !== '.bin') {
    const pkg = parts[nm + 1].startsWith('@') ? parts[nm + 2] : parts[nm + 1];
    if (pkg !== undefined) return pkg;
  }
  return parts[parts.length - 1].replace(/\.(?:c?m?js|cmd|exe)$/i, '');
}

type Parsed =
  /** `line`: the tool name and its arguments; `bin`: the command word as written. */
  | { kind: 'tool'; line: string; bin: string }
  /**
   * Another script of the package. `forwards`: arguments appended to this line reach the target script
   * (yarn and pnpm always forward them; npm only after `--`). `args`: the arguments the line passes on.
   * `env`: the `VAR=value` assignments in front of the command.
   */
  | { kind: 'script'; name: string; forwards: boolean; args: string[]; env: Record<string, string> };

/** What follows `npm run <name>`: forwarded when there is a `--`, else only npm's own options are allowed. */
function npmRedirection(name: string | undefined, rest: string[], env: Record<string, string>): Parsed | undefined {
  if (name === undefined) return undefined;
  const dashes = rest.indexOf('--');
  if (dashes >= 0) return { kind: 'script', name, forwards: true, args: rest.slice(dashes + 1), env };
  // Words that are not npm options would be passed on positionally and lost when the target is run directly.
  if (rest.some(w => !w.startsWith('-'))) return undefined;
  return { kind: 'script', name, forwards: false, args: [], env };
}

/**
 * What a script line runs: either another script of the package (`npm run x`, `yarn x`, `pnpm x`...)
 * or a command, given as its tool name and arguments with env-var prefixes and wrappers removed.
 */
function parseLine(line: string, scripts: Record<string, string>): Parsed | undefined {
  const words = tokenize(line);
  if (words === undefined) return undefined;
  const env: Record<string, string> = {};
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return undefined;
    if (ENV_ASSIGNMENT.test(w)) {
      const eq = w.indexOf('=');
      env[w.slice(0, eq)] = w.slice(eq + 1);
      i++;
    } else if (w === 'env' || w === 'cross-env') {
      i++;
    } else if (w === 'npx' || w === 'pnpx') {
      i++;
      while (words[i]?.startsWith('-')) i++;
    } else if ((w === 'yarn' || w === 'pnpm' || w === 'npm') && words[i + 1] === 'exec') {
      i += 2;
      while (words[i]?.startsWith('-')) i++;
      if (words[i] === '--') i++;
    } else if (w === 'npm' && (words[i + 1] === 'run' || words[i + 1] === 'run-script')) {
      let j = i + 2;
      while (words[j]?.startsWith('-') && words[j] !== '--') j++; // npm's own options
      return npmRedirection(words[j], words.slice(j + 1), env);
    } else if ((w === 'yarn' || w === 'pnpm') && words[i + 1] === 'run') {
      const name = words[i + 2];
      return name === undefined ? undefined : { kind: 'script', name, forwards: true, args: words.slice(i + 3), env };
    } else if ((w === 'yarn' || w === 'pnpm') && words[i + 1] !== undefined && !words[i + 1].startsWith('-')) {
      // `yarn x` runs the script x when there is one, and the binary x otherwise.
      if (Object.hasOwn(scripts, words[i + 1])) {
        return { kind: 'script', name: words[i + 1], forwards: true, args: words.slice(i + 2), env };
      }
      i++;
    } else if (toolName(w) === 'node' && words[i + 1] !== undefined) {
      i++;
      while (words[i]?.startsWith('-')) {
        const option = words[i];
        i += NODE_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
      }
    } else {
      return { kind: 'tool', line: [toolName(w), ...words.slice(i + 1)].join(' '), bin: w };
    }
  }
}

/** The script to run and the env it needs; see `scriptTailCalls`. */
export interface ScriptCall {
  script: string;
  env: Record<string, string>;
}

/**
 * How to run the `test` script so that arguments appended to it reach `tool` as its whole command.
 * `tool` is matched against the command with env-var prefixes, wrappers (`npx`, `yarn`, `pnpm exec`,
 * `node <flags>`) and the binary's directory removed, e.g. `jest --ci`. One redirection is followed:
 * when it forwards appended arguments (`yarn x`, `pnpm run x`, `npm run x -- --ci`) the `test` script
 * itself is run, keeping its env and arguments; a bare `npm run x` would take appended options for npm,
 * so `x` is run with the `VAR=value` assignments of the `test` line in `env`. Undefined when a line
 * chains several commands, runs something else, or the command matches `watch` (it would never end).
 */
export function scriptTailCalls(pkg: PackageJson, tool: RegExp, watch?: RegExp): ScriptCall | undefined {
  const scripts = pkg.scripts ?? {};
  const lineOf = (name: string): string | undefined => {
    const line = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
    return typeof line === 'string' ? line : undefined;
  };
  const usable = (toolLine: string): boolean => tool.test(toolLine) && !(watch?.test(toolLine) ?? false);

  const testLine = lineOf('test');
  if (testLine === undefined) return undefined;
  const outer = parseLine(testLine, scripts);
  if (outer === undefined) return undefined;
  if (outer.kind === 'tool') return usable(outer.line) ? { script: 'test', env: {} } : undefined;

  const targetLine = lineOf(outer.name);
  const inner = targetLine === undefined ? undefined : parseLine(targetLine, scripts);
  if (inner?.kind !== 'tool') return undefined;
  if (!usable([inner.line, ...outer.args].join(' '))) return undefined;
  return outer.forwards ? { script: 'test', env: {} } : { script: outer.name, env: outer.env };
}

/** Splits a script line into its commands at `&&`, `||`, `;`, `|`, `&`, `>` and `<` outside quotes. */
function splitCommands(line: string): string[] {
  const commands: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const c of line) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (';|&<>'.includes(c)) {
      commands.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  commands.push(current);
  return commands.filter(command => command.trim() !== '');
}

/**
 * Whether any command of the `test` script, or of the script it redirects to (one level), runs one
 * of `tools` (e.g. nyc or c8). A command is matched by its tool name after env-var prefixes and
 * wrappers are removed; a path only counts when it points into node_modules, so `my-nyc-thing` or
 * `node scripts/c8.js` do not.
 */
export function scriptInvokes(pkg: PackageJson, tools: readonly string[]): boolean {
  const scripts = pkg.scripts ?? {};
  const commandsOf = (name: string): Parsed[] => {
    const line = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
    if (typeof line !== 'string') return [];
    return splitCommands(line).flatMap(command => parseLine(command, scripts) ?? []);
  };
  const runsTool = (parsed: Parsed): boolean => {
    if (parsed.kind !== 'tool') return false;
    const name = toolName(parsed.bin);
    return tools.includes(name) && (parsed.bin === name || parsed.bin.split(/[\\/]/).includes('node_modules'));
  };
  return commandsOf('test').some(parsed => runsTool(parsed) || (parsed.kind === 'script' && commandsOf(parsed.name).some(runsTool)));
}

/**
 * The words of every command the `test` script runs (split at `&&`, `||`, `;`, `|`, `&`, `>`, `<`), and of
 * the script it redirects to (one level), with the arguments the redirection forwards appended to each
 * of the target's commands. For flag checks such as watch mode.
 */
export function scriptCommandWords(pkg: PackageJson): string[][] {
  const scripts = pkg.scripts ?? {};
  const commandsOf = (name: string): string[] => {
    const line = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
    return typeof line === 'string' ? splitCommands(line) : [];
  };
  const out: string[][] = [];
  for (const command of commandsOf('test')) {
    const words = tokenize(command);
    if (words === undefined) continue;
    out.push(words);
    const parsed = parseLine(command, scripts);
    if (parsed?.kind !== 'script') continue;
    for (const inner of commandsOf(parsed.name)) {
      const innerWords = tokenize(inner);
      if (innerWords !== undefined) out.push([...innerWords, ...parsed.args]);
    }
  }
  return out;
}

/** The workspace folder discovery recorded on the project (`meta.workspaceFolder`), if any. */
export function workspaceFolderOf(project: Project): string | undefined {
  const folder = project.meta.workspaceFolder;
  return typeof folder === 'string' ? folder : undefined;
}

/**
 * The test files a partial run selects, sorted and without duplicates: each path that is a test file,
 * and the test files under each path that is a directory, skipping `exclude` (globs relative to it).
 * `isTestFile` gets the path relative to `dir` with forward slashes.
 */
export async function selectedTestFiles(
  dir: string, paths: readonly string[], fs: FsReader, exclude: readonly string[], isTestFile: (rel: string) => boolean,
): Promise<string[]> {
  const selected = new Set<string>();
  const accept = (p: string): void => {
    const rel = relativePosix(dir, p);
    if (!rel.startsWith('../') && !path.isAbsolute(rel) && !rel.split('/').includes('node_modules') && isTestFile(rel)) {
      selected.add(p);
    }
  };
  for (const p of paths) {
    const under = await fs.find(p, ['**/*'], exclude);
    if (under.length > 0) under.forEach(accept);
    else accept(p);
  }
  return [...selected].sort();
}

/** Shown when a partial run selects no test file. */
export const NO_TEST_FILES_HINT = 'No test files were found in the selected folder.';

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
