import path from 'node:path';
import { expect, test } from 'vitest';
import type { CommandSpec } from '../../../src/adapters/types';
import type { FileCoverageData } from '../../../src/model';
import { ReportParseError, type ParsedReport } from '../../../src/parsers/types';
import { ReportBatcher } from '../../../src/watcher/batcher';
import { conversionSpec, ingestCoverageData, type CoverageDataDeps } from '../../../src/watcher/coveragepy';
import { file } from '../helpers';

test('conversionSpec runs "<python> -m coverage xml --data-file=<file> -o <out>" in the file directory', () => {
  const file = path.resolve('/work/proj/.coverage');
  const out = path.resolve('/tmp/ct-2/coverage.xml');
  expect(conversionSpec(file, out, '/work/proj/.venv/bin/python')).toEqual({
    command: '/work/proj/.venv/bin/python',
    args: ['-m', 'coverage', 'xml', `--data-file=${file}`, '-o', out],
    cwd: path.resolve('/work/proj'),
  });
});

const flush = () => new Promise<void>(r => setImmediate(r));

const DATA = path.resolve('/work/proj/.coverage');
const TMP = path.resolve('/tmp/coverage-tools-x1');
const CALC = file(path.resolve('/work/proj/calc.py'), [[1, 1], [2, 0]]);

interface Fake {
  deps: CoverageDataDeps;
  execs: CommandSpec[];
  parsed: string[];
  stored: Array<[string, readonly FileCoverageData[]]>;
  logs: string[];
  made: string[];
  removed: string[];
  /** Directories removed synchronously (dispose). */
  removedNow: string[];
  /** Pending fake timers by id. */
  timers: Map<number, { fn: () => void; ms: number }>;
}

function fake(opts: {
  trusted?: boolean;
  python?: string;
  exec?: (spec: CommandSpec, onOutput: (chunk: string) => void) => Promise<{ code: number | null }>;
  parse?: (reportPath: string) => Promise<ParsedReport>;
  signal?: AbortSignal;
  interpreterFor?: () => Promise<string>;
  makeTempDir?: () => Promise<string>;
  execSignal?: (signal: AbortSignal) => void;
} = {}): Fake {
  const f: Omit<Fake, 'deps'> = { execs: [], parsed: [], stored: [], logs: [], made: [], removed: [], removedNow: [], timers: new Map() };
  let n = 0;
  let timerId = 0;
  const deps: CoverageDataDeps = {
    isTrusted: () => opts.trusted ?? true,
    interpreterFor: opts.interpreterFor ?? (async () => opts.python ?? '/work/proj/.venv/bin/python'),
    exec: async (spec, o) => {
      f.execs.push(spec);
      opts.execSignal?.(o.signal);
      return opts.exec ? opts.exec(spec, o.onOutput) : { code: 0 };
    },
    parse: async (reportPath, roots) => {
      f.parsed.push(reportPath);
      expect(roots).toEqual(['/work']);
      return opts.parse ? opts.parse(reportPath) : { files: [CALC], signature: 'sig', dropped: 0 };
    },
    makeTempDir: opts.makeTempDir ?? (async () => {
      const dir = n++ === 0 ? TMP : `${TMP}-${n}`;
      f.made.push(dir);
      return dir;
    }),
    removeDir: async dir => {
      f.removed.push(dir);
    },
    removeDirNow: dir => {
      f.removedNow.push(dir);
    },
    store: { replace: (key, files) => f.stored.push([key, files]) },
    keyOf: (coverageFile, signature) => `key:${coverageFile}#${signature}`,
    roots: () => ['/work'],
    platform: 'linux',
    log: msg => f.logs.push(msg),
    signal: opts.signal ?? new AbortController().signal,
    timers: {
      set: (fn, ms) => {
        f.timers.set(++timerId, { fn, ms });
        return timerId;
      },
      clear: h => f.timers.delete(h as number),
    },
  };
  return { ...f, deps };
}

test('a .coverage file is converted into a temp dir, parsed, stored and the temp dir removed', async () => {
  const f = fake();
  expect(await ingestCoverageData(DATA, f.deps)).toBe('ok');
  const xml = path.join(TMP, 'coverage.xml');
  expect(f.execs).toEqual([conversionSpec(DATA, xml, '/work/proj/.venv/bin/python')]);
  expect(f.parsed).toEqual([xml]);
  expect(f.stored).toEqual([[`key:${DATA}#sig`, [CALC]]]);
  expect(f.removed).toEqual([TMP]);
  expect(f.removedNow).toEqual([]);
  expect(f.logs).toEqual([]);
  expect(f.timers.size).toBe(0);
});

