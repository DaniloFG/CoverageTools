import { existsSync } from 'node:fs';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');

const entries = [
  { in: 'src/extension.ts', out: 'extension' },
  { in: 'src/worker/worker.ts', out: 'worker' },
].filter((entry) => existsSync(entry.in));

await esbuild.build({
  entryPoints: entries,
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  logLevel: 'warning',
});
