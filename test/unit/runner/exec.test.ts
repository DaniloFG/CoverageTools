import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cmdCommandLine, exec, quoteForCmd } from '../../../src/runner/exec';

const NODE = process.execPath;

let dir: string;
let leftoverPids: number[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ct-exec-'));
  leftoverPids = [];
});

afterEach(() => {
  for (const pid of leftoverPids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(10);
  }
}

function run(args: string[], extra: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal } = {}) {
  let out = '';
  const promise = exec(
    { command: NODE, args, cwd: extra.cwd ?? dir, env: extra.env },
    { onOutput: chunk => { out += chunk; }, signal: extra.signal ?? new AbortController().signal },
  );
  return { promise, output: () => out };
}

test('streams output and resolves with the exit code', async () => {
  const chunks: string[] = [];
  const r = await exec(
    { command: NODE, args: ['-e', 'console.log("out " + process.env.CT_EXEC_TEST); console.error("err"); process.exit(3)'], cwd: dir, env: { CT_EXEC_TEST: 'merged' } },
    { onOutput: c => chunks.push(c), signal: new AbortController().signal },
  );
  expect(r).toEqual({ code: 3 });
  const all = chunks.join('');
  expect(all).toContain('out merged');
  expect(all).toContain('err');
});

test('the environment is process.env merged with the spec env', async () => {
  const { promise, output } = run(['-e', 'console.log(JSON.stringify([process.env.PATH !== undefined, process.env.CT_A]))'], { env: { CT_A: 'a' } });
  expect(await promise).toEqual({ code: 0 });
  expect(JSON.parse(output())).toEqual([true, 'a']);
});

