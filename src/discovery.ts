import path from 'node:path';
import { customProject } from './adapters/custom';
import { projectsInSolution } from './adapters/dotnetShared';
import type { Adapter, Ecosystem, FsReader, Project, RunTarget } from './adapters/types';
import { matchesAny } from './glob';
import type { Settings } from './settings';

/**
 * Test projects of the workspace folders and the Explorer paths on which "Run Coverage Here" is
 * offered. Pure: every file access goes through the `FsReader`.
 */
export interface DiscoveryState {
  /** The workspace folders searched, as given. */
  folders: readonly string[];
  /** Per folder, sorted by directory. Each has `meta.workspaceFolder`. */
  projects: readonly Project[];
  /** Absolute paths, exactly as the workspace folder and `fs.find` spell them. */
  runnablePaths: ReadonlySet<string>;
  /** Project key → its test files (sorted), for the projects that support partial runs. */
  testFiles: ReadonlyMap<string, readonly string[]>;
  /** `.sln`/`.slnx` path → the keys of the discovered .NET test projects it lists (only solutions with one). */
  solutions: ReadonlyMap<string, readonly string[]>;
}

/** Per-file "is a test file" answers of content-reading adapters (.NET), keyed by path. */
export type TestFileCache = Map<string, { mtime: number; isTest: boolean }>;

export interface DiscoverOptions {
  /**
   * The modification time of a file, when the reader can tell. With it, the answer for each `.cs`
   * file is cached by path and mtime; without it, every discovery reads the files again.
   */
  statMtime?(path: string): Promise<number | undefined>;
  /** Keeps the cached answers across discoveries; a new one is used when omitted. */
  testFileCache?: TestFileCache;
}

export interface RefreshResult {
  /** The updated state, or the same object when nothing changed. */
  state: DiscoveryState;
  /**
   * True when the path can change which projects exist (a marker or tool configuration file, a
   * project directory, a Python test file no project owns, the last test file of a Python project)
   * or the state did not come from `discover`: the caller must run `discover` again. `state` is then
   * the one passed in.
   */
  rediscover: boolean;
}

const PYTHON_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini'];
const PYTHON_TEST_GLOBS = ['**/test_*.py', '**/*_test.py'];
/** Everything discovery looks for, in one search per workspace folder. */
const SCAN_GLOBS = [
  '**/*.csproj', '**/*.sln', '**/*.slnx', '**/package.json',
  ...PYTHON_MARKERS.map(m => `**/${m}`),
  ...PYTHON_TEST_GLOBS,
];
/** Files that may be test files, per ecosystem whose projects are searched one by one. */
const CANDIDATE_GLOBS: Partial<Record<Ecosystem, readonly string[]>> = {
  node: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
  dotnet: ['**/*.cs'],
  python: PYTHON_TEST_GLOBS,
};
const DOTNET_BUILD_OUTPUT = ['**/bin/**', '**/obj/**'];
/** Ecosystems whose nested projects follow `nestedProjects`. */
const NESTING = new Set<Ecosystem>(['node', 'python']);
/** `.cs` files read at once before the event loop gets control back. */
const BATCH = 20;
/** Files (base names) whose change can add, remove or change a project: `refreshFile` asks for a new discovery. */
export const MARKER_FILE =
  /^(?:.*\.(?:csproj|sln|slnx)|package\.json|pyproject\.toml|setup\.py|setup\.cfg|pytest\.ini|tox\.ini|global\.json|directory\.build\.props|directory\.packages\.props|directory\.build\.targets|(?:jest|vitest|vite)\.config\.[^.]+|\.mocharc\.[^.]+)$/i;

const CASE_INSENSITIVE = process.platform === 'win32';
const cmp = (p: string): string => (CASE_INSENSITIVE ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a: string, b: string): boolean => cmp(a) === cmp(b);

/** Whether `child` is `parent` or inside it. */
function atOrUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function strictlyUnder(child: string, parent: string): boolean {
  return atOrUnder(child, parent) && !samePath(child, parent);
}

const posixRel = (dir: string, p: string): string => path.relative(dir, p).split(path.sep).join('/');