test('in an untrusted workspace the file is skipped without spawning anything', async () => {
  const f = fake({ trusted: false });
  expect(await ingestCoverageData(DATA, f.deps)).toBe('drop');
  expect(f.execs).toEqual([]);
  expect(f.made).toEqual([]);
  expect(f.stored).toEqual([]);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain(DATA);
  expect(f.logs[0]).toContain('not trusted');
});

test('a conversion that exits non-zero is logged with its output, the store is untouched and the temp dir removed', async () => {
  const f = fake({
    exec: async (_spec, onOutput) => {
      onOutput('No module named coverage\n');
      return { code: 1 };
    },
  });
  expect(await ingestCoverageData(DATA, f.deps)).toBe('drop');
  expect(f.parsed).toEqual([]);
  expect(f.stored).toEqual([]);
  expect(f.removed).toEqual([TMP]);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain(DATA);
  expect(f.logs[0]).toContain('code 1');
  expect(f.logs[0]).toContain('No module named coverage');
});

test('an unreadable converted report is logged, the store is untouched and the temp dir removed', async () => {
  const f = fake({ parse: async () => { throw new ReportParseError('unexpected end of input'); } });
  expect(await ingestCoverageData(DATA, f.deps)).toBe('drop');
  expect(f.stored).toEqual([]);
  expect(f.removed).toEqual([TMP]);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain('unexpected end of input');
});

test('python3 that cannot be spawned falls back to python', async () => {
  const f = fake({
    python: 'python3',
    exec: async spec => {
      if (spec.command === 'python3') throw new Error('spawn python3 ENOENT');
      return { code: 0 };
    },
  });
  expect(await ingestCoverageData(DATA, f.deps)).toBe('ok');
  expect(f.execs.map(s => s.command)).toEqual(['python3', 'python']);
  expect(f.stored).toHaveLength(1);
  expect(f.logs).toEqual([]);
});

test('on Windows the py launcher is tried first, then python and python3', async () => {
  const f = fake({ python: 'py', exec: async spec => { throw new Error(`spawn ${spec.command} ENOENT`); } });
  f.deps.platform = 'win32';
  expect(await ingestCoverageData(DATA, f.deps)).toBe('drop');
  expect(f.execs.map(s => s.command)).toEqual(['py', 'python', 'python3']);
  expect(f.logs[0]).toContain('none of "py", "python", "python3" could be started');
});

test('no interpreter can be spawned: logged, the store is untouched and the temp dir removed', async () => {
  const f = fake({ python: 'python3', exec: async spec => { throw new Error(`spawn ${spec.command} ENOENT`); } });
  expect(await ingestCoverageData(DATA, f.deps)).toBe('drop');
  expect(f.execs.map(s => s.command)).toEqual(['python3', 'python']);
  expect(f.stored).toEqual([]);
  expect(f.removed).toEqual([TMP]);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain('none of "python3", "python" could be started');
  expect(f.logs[0]).toContain('spawn python3 ENOENT');
  expect(f.logs[0]).not.toContain('spawn python ENOENT');
  expect(f.logs[0]).toContain('coverageTools.python.interpreter');
});

test('an interpreter from the settings or a venv that cannot be spawned is not replaced by python', async () => {
  const f = fake({ exec: async () => { throw new Error('spawn ENOENT'); } });
  expect(await ingestCoverageData(DATA, f.deps)).toBe('drop');
  expect(f.execs).toHaveLength(1);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain('the Python interpreter "/work/proj/.venv/bin/python" could not be started');
});

test.each([
  ['interpreterFor', { interpreterFor: () => Promise.reject(new Error('settings broke')) }],
  ['makeTempDir', { makeTempDir: () => Promise.reject(new Error('settings broke')) }],
])('%s throwing is logged and dropped, with nothing spawned, stored or left behind', async (_name, o) => {
  const f = fake(o);
  expect(await ingestCoverageData(DATA, f.deps)).toBe('drop');
  expect(f.execs).toEqual([]);
  expect(f.stored).toEqual([]);
  expect(f.made).toEqual([]);
  expect(f.removed).toEqual([]);
  expect(f.timers.size).toBe(0);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain('settings broke');
});

