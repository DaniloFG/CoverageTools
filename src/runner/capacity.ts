import type { RunSettings } from '../settings';

const GIB = 1024 ** 3;
/** The memory one test run is assumed to need (a test host or a few test workers, plus a build). */
export const MEMORY_PER_RUN = 1.5 * GIB;
/** With less free memory than this, no further run starts next to the ones running. */
export const MIN_FREE_MEMORY = GIB;
/** The most runs at a time the automatic limit ever allows. */
const MAX_AUTOMATIC = 4;

export interface Machine {
  cores: number;
  totalMemory: number;
  /** Memory a new process can get right now; undefined where the system gives no usable figure. */
  freeMemory: number | undefined;
}

interface OsLike {
  availableParallelism?(): number;
  cpus(): readonly unknown[];
  totalmem(): number;
  freemem(): number;
}

export function readMachine(os: OsLike, platform: string = process.platform): Machine {
  return {
    cores: os.availableParallelism?.() ?? os.cpus().length,
    totalMemory: os.totalmem(),
    // macOS reports only untouched pages as free, far less than what a process can get.
    freeMemory: platform === 'darwin' ? undefined : os.freemem(),
  };
}

/**
 * How many test runs fit on the machine at the same time. By cores: `configured` when it is set,
 * otherwise half the cores (a test run uses several by itself, and the editor needs the rest), at
 * most 4. By memory: one `MEMORY_PER_RUN` each out of what is free. The lower of the two, at least 1.
 */
export function parallelLimit(machine: Machine, configured: number): number {
  const byCores = configured >= 1 ? Math.floor(configured) : Math.min(MAX_AUTOMATIC, Math.floor(machine.cores / 2));
  const byMemory = Math.floor((machine.freeMemory ?? machine.totalMemory / 2) / MEMORY_PER_RUN);
  return Math.max(1, Math.min(byCores, byMemory));
}

const gb = (bytes: number): string => (bytes / GIB).toFixed(1);

function describe(m: Machine): string {
  const memory = m.freeMemory === undefined ? `${gb(m.totalMemory)} GB of memory installed` : `${gb(m.freeMemory)} GB of memory free`;
  return `${m.cores} cores, ${memory}`;
}

export interface GovernorDeps {
  settings(): RunSettings;
  machine(): Machine;
  log(msg: string): void;
}

/**
 * The run queue's admission. In sequential mode: one run at a time. In parallel mode: as many as
 * the machine has room for, measured when the queue leaves idle (before our own runs use it), and
 * no further run while free memory is short. A weak machine therefore runs in sequence in either mode.
 */
export class ParallelGovernor {
  /** Measured at the first question after the queue left idle; sequential runs never measure. */
  private limit: number | undefined;

  constructor(private readonly deps: GovernorDeps) {}

  begin(): void {
    this.limit = undefined;
  }

  more(running: number): boolean {
    const settings = this.deps.settings();
    if (settings.mode !== 'parallel') return false;
    let machine: Machine | undefined;
    if (this.limit === undefined) {
      machine = this.deps.machine();
      this.limit = parallelLimit(machine, settings.maxParallel);
      this.deps.log(this.limit > 1
        ? `Parallel runs: up to ${this.limit} at a time on this machine (${describe(machine)}).`
        : `Parallel runs are on, but this machine has room for one run at a time (${describe(machine)}): running in sequence.`);
    }
    if (running >= this.limit) return false;
    const free = (machine ?? this.deps.machine()).freeMemory;
    return free === undefined || free >= MIN_FREE_MEMORY;
  }
}