/** The innermost of `folders` that contains `p` (nested workspace folders own their own subtree). */
function innermostFolder(p: string, folders: readonly string[]): string | undefined {
  return folders.filter(f => atOrUnder(p, f)).sort((a, b) => path.resolve(b).length - path.resolve(a).length)[0];
}

interface Internals {
  adapters: readonly Adapter[];
  settings: ReadonlyMap<string, Settings>;
  options: DiscoverOptions;
  cache: TestFileCache;
}

/** What `refreshFile` needs and the public state does not carry. */
const internals = new WeakMap<DiscoveryState, Internals>();

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * One pass's reader: each file is read (and each path checked) once, and a search for globs the
 * folder search already covered is answered from its results (the excludes of both apply).
 */
function passReader(fs: FsReader): FsReader & { scans: Array<{ folder: string; files: readonly string[] }> } {
  const texts = new Map<string, Promise<string | undefined>>();
  const existing = new Map<string, Promise<boolean>>();
  const scans: Array<{ folder: string; files: readonly string[] }> = [];
  return {
    scans,
    readText(p) {
      let text = texts.get(p);
      if (text === undefined) texts.set(p, (text = fs.readText(p)));
      return text;
    },
    exists(p) {
      let found = existing.get(p);
      if (found === undefined) existing.set(p, (found = fs.exists(p)));
      return found;
    },
    async find(dir, include, exclude) {
      const scan = include.every(g => SCAN_GLOBS.includes(g))
        ? scans.filter(s => atOrUnder(dir, s.folder)).sort((a, b) => b.folder.length - a.folder.length)[0]
        : undefined;
      if (scan === undefined) return fs.find(dir, include, exclude);
      return scan.files.filter(f => {
        if (!strictlyUnder(f, dir)) return false;
        const rel = posixRel(dir, f);
        return matchesAny(rel, include) && !matchesAny(rel, exclude);
      });
    },
  };
}

async function firstDetected(adapters: readonly Adapter[], candidate: string, fs: FsReader): Promise<Project | undefined> {
  for (const adapter of adapters) {
    const project = await adapter.detect(candidate, fs);
    if (project !== undefined) return project;
  }
  return undefined;
}

/** The nearest directory from `dir` up to `folder` with a Python marker; `folder` when there is none. */
function pythonProjectDir(dir: string, folder: string, markerDirs: ReadonlySet<string>): string {
  for (let d = dir; atOrUnder(d, folder); d = path.dirname(d)) {
    if (markerDirs.has(cmp(d))) return d;
    if (samePath(d, folder) || path.dirname(d) === d) break;
  }
  return folder;
}

/** Drops nested projects of the same ecosystem (node and python only), keeping the inner or the outer ones. */
function applyNesting(projects: readonly Project[], mode: Settings['nestedProjects']): Project[] {
  return projects.filter(p => {
    if (!NESTING.has(p.ecosystem)) return true;
    const others = projects.filter(q => q !== p && q.ecosystem === p.ecosystem);
    return mode === 'inner' ? !others.some(q => strictlyUnder(q.dir, p.dir)) : !others.some(q => strictlyUnder(p.dir, q.dir));
  });
}

function byDir(a: Project, b: Project): number {
  const ka = [a.dir, a.adapter, a.definingFile ?? ''];
  const kb = [b.dir, b.adapter, b.definingFile ?? ''];
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
}

/**
 * Whether `file` belongs to `project`: inside it, not inside a custom command directory, and not
 * inside a deeper project of the same ecosystem.
 */
function owns(project: Project, file: string, projects: readonly Project[]): boolean {
  if (!strictlyUnder(file, project.dir)) return false;
  return !projects.some(
    q => q !== project && strictlyUnder(q.dir, project.dir) && atOrUnder(file, q.dir) && (q.ecosystem === project.ecosystem || q.ecosystem === 'custom'),
  );
}

function folderOf(project: Project): string {
  return typeof project.meta.workspaceFolder === 'string' ? project.meta.workspaceFolder : project.dir;
}