test('.coverage and coverage.xml in one burst: only the XML is ingested and nothing is spawned', async () => {
  const f = fake();
  const ingested: string[] = [];
  const timers = new Map<number, () => void>();
  let id = 0;
  const batcher = new ReportBatcher({
    debounceMs: 750,
    retryMs: 1000,
    groupOf: p => `dir:${path.dirname(p)}`,
    isSuppressed: () => false,
    ingest: async (_group, p) => {
      ingested.push(p);
      return path.basename(p) === '.coverage' ? ingestCoverageData(p, f.deps) : 'ok';
    },
    timers: { set: fn => { timers.set(++id, fn); return id; }, clear: h => timers.delete(h as number) },
  });
  const xml = path.join(path.dirname(DATA), 'coverage.xml');
  batcher.push(DATA);
  batcher.push(xml);
  batcher.push(DATA);
  expect(timers.size).toBe(1);
  const [[key, fn]] = [...timers];
  timers.delete(key);
  fn();
  await flush();
  expect(ingested).toEqual([xml]);
  expect(f.execs).toEqual([]);
  batcher.dispose();
});

test('a conversion still running after 60 s is killed, logged and frees the group; the timer is then gone', async () => {
  let execSignal: AbortSignal | undefined;
  let finish: (() => void) | undefined;
  const f = fake({
    execSignal: s => { execSignal = s; },
    exec: () => new Promise(resolve => { finish = () => resolve({ code: null }); }),
  });
  const done = ingestCoverageData(DATA, f.deps);
  await flush();
  expect(f.timers.size).toBe(1);
  const [[, timer]] = [...f.timers];
  expect(timer.ms).toBe(60_000);
  expect(execSignal?.aborted).toBe(false);
  timer.fn(); // the fake clock reaches 60 s
  expect(execSignal?.aborted).toBe(true);
  finish!(); // exec resolves once the killed process exits
  expect(await done).toBe('drop');
  expect(f.stored).toEqual([]);
  expect(f.removed).toEqual([TMP]);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain('did not finish within 60 s');
});

test('a conversion that finishes clears its timeout timer', async () => {
  const f = fake({ exec: async () => ({ code: 1 }) });
  await ingestCoverageData(DATA, f.deps);
  expect(f.timers.size).toBe(0);
});

test('disposing the watcher aborts a running conversion and removes its temp dir, without logging', async () => {
  const dispose = new AbortController();
  let execSignal: AbortSignal | undefined;
  const f = fake({
    signal: dispose.signal,
    execSignal: s => { execSignal = s; },
    exec: () => new Promise(resolve => execSignal!.addEventListener('abort', () => resolve({ code: null }))),
  });
  const done = ingestCoverageData(DATA, f.deps);
  await flush();
  expect(f.execs).toHaveLength(1);
  dispose.abort();
  expect(execSignal?.aborted).toBe(true);
  // Synchronously, before the extension host may exit.
  expect(f.removedNow).toEqual([TMP]);
  expect(await done).toBe('drop');
  expect(f.removed).toEqual([TMP]);
  expect(f.stored).toEqual([]);
  expect(f.logs).toEqual([]);
  expect(f.timers.size).toBe(0);
});

test('two .coverage events while a conversion is running lead to exactly one more conversion', async () => {
  const pending: Array<() => void> = [];
  const f = fake({ exec: () => new Promise(resolve => pending.push(() => resolve({ code: 0 }))) });
  const timers = new Map<number, () => void>();
  let id = 0;
  const batcher = new ReportBatcher({
    debounceMs: 750,
    retryMs: 1000,
    groupOf: () => 'project:/work/proj',
    isSuppressed: () => false,
    ingest: (_group, p) => ingestCoverageData(p, f.deps),
    timers: { set: fn => { timers.set(++id, fn); return id; }, clear: h => timers.delete(h as number) },
  });
  const settle = () => new Promise<void>(r => setImmediate(r));
  const fireDebounce = async () => {
    const [[key, fn]] = [...timers];
    timers.delete(key);
    fn();
    await settle();
  };

  batcher.push(DATA);
  await fireDebounce();
  expect(f.execs).toHaveLength(1);

  // pytest-cov touches .coverage again while the first conversion still runs, twice, each settling.
  batcher.push(DATA);
  await fireDebounce();
  batcher.push(DATA);
  await fireDebounce();
  expect(f.execs).toHaveLength(1);

  pending.shift()!();
  await settle();
  await settle();
  expect(f.execs).toHaveLength(2);
  pending.shift()!();
  await settle();
  await settle();
  expect(f.execs).toHaveLength(2);
  expect(f.stored).toHaveLength(2);
  expect(f.removed).toEqual([TMP, `${TMP}-2`]);
  expect(timers.size).toBe(0);
  batcher.dispose();
});
