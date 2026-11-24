import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Adapter, AdapterId, FsReader } from '../../src/adapters/types';
import { matchesAny } from '../../src/glob';
import { unionFiles } from '../../src/merge';
import type { RunDeps } from '../../src/runner/runProject';
import { DEFAULT_SETTINGS, type Settings } from '../../src/settings';
import { CoverageStore } from '../../src/store';
import { ParserClient } from '../../src/worker/client';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER_FILE = path.join(REPO_ROOT, 'dist', 'worker.js');
const C8_BIN = path.join(REPO_ROOT, 'node_modules', 'c8', 'bin', 'c8.js');

/** Absolute path of `samples/<name>`. */
export function sampleDir(name: string): string {
  return path.join(REPO_ROOT, 'samples', name);
}

/**
 * An FsReader over node:fs. `find` walks `dir` recursively and returns the absolute paths of the
 * files whose path relative to `dir` matches one of `include`; a file or directory matching one of
 * `exclude` is skipped (directories are pruned).
 */
export function nodeFsReader(): FsReader {
  return {
    async readText(p) {
      try {
        return await readFile(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    async exists(p) {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
    async find(dir, include, exclude) {
      const out: string[] = [];
      const walk = async (current: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          const rel = path.relative(dir, full).split(path.sep).join('/');
          if (matchesAny(rel, exclude)) continue;
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile() && matchesAny(rel, include)) out.push(full);
        }
      };
      await walk(dir);
      return out.sort();
    },
  };
}

export interface RealDeps {
  deps: RunDeps;
  store: CoverageStore;
  /** Every chunk written to `deps.output`. */
  output: string[];
  /** The project keys `deps.suppress` was called with, in order. */
  suppressed: string[];
  /** The adapters `runProject` dispatches to; tests may add more. */
  adapters: Map<AdapterId, Adapter>;
  dispose(): Promise<void>;
}

/**
 * Real dependencies for `runProject`: a real store, a real parser worker on `dist/worker.js` (run
 * `npm run build` first), the c8 binary of this repository and a node:fs reader. `suppress` only
 * records its calls.
 */
export function createRealDeps(
  roots: readonly string[],
  settings: Partial<Settings> = {},
  adapters: readonly Adapter[] = [],
): RealDeps {
  const store = new CoverageStore();
  const parser = new ParserClient(WORKER_FILE);
  const output: string[] = [];
  const suppressed: string[] = [];
  const adapterMap = new Map<AdapterId, Adapter>(adapters.map(a => [a.id, a]));
  const deps: RunDeps = {
    adapters: adapterMap,
    store,
    parser,
    fs: nodeFsReader(),
    settings: { ...DEFAULT_SETTINGS, ...settings },
    roots,
    c8Bin: C8_BIN,
    output: chunk => { output.push(chunk); },
    suppress: key => {
      suppressed.push(key);
      return { release() {} };
    },
  };
  return {
    deps, store, output, suppressed, adapters: adapterMap,
    async dispose() {
      parser.dispose();
    },
  };
}

/**
 * `[line, count]` for every line on which a statement of the merged file starts, sorted by line.
 * The count of a line is the lowest count among its statements, so a line reads as covered only
 * when everything starting on it ran. Throws when the store has no such file.
 */
export function linesOf(store: CoverageStore, absPath: string): Array<[number, number]> {
  const entry = store.merged().find(e => e.path === absPath);
  if (entry === undefined) {
    throw new Error(`No coverage for ${absPath}; the store has: ${store.merged().map(e => e.path).join(', ') || 'nothing'}`);
  }
  const file = unionFiles(entry.parts);
  const byLine = new Map<number, number>();
  const s = file.statements;
  for (let i = 0; i < s.length; i += 5) {
    const line = s[i];
    const count = s[i + 4];
    const current = byLine.get(line);
    byLine.set(line, current === undefined ? count : Math.min(current, count));
  }
  return [...byLine.entries()].sort((a, b) => a[0] - b[0]);
}