/**
 * Searches `dir` (inside `folder`) the way the folder search would: `exclude` is matched against
 * paths relative to the workspace folder. Only the globs that match the same way wherever they are
 * applied (those that start with a double-star segment) prune the walk; the others filter its results.
 */
async function findInFolder(
  fs: FsReader, dir: string, include: readonly string[], folder: string, exclude: readonly string[],
): Promise<string[]> {
  const prune = exclude.filter(g => g.startsWith('**/'));
  const found = await fs.find(dir, include, prune);
  return found.filter(f => !matchesAny(posixRel(folder, f), exclude));
}

function excludesFor(project: Project, settings: Settings): string[] {
  return project.ecosystem === 'dotnet' ? [...DOTNET_BUILD_OUTPUT, ...settings.exclude] : settings.exclude;
}

/** `isTestFile` over `files`; for .NET in batches with a yield in between, cached by mtime when known. */
async function filterTestFiles(adapter: Adapter, project: Project, files: readonly string[], fs: FsReader, ctx: Internals): Promise<string[]> {
  if (project.ecosystem !== 'dotnet') {
    const out: string[] = [];
    for (const f of files) if (await adapter.isTestFile(project, f, fs)) out.push(f);
    return out;
  }
  const out: string[] = [];
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const answers = await Promise.all(batch.map(f => cachedIsTest(adapter, project, f, fs, ctx)));
    batch.forEach((f, k) => answers[k] && out.push(f));
    await yieldToEventLoop();
  }
  return out;
}

async function cachedIsTest(adapter: Adapter, project: Project, file: string, fs: FsReader, ctx: Internals): Promise<boolean> {
  const mtime = await ctx.options.statMtime?.(file);
  if (mtime === undefined) return adapter.isTestFile(project, file, fs);
  const hit = ctx.cache.get(file);
  if (hit !== undefined && hit.mtime === mtime) return hit.isTest;
  const isTest = await adapter.isTestFile(project, file, fs);
  ctx.cache.set(file, { mtime, isTest });
  return isTest;
}

function computeRunnable(
  projects: readonly Project[], testFiles: ReadonlyMap<string, readonly string[]>, solutions: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const out = new Set<string>();
  for (const p of projects) {
    if (p.definingFile !== undefined) out.add(p.definingFile);
    const folder = folderOf(p);
    for (let d = p.dir; atOrUnder(d, folder); d = path.dirname(d)) {
      out.add(d);
      if (samePath(d, folder) || path.dirname(d) === d) break;
    }
  }
  for (const sln of solutions.keys()) out.add(sln);
  const byKey = new Map(projects.map(p => [p.key, p]));
  for (const [key, files] of testFiles) {
    const project = byKey.get(key);
    if (project === undefined) continue;
    for (const f of files) {
      out.add(f);
      for (let d = path.dirname(f); strictlyUnder(d, project.dir); d = path.dirname(d)) out.add(d);
    }
  }
  return out;
}

function makeState(
  folders: readonly string[], projects: readonly Project[], testFiles: ReadonlyMap<string, readonly string[]>,
  solutions: ReadonlyMap<string, readonly string[]>, ctx: Internals,
): DiscoveryState {
  const state: DiscoveryState = { folders, projects, runnablePaths: computeRunnable(projects, testFiles, solutions), testFiles, solutions };
  internals.set(state, ctx);
  return state;
}

/**
 * Finds the projects of each workspace folder: one search per folder for every marker and Python
 * test file (with the folder's excludes; a path belongs to the innermost workspace folder that
 * contains it, whose settings apply); each `.csproj` offered to the .NET adapters, each
 * `package.json` directory to the Node adapters in order (the first that recognizes it wins), and
 * the directory of each group of Python test files to the Python adapters. Then the nesting rule,
 * as if there were no custom commands, and only then the custom commands: each becomes a project
 * and drops every project at or under its directory. Test files are then searched for once per Node
 * or .NET project that supports partial runs. `adapters` is tried in its order.
 */
