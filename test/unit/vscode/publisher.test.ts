import { expect, test, vi } from 'vitest';
import { FileBuilder } from '../../../src/model';
import { CoverageStore } from '../../../src/store';

const h = vi.hoisted(() => ({
  runs: 0,
  ended: 0,
  added: [] as unknown[][],
  handler: undefined as undefined | ((...args: unknown[]) => unknown),
  profile: undefined as undefined | { loadDetailedCoverage?: (...args: unknown[]) => Promise<unknown> },
}));

vi.mock('vscode', () => ({
  Uri: { file: (p: string) => ({ scheme: 'file', fsPath: p }) },
  TestRunProfileKind: { Coverage: 3 },
  TestRunRequest: class {},
  TestCoverageCount: class { constructor(public covered: number, public total: number) {} },
  FileCoverage: class {
    constructor(public uri: unknown, public statementCoverage: unknown, public branchCoverage?: unknown, public declarationCoverage?: unknown) {}
  },
  Position: class { constructor(public line: number, public character: number) {} },
  Range: class { constructor(public start: unknown, public end: unknown) {} },
  StatementCoverage: class { constructor(public executed: number, public location: unknown, public branches: unknown[] = []) {} },
  BranchCoverage: class { constructor(public executed: number, public location?: unknown, public label?: string) {} },
  DeclarationCoverage: class { constructor(public name: string, public executed: number, public location: unknown) {} },
  commands: { executeCommand: async () => undefined },
  tests: {
    createTestController: () => ({
      createRunProfile: (_label: string, _kind: number, handler: (...args: unknown[]) => unknown) => {
        h.handler = handler;
        h.profile = {};
        return h.profile;
      },
      createTestRun: () => {
        h.runs++;
        const added: unknown[] = [];
        h.added.push(added);
        return { addCoverage(c: unknown) { added.push(c); }, end() { h.ended++; } };
      },
      dispose() {},
    }),
  },
}));

const { Publisher } = await import('../../../src/vscode/publisher');

test('the run profile starts nothing when VS Code invokes it (native "Run with Coverage")', async () => {
  const store = new CoverageStore();
  const b = new FileBuilder('/w/a.js');
  b.addLine(1, 1);
  store.replace('k', [b.build()]);
  const publisher = new Publisher(store);
  await h.handler?.({}, { isCancellationRequested: false });
  expect(h.runs).toBe(0);
  await publisher.publishNow();
  expect(h.runs).toBe(1);
  publisher.dispose();
});

const f = (p: string, hits: number) => {
  const b = new FileBuilder(p);
  b.addLine(1, hits);
  b.addLine(2, 0);
  return b.build();
};

type Published = { uri: { fsPath: string }; statementCoverage: { covered: number } } & Record<string, unknown>;

test('a republication reuses the published file of every file whose counts did not change', async () => {
  const store = new CoverageStore();
  store.replace('a', [f('/w/a1.js', 1), f('/w/a2.js', 0)]);
  store.replace('b', [f('/w/b1.js', 1)]);
  const publisher = new Publisher(store);
  h.added.length = 0;
  await publisher.publishNow();
  store.replace('b', [f('/w/b1.js', 0)]);
  await publisher.publishNow();
  const [first, second] = h.added as Published[][];
  expect(second.map(c => c.uri.fsPath)).toEqual(['/w/a1.js', '/w/a2.js', '/w/b1.js']);
  expect(second[0]).toBe(first[0]);
  expect(second[1]).toBe(first[1]);
  expect(second[2]).not.toBe(first[2]);
  expect(second[2].statementCoverage.covered).toBe(0);
  // Once closed, nothing published before is kept.
  void publisher.close();
  await publisher.publishNow();
  expect(h.added[2][0]).not.toBe(first[0]);
  publisher.dispose();
});

test('a published file holds no coverage data: only its uri, counts and path', async () => {
  const store = new CoverageStore();
  store.replace('a', [f('/w/a1.js', 1)]);
  const publisher = new Publisher(store);
  h.added.length = 0;
  await publisher.publishNow();
  const published = h.added[0][0] as Published;
  const holdsArrays = (value: unknown, depth: number): boolean => {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
    if (depth === 0 || typeof value !== 'object' || value === null) return false;
    return Object.values(value).some(v => holdsArrays(v, depth - 1));
  };
  expect(holdsArrays(published, 4)).toBe(false);
  expect(published.path).toBe('/w/a1.js');
  publisher.dispose();
});

test('detail is read from the store when VS Code asks; a file no longer in the store has none', async () => {
  const store = new CoverageStore();
  store.replace('a', [f('/w/a1.js', 1)]);
  store.replace('b', [f('/w/a1.js', 0), f('/w/b1.js', 3)]);
  const publisher = new Publisher(store);
  h.added.length = 0;
  await publisher.publishNow();
  const [a1, b1] = h.added[0];
  const executed = async (file: unknown) =>
    ((await h.profile!.loadDetailedCoverage!({}, file, {})) as Array<{ executed: number }>).map(d => d.executed);
  expect(await executed(a1)).toEqual([1, 0]);
  // The current data, even for a file published before the change.
  store.replace('a', [f('/w/a1.js', 7)]);
  expect(await executed(a1)).toEqual([7, 0]);
  store.clear('b');
  expect(await executed(b1)).toEqual([]);
  publisher.dispose();
});

test('a large set is published in slices that give the event loop control back, as one run', async () => {
  const store = new CoverageStore();
  store.replace('a', Array.from({ length: 3000 }, (_, i) => f(`/w/f${String(i).padStart(4, '0')}.js`, 1)));
  const publisher = new Publisher(store, { sliceMs: 0, yieldToLoop: () => new Promise(resolve => setImmediate(resolve)) });
  h.added.length = 0;
  h.ended = 0;
  let settled = 0;
  publisher.onDidSettle(() => settled++);
  const done = publisher.publishNow();
  expect(h.added[0].length).toBeLessThan(3000);
  expect(settled).toBe(0);
  await done;
  expect(h.added).toHaveLength(1);
  expect(h.added[0]).toHaveLength(3000);
  expect(h.ended).toBe(1);
  expect(settled).toBe(1);
  publisher.dispose();
});
