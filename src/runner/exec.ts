import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { CommandSpec } from '../adapters/types';

const IS_WINDOWS = process.platform === 'win32';
/** After SIGTERM, how long the process group gets before SIGKILL. */
const KILL_GRACE_MS = 3000;
/** After the process exits, how long output still held by its streams is awaited. */
const DRAIN_MS = 200;

/** Characters cmd.exe treats specially (same set as cross-spawn). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** Node package-manager shims that only exist as .cmd files on Windows. */
const CMD_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn']);

/**
 * Quotes one argument for a `cmd.exe /d /s /c "..."` command line: first for the program's own
 * argument parser (CommandLineToArgvW rules), then with carets for cmd.exe. `doubleEscape` adds
 * a second caret layer for shims in node_modules/.bin, whose `%*` is expanded by cmd.exe again.
 */
export function quoteForCmd(arg: string, doubleEscape: boolean): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`.replace(CMD_META, '^$1');
  return doubleEscape ? quoted.replace(CMD_META, '^$1') : quoted;
}

function needsCmd(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat') || CMD_SHIMS.has(lower);
}

function start(spec: CommandSpec): ChildProcess {
  const options = {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    detached: !IS_WINDOWS,
    windowsHide: true,
  };
  if (spec.shell) return spawn(spec.command, [], { ...options, shell: true });
  if (IS_WINDOWS && needsCmd(spec.command)) {
    const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(spec.command);
    const line = [spec.command.replace(CMD_META, '^$1'), ...spec.args.map(a => quoteForCmd(a, doubleEscape))].join(' ');
    return spawn(process.env.comspec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true });
  }
  return spawn(spec.command, [...spec.args], options);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Runs one command with stdin closed, streaming stdout and stderr (decoded as UTF-8) to `onOutput`.
 * Resolves with the exit code once the process exits (null when it was killed by a signal), also
 * after an abort; rejects only when the process could not be started (ENOENT and the like).
 * An abort kills the whole process tree: on POSIX the process runs in its own group, which gets
 * SIGTERM and, if it is still alive 3 s later, SIGKILL; on Windows `taskkill /T /F` is used.
 */
export function exec(spec: CommandSpec, opts: { onOutput(chunk: string): void; signal: AbortSignal }): Promise<{ code: number | null }> {
  if (opts.signal.aborted) return Promise.resolve({ code: null });
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = start(spec);
    } catch (e) {
      reject(e);
      return;
    }
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let killed = false;
    let settled = false;
    let exitCode: number | null | undefined;
    let openStreams = 2;

    const kill = (): void => {
      const pid = child.pid;
      if (killed || pid === undefined || exitCode !== undefined) return;
      killed = true;
      if (IS_WINDOWS) {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
      } else {
        signalGroup(pid, 'SIGTERM');
        killTimer = setTimeout(() => signalGroup(pid, 'SIGKILL'), KILL_GRACE_MS);
      }
    };
    opts.signal.addEventListener('abort', kill, { once: true });

    const finish = (): void => {
      if (settled || exitCode === undefined) return;
      settled = true;
      clearTimeout(drainTimer);
      opts.signal.removeEventListener('abort', kill);
      resolve({ code: exitCode });
    };

    for (const stream of [child.stdout!, child.stderr!]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (data: Buffer) => {
        const text = decoder.write(data);
        if (text) opts.onOutput(text);
      });
      stream.on('close', () => {
        const rest = decoder.end();
        if (rest) opts.onOutput(rest);
        if (--openStreams === 0) finish();
      });
    }

    child.on('error', error => {
      if (child.pid !== undefined) return; // A failed kill or the like on a running process.
      settled = true;
      opts.signal.removeEventListener('abort', kill);
      reject(error);
    });

    child.on('exit', code => {
      exitCode = code;
      clearTimeout(killTimer);
      // A process that ignored SIGTERM is gone, but what is left of its group is killed at once
      // instead of later, so that no timer outlives the process.
      if (killed && !IS_WINDOWS && child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
      if (openStreams === 0) {
        finish();
      } else {
        // A descendant may still hold the output pipes (a build server, for instance); give the
        // streams a moment to drain, then stop waiting for them.
        drainTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish();
        }, DRAIN_MS);
      }
    });
  });
}