export async function discover(
  folders: readonly string[], fs: FsReader, settingsOf: (folder: string) => Settings, adapters: readonly Adapter[],
  options: DiscoverOptions = {},
): Promise<DiscoveryState> {
  const ctx: Internals = {
    adapters,
    settings: new Map(folders.map(f => [f, settingsOf(f)])),
    options,
    cache: options.testFileCache ?? new Map(),
  };
  const reader = passReader(fs);
  const of = (eco: Ecosystem) => adapters.filter(a => a.ecosystem === eco);
  const solutionFiles: string[] = [];
  const pythonTests: string[] = [];
  /** Per folder: its custom projects and what the adapters found there, after the nesting rule. */
  const perFolder: Array<{ custom: Project[]; found: Project[] }> = [];

  const customsOf = new Map<string, Project[]>();
  for (const folder of folders) {
    const settings = ctx.settings.get(folder) ?? settingsOf(folder);
    const custom: Project[] = [];
    for (const [rel, command] of Object.entries(settings.commands)) {
      if (typeof command !== 'string' || command.trim() === '') continue;
      const dir = path.resolve(folder, rel);
      if (!atOrUnder(dir, folder) || !(await reader.exists(dir))) continue;
      custom.push(customProject(dir, command, folder));
    }
    customsOf.set(folder, custom);
  }
  // Only the outermost custom directories count: an outer command runs everything inside it, a
  // nested one included (also one from a workspace folder nested inside it).
  const allCustom = [...customsOf.values()].flat();
  const customDirs = allCustom.filter(c => !allCustom.some(d => strictlyUnder(c.dir, d.dir))).map(c => c.dir);
  const inCustom = (p: string) => customDirs.some(d => atOrUnder(p, d));

  for (const folder of folders) {
    const settings = ctx.settings.get(folder) ?? settingsOf(folder);
    const scanned = await fs.find(folder, SCAN_GLOBS, settings.exclude);
    const files = scanned.filter(f => innermostFolder(f, folders) === folder);
    reader.scans.push({ folder, files });
    const custom = (customsOf.get(folder) ?? []).filter(c => customDirs.some(d => samePath(d, c.dir)));

    const found: Project[] = [];
    const markerDirs = new Set<string>();
    const pyTestDirs = new Map<string, string>();
    for (const file of files) {
      const name = path.basename(file).toLowerCase();
      if (name.endsWith('.csproj')) {
        const p = await firstDetected(of('dotnet'), file, reader);
        if (p !== undefined) found.push(p);
      } else if (name.endsWith('.sln') || name.endsWith('.slnx')) {
        solutionFiles.push(file);
      } else if (name === 'package.json') {
        const p = await firstDetected(of('node'), file, reader);
        if (p !== undefined) found.push(p);
      } else if (PYTHON_MARKERS.includes(name)) {
        markerDirs.add(cmp(path.dirname(file)));
      }
    }
    for (const file of files) {
      if (!matchesAny(path.basename(file), ['test_*.py', '*_test.py'])) continue;
      const dir = pythonProjectDir(path.dirname(file), folder, markerDirs);
      // A test file under a custom directory only makes a project inside that directory (which the
      // command then replaces): never one outside it, which would run the file a second time.
      const custom = customDirs.find(d => atOrUnder(file, d));
      if (custom !== undefined && !atOrUnder(dir, custom)) continue;
      if (custom === undefined) pythonTests.push(file);
      pyTestDirs.set(cmp(dir), dir);
    }
    for (const dir of pyTestDirs.values()) {
      const p = await firstDetected(of('python'), dir, reader);
      if (p !== undefined) found.push(p);
    }
    const withFolder = (p: Project): Project => ({ ...p, meta: { ...p.meta, workspaceFolder: folder } });
    perFolder.push({ custom, found: applyNesting(found, settings.nestedProjects).map(withFolder) });
  }

  // Custom commands replace what they cover only after the nesting rule, so that an orchestrator
  // dropped for the projects inside it stays dropped when one of them gets a custom command.
  const projects: Project[] = [];
  const seen = new Set<string>();
  for (const { custom, found } of perFolder) {
    const kept = found.filter(p => !inCustom(p.dir));
    for (const p of [...custom, ...kept].sort(byDir)) {
      const key = CASE_INSENSITIVE ? p.key.toLowerCase() : p.key;
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push(p);
    }
  }

  const testFiles = new Map<string, string[]>();
  const byId = new Map(adapters.map(a => [a.id, a]));
  for (const project of projects) {
    const adapter = byId.get(project.adapter);
    if (!project.supportsPartial || adapter === undefined) continue;
    const settings = ctx.settings.get(folderOf(project)) ?? settingsOf(folderOf(project));
    const globs = CANDIDATE_GLOBS[project.ecosystem];
    if (globs === undefined) continue;
    const candidates = project.ecosystem === 'python'
      ? pythonTests.filter(f => strictlyUnder(f, project.dir))
      : await findInFolder(fs, project.dir, globs, folderOf(project), excludesFor(project, settings));
    const mine = candidates.filter(f => owns(project, f, projects));
    testFiles.set(project.key, (await filterTestFiles(adapter, project, mine, fs, ctx)).sort());
  }

  const dotnetByPath = new Map(projects.filter(p => p.ecosystem === 'dotnet' && p.definingFile).map(p => [cmp(p.definingFile ?? ''), p.key]));
  const solutions = new Map<string, string[]>();
  for (const sln of solutionFiles) {
    const text = await reader.readText(sln);
    if (text === undefined) continue;
    const keys = [...new Set(projectsInSolution(text, sln).flatMap(p => dotnetByPath.get(cmp(p)) ?? []))];
    if (keys.length > 0) solutions.set(sln, keys);
  }

  return makeState(folders, projects, testFiles, solutions, ctx);
}

