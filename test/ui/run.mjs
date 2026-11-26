// Runs the UI tests (test/ui/**/*.ui.test.ts) one file at a time against a real VS Code.
// On Linux without a display, run it under `xvfb-run -a`. Extra arguments are test file filters.
import { startVitest } from 'vitest/node';

const vitest = await startVitest('test', process.argv.slice(2), { project: ['ui'], run: true, watch: false });
await vitest.close();