test('arguments with spaces, quotes and accents reach the process intact', async () => {
  const values = ['a b', 'c"d', 'é', "it's", 'x\\y\\', ''];
  const { promise, output } = run(['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...values]);
  expect(await promise).toEqual({ code: 0 });
  expect(JSON.parse(output())).toEqual(values);
});

test('multi-byte characters split across chunks are decoded intact', async () => {
  const script = 'process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 50)';
  const chunks: string[] = [];
  await exec({ command: NODE, args: ['-e', script], cwd: dir }, { onOutput: c => chunks.push(c), signal: new AbortController().signal });
  expect(chunks.join('')).toBe('é\n');
  expect(chunks.join('')).not.toContain('�');
});

test('a path with spaces and non-ASCII characters works as cwd', async () => {
  const cwd = path.join(dir, 'with space ção 日本');
  mkdirSync(cwd);
  const { promise, output } = run(['-e', 'console.log(process.cwd())'], { cwd });
  expect(await promise).toEqual({ code: 0 });
  expect(output().trim()).toBe(cwd);
});

test('stdin is closed: a process that reads stdin gets EOF instead of hanging', async () => {
  const script = 'let n = 0; process.stdin.on("data", d => { n += d.length; }); process.stdin.on("end", () => console.log("eof " + n)); process.stdin.resume()';
  const { promise, output } = run(['-e', script]);
  expect(await promise).toEqual({ code: 0 });
  expect(output().trim()).toBe('eof 0');
}, 2000);

test('abort kills the whole process tree', async () => {
  const pulse = path.join(dir, 'pulse.txt');
  const grandchild = path.join(dir, 'grandchild.js');
  const child = path.join(dir, 'child.js');
  writeFileSync(grandchild, [
    'const fs = require("fs");',
    'const f = process.argv[2];',
    'const beat = () => fs.writeFileSync(f, process.pid + " " + process.hrtime.bigint());',
    'beat();',
    'setInterval(beat, 100);',
  ].join('\n'));
  writeFileSync(child, [
    'const { spawn } = require("child_process");',
    `spawn(process.execPath, [${JSON.stringify(grandchild)}, ${JSON.stringify(pulse)}], { stdio: "ignore" });`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));

  const controller = new AbortController();
  const { promise } = run([child], { signal: controller.signal });
  await until(() => existsSync(pulse) && readFileSync(pulse, 'utf8').includes(' '));
  leftoverPids.push(Number(readFileSync(pulse, 'utf8').split(' ')[0]));

  controller.abort();
  const r = await promise;
  expect(r.code).not.toBe(0);

  await sleep(150);
  const before = readFileSync(pulse, 'utf8');
  await sleep(350);
  expect(readFileSync(pulse, 'utf8')).toBe(before);
});

test('an abort before the start spawns nothing and resolves', async () => {
  const marker = path.join(dir, 'ran.txt');
  const controller = new AbortController();
  controller.abort();
  const { promise } = run(['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { signal: controller.signal });
  expect(await promise).toEqual({ code: null });
  await sleep(100);
  expect(existsSync(marker)).toBe(false);
});

test('a command that does not exist rejects with a spawn error', async () => {
  await expect(exec(
    { command: 'ct-no-such-command-for-sure', args: [], cwd: dir },
    { onOutput: () => {}, signal: new AbortController().signal },
  )).rejects.toMatchObject({ code: 'ENOENT' });
});

test('shell: true runs a full command line', async () => {
  let out = '';
  const r = await exec(
    { command: `"${NODE}" -e "console.log(6 * 7)" && "${NODE}" -e "console.log('second')"`, args: [], cwd: dir, shell: true },
    { onOutput: c => { out += c; }, signal: new AbortController().signal },
  );
  expect(r).toEqual({ code: 0 });
  expect(out.split(/\r?\n/).filter(Boolean)).toEqual(['42', 'second']);
});

test('quoteForCmd quotes and escapes arguments for cmd.exe', () => {
  expect(quoteForCmd('plain', false)).toBe('^"plain^"');
  expect(quoteForCmd('a b', false)).toBe('^"a^ b^"');
  expect(quoteForCmd('c"d', false)).toBe('^"c\\^"d^"');
  expect(quoteForCmd('x\\', false)).toBe('^"x\\\\^"');
  expect(quoteForCmd('a&b', false)).toBe('^"a^&b^"');
  expect(quoteForCmd('a&b', true)).toBe('^^^"a^^^&b^^^"');
});

test('cmdCommandLine normalizes the command to backslashes and quotes the arguments', () => {
  expect(cmdCommandLine('node_modules/.bin/jest.cmd', ['--coverage', 'a b'])).toBe('node_modules\\.bin\\jest.cmd ^^^"--coverage^^^" ^^^"a^^^ b^^^"');
  expect(cmdCommandLine('C:/Program Files/nodejs/npm.cmd', ['test'])).toBe('C:\\Program^ Files\\nodejs\\npm.cmd ^"test^"');
  expect(cmdCommandLine('yarn', ['jest', 'x&y'])).toBe('yarn ^"jest^" ^"x^&y^"');
});

test('a grandchild that keeps the output pipe open does not keep exec waiting after its parent exits', async () => {
  const script = [
    'const { spawn } = require("child_process");',
    'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: ["ignore", "inherit", "inherit"] });',
    'console.log("grandchild " + g.pid);',
    'g.unref();',
  ].join('\n');
  const started = Date.now();
  const { promise, output } = run(['-e', script]);
  const r = await promise;
  const elapsed = Date.now() - started;
  const pid = Number(/grandchild (\d+)/.exec(output())?.[1]);
  if (pid) leftoverPids.push(pid);
  expect(r).toEqual({ code: 0 });
  expect(pid).toBeGreaterThan(0);
  expect(elapsed).toBeLessThan(1500);
});

test.skipIf(process.platform === 'win32')('a process that ignores SIGTERM is killed with SIGKILL after the grace period', async () => {
  const controller = new AbortController();
  let out = '';
  const promise = exec(
    { command: NODE, args: ['-e', 'process.on("SIGTERM", () => console.log("ignored")); console.log("ready"); setInterval(() => {}, 1000)'], cwd: dir },
    { onOutput: c => { out += c; }, signal: controller.signal, killGraceMs: 150 },
  );
  await until(() => out.includes('ready'));
  const abortedAt = Date.now();
  controller.abort();
  const r = await promise;
  expect(r).toEqual({ code: null });
  expect(out).toContain('ignored');
  expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(140);
  expect(Date.now() - abortedAt).toBeLessThan(1500);
});