/**
 * What "Run Coverage Here" runs for an Explorer path; empty when the path is not eligible.
 * A file: the project it defines, else every test project of the solution it is, else a partial run
 * of each project it is a test file of. A directory: a full run of every project at or under it (the
 * workspace folder root: every project of the folder), plus a partial run of each project it is
 * inside of that has test files under it: of the directory when no project lies under it, else of
 * the test files that project owns there.
 */
export function resolveTarget(p: string, isDirectory: boolean, state: DiscoveryState): Array<{ project: Project; target: RunTarget }> {
  const full = (project: Project) => ({ project, target: { kind: 'full' } as RunTarget });
  const partial = (project: Project, paths: readonly string[] = [p]) => ({ project, target: { kind: 'partial', paths } as RunTarget });
  const filesOf = (project: Project) => state.testFiles.get(project.key) ?? [];
  if (!isDirectory) {
    const defined = state.projects.filter(x => x.definingFile !== undefined && samePath(x.definingFile, p));
    if (defined.length > 0) return defined.map(full);
    for (const [sln, keys] of state.solutions) {
      if (samePath(sln, p)) return keys.flatMap(k => state.projects.filter(x => x.key === k)).map(full);
    }
    return state.projects.filter(x => x.supportsPartial && filesOf(x).some(f => samePath(f, p))).map(x => partial(x));
  }
  const inside = state.projects.filter(x => atOrUnder(x.dir, p));
  const enclosing: Array<{ project: Project; target: RunTarget }> = [];
  for (const x of state.projects) {
    if (!x.supportsPartial || !strictlyUnder(p, x.dir)) continue;
    const owned = filesOf(x).filter(f => strictlyUnder(f, p));
    if (owned.length === 0) continue;
    // With a project (custom ones included) under the directory, the adapter must not expand the
    // directory itself, which would take that project's files too: it gets the owned files instead.
    enclosing.push(inside.length === 0 ? partial(x) : partial(x, owned));
  }
  return [...inside.map(full), ...enclosing];
}

/**
 * A reader for `refreshFile`. With `kindOf` (one stat), the refreshed path is checked with it instead
 * of `exists`, and a path that is a file is never searched as a directory moved in.
 */
export interface RefreshReader extends FsReader {
  kindOf?(path: string): Promise<'file' | 'directory' | undefined>;
}

/**
 * Re-evaluates one created, changed or deleted path (a file, or a directory moved in or deleted)
 * that may be a test file of a discovered project, without a new discovery: a Node or Python test
 * file, or a `.cs` file inside a .NET test project. Paths outside every project, excluded or inside
 * a custom command directory change nothing. See `RefreshResult.rediscover` for what it leaves to
 * `discover`.
 */
