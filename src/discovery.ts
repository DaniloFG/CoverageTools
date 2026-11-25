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
/** Files whose change can add, remove or change a project: `refreshFile` asks for a new discovery. */
const MARKER_FILE =
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
      const scan = include.every(g => SCAN_GLOBS.includes(g)) ? scans.find(s => atOrUnder(dir, s.folder)) : undefined;
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
 * test file (with the folder's excludes); custom commands first, each suppressing what is inside its
 * directory; then each `.csproj` offered to the .NET adapters, each `package.json` directory to the
 * Node adapters in order (the first that recognizes it wins), and the directory of each group of
 * Python test files to the Python adapters; then the nesting rule. Test files are then searched for
 * once per Node or .NET project that supports partial runs. `adapters` is tried in its order.
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
  const projects: Project[] = [];
  const seen = new Set<string>();
  const solutionFiles: string[] = [];
  const pythonTests: string[] = [];

  for (const folder of folders) {
    const settings = ctx.settings.get(folder) ?? settingsOf(folder);
    const files = await fs.find(folder, SCAN_GLOBS, settings.exclude);
    reader.scans.push({ folder, files });

    const custom: Project[] = [];
    for (const [rel, command] of Object.entries(settings.commands)) {
      if (typeof command !== 'string' || command.trim() === '') continue;
      const dir = path.resolve(folder, rel);
      if (!atOrUnder(dir, folder) || !(await reader.exists(dir))) continue;
      custom.push(customProject(dir, command, folder));
    }
    const suppressed = (p: string) => custom.some(c => atOrUnder(p, c.dir));

    const found: Project[] = [];
    const markerDirs = new Set<string>();
    const pyTestDirs = new Map<string, string>();
    for (const file of files) {
      if (suppressed(file)) continue;
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
      if (suppressed(file) || !matchesAny(path.basename(file), ['test_*.py', '*_test.py'])) continue;
      pythonTests.push(file);
      const dir = pythonProjectDir(path.dirname(file), folder, markerDirs);
      pyTestDirs.set(cmp(dir), dir);
    }
    for (const dir of pyTestDirs.values()) {
      const p = await firstDetected(of('python'), dir, reader);
      if (p !== undefined) found.push(p);
    }

    for (const p of [...custom, ...applyNesting(found, settings.nestedProjects)].sort(byDir)) {
        const key = CASE_INSENSITIVE ? p.key.toLowerCase() : p.key;
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({ ...p, meta: { ...p.meta, workspaceFolder: folder } });
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
      : await fs.find(project.dir, globs, excludesFor(project, settings));
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
 * of each project it is a test file of. A directory: every project at or under it (the workspace
 * folder root: every project of the folder), else a partial run of each project it is inside of
 * that has test files under it.
 */
export function resolveTarget(p: string, isDirectory: boolean, state: DiscoveryState): Array<{ project: Project; target: RunTarget }> {
  const full = (project: Project) => ({ project, target: { kind: 'full' } as RunTarget });
  const partial = (project: Project) => ({ project, target: { kind: 'partial', paths: [p] } as RunTarget });
  const filesOf = (project: Project) => state.testFiles.get(project.key) ?? [];
  if (!isDirectory) {
    const defined = state.projects.filter(x => x.definingFile !== undefined && samePath(x.definingFile, p));
    if (defined.length > 0) return defined.map(full);
    for (const [sln, keys] of state.solutions) {
      if (samePath(sln, p)) return keys.flatMap(k => state.projects.filter(x => x.key === k)).map(full);
    }
    return state.projects.filter(x => x.supportsPartial && filesOf(x).some(f => samePath(f, p))).map(partial);
  }
  const inside = state.projects.filter(x => atOrUnder(x.dir, p));
  if (inside.length > 0) return inside.map(full);
  return state.projects
    .filter(x => x.supportsPartial && strictlyUnder(p, x.dir) && filesOf(x).some(f => strictlyUnder(f, p)))
    .map(partial);
}

/**
 * Re-evaluates one created, changed or deleted path (a file, or a directory moved in or deleted)
 * that may be a test file of a discovered project, without a new discovery: a Node or Python test
 * file, or a `.cs` file inside a .NET test project. Paths outside every project, excluded or inside
 * a custom command directory change nothing. See `RefreshResult.rediscover` for what it leaves to
 * `discover`.
 */
export async function refreshFile(state: DiscoveryState, file: string, fs: FsReader): Promise<RefreshResult> {
  const ctx = internals.get(state);
  const rediscover = { state, rediscover: true };
  const unchanged = { state, rediscover: false };
  if (ctx === undefined || MARKER_FILE.test(path.basename(file))) return rediscover;
  if (state.projects.some(p => atOrUnder(p.dir, file))) return rediscover;

  const folder = state.folders.filter(f => strictlyUnder(file, f)).sort((a, b) => b.length - a.length)[0];
  if (folder === undefined) return unchanged;
  const settings = ctx.settings.get(folder);
  if (settings === undefined || matchesAny(posixRel(folder, file), settings.exclude)) return unchanged;
  if (state.projects.some(p => p.ecosystem === 'custom' && atOrUnder(file, p.dir))) return unchanged;

  const exists = await fs.exists(file);
  const owners = state.projects.filter(p => p.supportsPartial && owns(p, file, state.projects));
  const byId = new Map(ctx.adapters.map(a => [a.id, a]));

  const isCandidate = (p: Project) => matchesAny(posixRel(p.dir, file), CANDIDATE_GLOBS[p.ecosystem] ?? []);
  if (exists && !owners.some(p => p.ecosystem === 'python')) {
    // A file another project could own is no Python test file; anything else may be a directory moved in.
    const pyTests = matchesAny(path.basename(file), ['test_*.py', '*_test.py'])
      ? [file]
      : owners.some(isCandidate) ? [] : await fs.find(file, PYTHON_TEST_GLOBS, settings.exclude);
    if (pyTests.length > 0) return rediscover; // A new Python project may start here.
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
      const rel = posixRel(project.dir, file);
      const candidates = matchesAny(rel, globs)
        ? (matchesAny(rel, exclude) ? [] : [file])
        : await fs.find(file, globs, exclude);
      const mine = candidates.filter(f => owns(project, f, state.projects));
      added = await filterTestFiles(adapter, project, mine, fs, ctx);
    }
    const after = [...new Set([...kept, ...added])].sort();
    if (project.ecosystem === 'python' && before.length > 0 && after.length === 0) return rediscover; // The project is gone.
    if (after.length !== before.length || after.some((f, i) => f !== before[i])) {
      testFiles.set(project.key, after);
      changed = true;
    }
  }
  if (!changed) return unchanged;
  return { state: makeState(state.folders, state.projects, testFiles, state.solutions, ctx), rediscover: false };
}
