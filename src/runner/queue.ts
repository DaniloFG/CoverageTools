type Job = (signal: AbortSignal) => Promise<unknown>;

interface Entry {
  job: Job;
  exclusive: string | undefined;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** Decides whether jobs may run at the same time. Without one the queue runs one job at a time. */
export interface Admission {
  /** The queue was idle and its first job is about to start. */
  begin?(): void;
  /** Whether one more job may start next to the `running` (1 or more) ones. Asked again as each job ends. */
  more(running: number): boolean;
}

/**
 * Runs jobs in the order they were enqueued: one at a time, or several at once when the admission
 * allows it. A job always starts when nothing else runs. Jobs given the same `exclusive` key never
 * run at the same time; a later job with another key may start in the meantime.
 *
 * Cancellation contract: `cancelAll()` aborts the signal of every running job and empties the queue.
 * Queued jobs never start their work: each is invoked right away with an already-aborted signal, and
 * its promise settles with whatever the job returns for that signal (`runProject` returns `cancelled`
 * without doing anything). So every promise `enqueue` returned settles, and callers need no special case.
 */
export class RunQueue {
  private readonly queue: Entry[] = [];
  private readonly listeners = new Set<(busy: boolean) => void>();
  private readonly active = new Map<AbortController, string | undefined>();
  private running = false;

  constructor(private readonly admission?: Admission) {}

  get busy(): boolean {
    return this.running;
  }

  enqueue<T>(job: (signal: AbortSignal) => Promise<T>, exclusive?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ job, exclusive, resolve: resolve as (value: unknown) => void, reject });
      if (!this.running) {
        this.setBusy(true);
        try {
          this.admission?.begin?.();
        } catch {
          // A failing admission must not stop the queue.
        }
      }
      this.pump();
    });
  }

  cancelAll(): void {
    for (const controller of this.active.keys()) controller.abort();
    const dropped = this.queue.splice(0);
    if (dropped.length === 0) return;
    const aborted = new AbortController();
    aborted.abort();
    for (const entry of dropped) void invoke(entry, aborted.signal);
  }

  onDidChangeBusy(listener: (busy: boolean) => void): { dispose(): void } {
    const wrapped = (busy: boolean): void => listener(busy);
    this.listeners.add(wrapped);
    return { dispose: () => { this.listeners.delete(wrapped); } };
  }

  /** Starts every queued job that may start now. */
  private pump(): void {
    for (let i = this.nextIndex(); i >= 0; i = this.nextIndex()) {
      const [entry] = this.queue.splice(i, 1);
      const controller = new AbortController();
      this.active.set(controller, entry.exclusive);
      void invoke(entry, controller.signal).then(() => {
        this.active.delete(controller);
        this.pump();
        if (this.active.size === 0 && this.queue.length === 0) this.setBusy(false);
      });
    }
  }

  /** The first queued job that may start now, or -1. */
  private nextIndex(): number {
    if (this.queue.length === 0) return -1;
    if (this.active.size === 0) return 0;
    let admitted = false;
    try {
      admitted = this.admission?.more(this.active.size) === true;
    } catch {
      // A failing admission means one job at a time.
    }
    if (!admitted) return -1;
    const held = new Set(this.active.values());
    return this.queue.findIndex(e => e.exclusive === undefined || !held.has(e.exclusive));
  }

  private setBusy(busy: boolean): void {
    if (this.running === busy) return;
    this.running = busy;
    for (const listener of [...this.listeners]) {
      try {
        listener(busy);
      } catch {
        // A failing listener must not stop the others or the queue.
      }
    }
  }
}

/** Runs one job and settles its promise; never rejects itself. */
async function invoke(entry: Entry, signal: AbortSignal): Promise<void> {
  try {
    entry.resolve(await entry.job(signal));
  } catch (e) {
    entry.reject(e);
  }
}