export async function refreshFile(state: DiscoveryState, file: string, fs: RefreshReader): Promise<RefreshResult> {
  const ctx = internals.get(state);
  const rediscover = { state, rediscover: true };
  const unchanged = { state, rediscover: false };
  if (ctx === undefined || MARKER_FILE.test(path.basename(file))) return rediscover;
  if (state.projects.some(p => atOrUnder(p.dir, file))) return rediscover;

  const folder = innermostFolder(file, state.folders);
  if (folder === undefined || samePath(folder, file)) return unchanged;
  const settings = ctx.settings.get(folder);
  if (settings === undefined || matchesAny(posixRel(folder, file), settings.exclude)) return unchanged;
  if (state.projects.some(p => p.ecosystem === 'custom' && atOrUnder(file, p.dir))) return unchanged;

  const kind = fs.kindOf === undefined ? undefined : await fs.kindOf(file);
  const exists = fs.kindOf === undefined ? await fs.exists(file) : kind !== undefined;
  // A deleted directory that held a solution.
  if (!exists && [...state.solutions.keys()].some(sln => atOrUnder(sln, file))) return rediscover;
  const owners = state.projects.filter(p => p.supportsPartial && owns(p, file, state.projects));
  const byId = new Map(ctx.adapters.map(a => [a.id, a]));

  const isCandidate = (p: Project) => matchesAny(posixRel(p.dir, file), CANDIDATE_GLOBS[p.ecosystem] ?? []);
  const ownedPythonTest = (f: string) => state.projects.some(p => p.ecosystem === 'python' && owns(p, f, state.projects));
  if (exists) {
    if (matchesAny(path.basename(file), ['test_*.py', '*_test.py'])) {
      if (!ownedPythonTest(file)) return rediscover; // A new Python project may start here.
    } else if (!owners.some(isCandidate)) {
      // Not a file an owner could take: maybe a directory moved in, searched like a workspace folder.
      // A file is not searched (with a reader that can tell).
      if (fs.kindOf !== undefined && kind !== 'directory') return unchanged;
      const found = await findInFolder(fs, file, SCAN_GLOBS, folder, settings.exclude);
      const isPythonTest = (f: string) => matchesAny(path.basename(f), ['test_*.py', '*_test.py']);
      if (found.some(f => !isPythonTest(f) || !ownedPythonTest(f))) return rediscover;
    }
  }

  const testFiles = new Map(state.testFiles);
  let changed = false;
  for (const project of owners) {
    const adapter = byId.get(project.adapter);
    const globs = CANDIDATE_GLOBS[project.ecosystem];
    if (adapter === undefined || globs === undefined) continue;
    const before = state.testFiles.get(project.key) ?? [];
    const kept = before.filter(f => !atOrUnder(f, file));
    let added: string[] = [];
    if (exists) {
      const exclude = excludesFor(project, settings);
      const candidates = matchesAny(posixRel(project.dir, file), globs)
        ? (matchesAny(posixRel(folder, file), exclude) ? [] : [file])
        : await findInFolder(fs, file, globs, folder, exclude);
      const mine = candidates.filter(f => owns(project, f, state.projects));
      added = await filterTestFiles(adapter, project, mine, fs, ctx);
    }
    // A path already known keeps its spelling; a new one is normalized, so a differently spelled
    // watcher path never adds a duplicate.
    const known = (f: string) => before.find(b => samePath(b, f)) ?? path.resolve(f);
    const unique = new Map<string, string>();
    for (const f of [...kept, ...added.map(known)]) if (!unique.has(cmp(f))) unique.set(cmp(f), f);
    const after = [...unique.values()].sort();
    if (project.ecosystem === 'python' && before.length > 0 && after.length === 0) return rediscover; // The project is gone.
    if (after.length !== before.length || after.some((f, i) => f !== before[i])) {
      testFiles.set(project.key, after);
      changed = true;
    }
  }
  if (!changed) return unchanged;
  return { state: makeState(state.folders, state.projects, testFiles, state.solutions, ctx), rediscover: false };
}
