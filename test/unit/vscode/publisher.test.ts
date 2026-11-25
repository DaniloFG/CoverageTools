import { expect, test, vi } from 'vitest';
import { FileBuilder } from '../../../src/model';
import { CoverageStore } from '../../../src/store';

const h = vi.hoisted(() => ({ runs: 0, added: [] as unknown[][], handler: undefined as undefined | ((...args: unknown[]) => unknown) }));

vi.mock('vscode', () => ({
  Uri: { file: (p: string) => ({ scheme: 'file', fsPath: p }) },
  TestRunProfileKind: { Coverage: 3 },
  TestRunRequest: class {},
  TestCoverageCount: class { constructor(public covered: number, public total: number) {} },
  FileCoverage: class { constructor(public uri: unknown) {} },
  commands: { executeCommand: async () => undefined },
  tests: {
    createTestController: () => ({
      createRunProfile: (_label: string, _kind: number, handler: (...args: unknown[]) => unknown) => {
        h.handler = handler;
        return {};
      },
      createTestRun: () => {
        h.runs++;
        const added: unknown[] = [];
        h.added.push(added);
        return { addCoverage(c: unknown) { added.push(c); }, end() {} };
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
  publisher.publishNow();
  expect(h.runs).toBe(1);
  publisher.dispose();
});

test('a republication reuses the published file of every file whose coverage did not change', () => {
  const f = (p: string, hits: number) => {
    const b = new FileBuilder(p);
    b.addLine(1, hits);
    return b.build();
  };
  const store = new CoverageStore();
  store.replace('a', [f('/w/a1.js', 1), f('/w/a2.js', 0)]);
  store.replace('b', [f('/w/b1.js', 1)]);
  const publisher = new Publisher(store);
  h.added.length = 0;
  publisher.publishNow();
  store.replace('b', [f('/w/b1.js', 5)]);
  publisher.publishNow();
  const [first, second] = h.added as Array<Array<{ uri: { fsPath: string } }>>;
  expect(second.map(c => c.uri.fsPath)).toEqual(['/w/a1.js', '/w/a2.js', '/w/b1.js']);
  expect(second[0]).toBe(first[0]);
  expect(second[1]).toBe(first[1]);
  expect(second[2]).not.toBe(first[2]);
  // Once closed, nothing published before is kept.
  void publisher.close();
  publisher.publishNow();
  expect(h.added[2][0]).not.toBe(first[0]);
  publisher.dispose();
});
