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

