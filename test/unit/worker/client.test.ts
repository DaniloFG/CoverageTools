// Runs against the built dist/worker.js: `npm test` builds first.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { NotCoverageReportError, ReportParseError } from '../../../src/parsers/types';
import { ParserClient } from '../../../src/worker/client';
import { lines } from '../helpers';

const WORKER = path.resolve(__dirname, '../../../dist/worker.js');
const CRASHING_WORKER = path.join(__dirname, 'fixtures/crashing-worker.mjs');

let root: string;
let lcovPath: string;
let client: ParserClient;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ct-client-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'coverage'));
  writeFileSync(path.join(root, 'src/a.js'), 'a();\nb();\n');
  writeFileSync(path.join(root, 'src/b.js'), 'c();\n');
  lcovPath = path.join(root, 'coverage/lcov.info');
  writeFileSync(lcovPath, 'TN:\nSF:src/a.js\nFN:1,f\nFNDA:4,f\nDA:1,3\nDA:2,0\nBRDA:1,0,0,1\nBRDA:1,0,1,0\nend_of_record\n');
  client = new ParserClient(WORKER);
});

afterEach(async () => {
  client.dispose();
  await client.idle();
  rmSync(root, { recursive: true, force: true });
});

test('parses in a worker and returns typed arrays', async () => {
  const r = await client.parse(lcovPath, [root]);
  expect(r.files.map(f => f.path)).toEqual([path.join(root, 'src/a.js')]);
  const f = r.files[0];
  expect(f.statements).toBeInstanceOf(Uint32Array);
  expect(f.branches).toBeInstanceOf(Uint32Array);
  expect(f.declarations).toBeInstanceOf(Uint32Array);
  expect(lines(f)).toEqual([[1, 3], [2, 0]]);
  expect(Array.from(f.branches)).toEqual([1, 0, 0, 1, 1, 0, 1, 0]);
  expect(f.names).toEqual(['f']);
  expect(r.signature).toBe('');
  expect(r.dropped).toBe(0);
});

test('rejects with ReportParseError for a truncated report', async () => {
  const p = path.join(root, 'coverage/coverage-final.json');
  writeFileSync(p, '{"src/a.js":{"statementMap":{"0":');
  const error = await client.parse(p, [root]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ReportParseError);
  expect((error as Error).message).toMatch(/truncated/i);
});

test('rejects with NotCoverageReportError for a non-Cobertura coverage.xml', async () => {
  const p = path.join(root, 'coverage.xml');
  writeFileSync(p, '<?xml version="1.0"?>\n<project><name>x</name></project>\n');
  await expect(client.parse(p, [root])).rejects.toBeInstanceOf(NotCoverageReportError);
});

test('rejects with a plain Error for an I/O failure', async () => {
  mkdirSync(path.join(root, 'dir.json'));
  const error = await client.parse(path.join(root, 'dir.json'), [root]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ReportParseError);
  expect(error).not.toBeInstanceOf(NotCoverageReportError);
});

test('the worker is started on demand and terminated when no request is pending', async () => {
  expect(client.running).toBe(false);
  const p = client.parse(lcovPath, [root]);
  expect(client.running).toBe(true);
  await p; await client.idle();
  expect(client.running).toBe(false);
});

test('concurrent requests share one worker and all resolve', async () => {
  const other = path.join(root, 'coverage.lcov');
  writeFileSync(other, 'SF:src/b.js\nDA:1,7\nend_of_record\n');
  const bad = path.join(root, 'empty.json');
  writeFileSync(bad, '');
  const pa = client.parse(lcovPath, [root]);
  const pb = client.parse(other, [root]);
  const pc = client.parse(bad, [root]).catch((e: unknown) => e);
  expect(client.startedWorkers).toBe(1);
  const [a, b, c] = await Promise.all([pa, pb, pc]);
  expect(client.startedWorkers).toBe(1);
  expect(a.files.map(f => f.path)).toEqual([path.join(root, 'src/a.js')]);
  expect(lines(b.files[0])).toEqual([[1, 7]]);
  expect(c).toBeInstanceOf(ReportParseError);
  await client.idle();
  expect(client.running).toBe(false);
});

test('a request made right after the worker was told to stop starts a fresh worker', async () => {
  await client.parse(lcovPath, [root]);
  // The previous worker is being terminated now; this request must not be posted to it.
  const r = await client.parse(lcovPath, [root]);
  expect(r.files).toHaveLength(1);
  expect(client.startedWorkers).toBe(2);
});

test('a worker crash rejects the pending requests and the next parse uses a fresh worker', async () => {
  client.dispose();
  client = new ParserClient(CRASHING_WORKER);
  const crashed = client.parse(path.join(root, 'crash'), [root]);
  const sibling = client.parse(lcovPath, [root]);
  const errors = await Promise.all([crashed.catch((e: unknown) => e), sibling.catch((e: unknown) => e)]);
  for (const e of errors) {
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ReportParseError);
    expect((e as Error).message).toMatch(/worker/i);
  }
  expect(client.running).toBe(false);

  const r = await client.parse(lcovPath, [root]);
  expect(r.files).toHaveLength(1);
  expect(client.startedWorkers).toBe(2);
});

test('dispose() rejects pending requests and leaves no worker running', async () => {
  const p = client.parse(lcovPath, [root]);
  expect(client.running).toBe(true);
  client.dispose();
  expect(client.running).toBe(false);
  await expect(p).rejects.toThrow(/disposed/);
  await client.idle();
  await expect(client.parse(lcovPath, [root])).rejects.toThrow(/disposed/);
  expect(client.running).toBe(false);
  expect(client.startedWorkers).toBe(1);
});
