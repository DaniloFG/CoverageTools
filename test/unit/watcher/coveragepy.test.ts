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
}

function fake(opts: {
  trusted?: boolean;
  python?: string;
  exec?: (spec: CommandSpec, onOutput: (chunk: string) => void) => Promise<{ code: number | null }>;
  parse?: (reportPath: string) => Promise<ParsedReport>;
} = {}): Fake {
  const f: Omit<Fake, 'deps'> = { execs: [], parsed: [], stored: [], logs: [], made: [], removed: [] };
  let n = 0;
  const deps: CoverageDataDeps = {
    isTrusted: () => opts.trusted ?? true,
    interpreterFor: async () => opts.python ?? '/work/proj/.venv/bin/python',
    exec: async (spec, o) => {
      f.execs.push(spec);
      return opts.exec ? opts.exec(spec, o.onOutput) : { code: 0 };
    },
    parse: async (reportPath, roots) => {
      f.parsed.push(reportPath);
      expect(roots).toEqual(['/work']);
      return opts.parse ? opts.parse(reportPath) : { files: [CALC], signature: 'sig', dropped: 0 };
    },
    makeTempDir: async () => {
      const dir = n++ === 0 ? TMP : `${TMP}-${n}`;
      f.made.push(dir);
      return dir;
    },
    removeDir: async dir => {
      f.removed.push(dir);
    },
    store: { replace: (key, files) => f.stored.push([key, files]) },
    keyOf: (coverageFile, signature) => `key:${coverageFile}#${signature}`,
    roots: () => ['/work'],
    log: msg => f.logs.push(msg),
    signal: new AbortController().signal,
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
  expect(f.logs).toEqual([]);
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

test('no interpreter can be spawned: logged, the store is untouched and the temp dir removed', async () => {
  const f = fake({ python: 'python3', exec: async spec => { throw new Error(`spawn ${spec.command} ENOENT`); } });
  expect(await ingestCoverageData(DATA, f.deps)).toBe('drop');
  expect(f.execs.map(s => s.command)).toEqual(['python3', 'python']);
  expect(f.stored).toEqual([]);
  expect(f.removed).toEqual([TMP]);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain('"python3"');
  expect(f.logs[0]).toContain('coverageTools.python.interpreter');
});

test('an interpreter from the settings or a venv that cannot be spawned is not replaced by python', async () => {
  const f = fake({ exec: async () => { throw new Error('spawn ENOENT'); } });
  expect(await ingestCoverageData(DATA, f.deps)).toBe('drop');
  expect(f.execs).toHaveLength(1);
  expect(f.logs).toHaveLength(1);
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
