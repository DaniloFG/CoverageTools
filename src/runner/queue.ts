type Job = (signal: AbortSignal) => Promise<unknown>;

interface Entry {
  job: Job;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * Runs jobs one at a time, in the order they were enqueued.
 *
 * Cancellation contract: `cancelAll()` aborts the signal of the running job and empties the queue.
 * Queued jobs never start their work: each is invoked right away with an already-aborted signal, and
 * its promise settles with whatever the job returns for that signal (`runProject` returns `cancelled`
 * without doing anything). So every promise `enqueue` returned settles, and callers need no special case.
 */
export class RunQueue {
  private readonly queue: Entry[] = [];
  private readonly listeners = new Set<(busy: boolean) => void>();
  private current: AbortController | undefined;
  private running = false;

  get busy(): boolean {
    return this.running;
  }

  enqueue<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ job, resolve: resolve as (value: unknown) => void, reject });
      if (!this.running) {
        this.setBusy(true);
        void this.drain();
      }
    });
  }

  cancelAll(): void {
    this.current?.abort();
    const dropped = this.queue.splice(0);
    if (dropped.length === 0) return;
    const aborted = new AbortController();
    aborted.abort();
    for (const entry of dropped) invoke(entry, aborted.signal);
  }

  onDidChangeBusy(listener: (busy: boolean) => void): { dispose(): void } {
    const wrapped = (busy: boolean): void => listener(busy);
    this.listeners.add(wrapped);
    return { dispose: () => { this.listeners.delete(wrapped); } };
  }

  private async drain(): Promise<void> {
    for (let entry = this.queue.shift(); entry !== undefined; entry = this.queue.shift()) {
      const controller = new AbortController();
      this.current = controller;
      await invoke(entry, controller.signal);
      this.current = undefined;
    }
    this.setBusy(false);
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
