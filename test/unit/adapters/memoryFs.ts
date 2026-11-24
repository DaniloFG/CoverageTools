import path from 'node:path';
import type { FsReader } from '../../../src/adapters/types';
import { matchesAny } from '../../../src/glob';

/** An in-memory FsReader over `files` (absolute path → content). */
export function memoryFs(files: Record<string, string>): FsReader {
  const normalized = new Map(Object.entries(files).map(([p, c]) => [path.resolve(p), c]));
  return {
    readText: async p => normalized.get(path.resolve(p)),
    exists: async p => {
      const abs = path.resolve(p);
      if (normalized.has(abs)) return true;
      return [...normalized.keys()].some(k => k.startsWith(abs + path.sep));
    },
    find: async (dir, include, exclude) =>
      [...normalized.keys()]
        .filter(k => k.startsWith(path.resolve(dir) + path.sep))
        .filter(k => {
          const rel = path.relative(dir, k).split(path.sep).join('/');
          return matchesAny(rel, include) && !matchesAny(rel, exclude);
        })
        .sort(),
  };
}
