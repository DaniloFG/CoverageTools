// Installs the dependencies of the sample projects under samples/, by convention:
//   yarn.lock → yarn install --frozen-lockfile; else package-lock.json → npm ci;
//   else pnpm-lock.yaml → pnpm install --frozen-lockfile (skipped when pnpm is absent);
//   requirements.txt → python3 -m venv .venv, then pip install -r requirements.txt into it;
//   *.sln / *.csproj (up to 3 levels deep) → dotnet restore on each solution, or on each project
//   when there is no solution (skipped when dotnet is absent).
// Usage: node scripts/setup-samples.mjs [sample-name...]   (default: every sample)
// Exits non-zero when a step fails.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';
const samplesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const SKIPPED_DIRS = new Set(['node_modules', '.venv', 'venv', 'bin', 'obj', '.git']);

function available(command) {
  const r = spawnSync(command, ['--version'], { stdio: 'ignore', shell: IS_WINDOWS });
  return r.status === 0;
}

let failed = false;

function run(command, args, cwd) {
  console.log(`[${path.relative(samplesRoot, cwd) || '.'}] ${command} ${args.join(' ')}`);
  const r = spawnSync(command, args, { cwd, stdio: 'inherit', shell: IS_WINDOWS });
  if (r.status !== 0) {
    console.error(`  failed (${r.error?.message ?? `exit code ${r.status}`})`);
    failed = true;
    return false;
  }
  return true;
}

/** Files under `dir` (up to `depth` levels below it) whose name satisfies `test`. */
function findFiles(dir, test, depth) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !SKIPPED_DIRS.has(entry.name)) out.push(...findFiles(full, test, depth - 1));
    } else if (entry.isFile() && test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

function setUp(dir) {
  const has = name => existsSync(path.join(dir, name));

  if (has('yarn.lock')) run('yarn', ['install', '--frozen-lockfile'], dir);
  else if (has('package-lock.json')) run('npm', ['ci'], dir);
  else if (has('pnpm-lock.yaml')) {
    if (available('pnpm')) run('pnpm', ['install', '--frozen-lockfile'], dir);
    else console.log(`[${path.basename(dir)}] pnpm is not installed; skipped`);
  }

  if (has('requirements.txt')) {
    if (run('python3', ['-m', 'venv', '.venv'], dir)) {
      const python = IS_WINDOWS ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');
      run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt'], dir);
    }
  }

  const solutions = findFiles(dir, n => n.endsWith('.sln'), 3);
  const projects = solutions.length > 0 ? solutions : findFiles(dir, n => n.endsWith('.csproj'), 3);
  if (projects.length > 0) {
    if (!available('dotnet')) {
      console.log(`[${path.basename(dir)}] dotnet is not installed; skipped`);
    } else {
      for (const p of projects) run('dotnet', ['restore', p], dir);
    }
  }
}

const requested = process.argv.slice(2);
const all = existsSync(samplesRoot)
  ? readdirSync(samplesRoot).filter(n => statSync(path.join(samplesRoot, n)).isDirectory()).sort()
  : [];
const names = requested.length > 0 ? requested : all;
for (const name of names) {
  if (!all.includes(name)) {
    console.error(`No sample named ${name} in ${samplesRoot}`);
    failed = true;
    continue;
  }
  setUp(path.join(samplesRoot, name));
}
process.exit(failed ? 1 : 0);
