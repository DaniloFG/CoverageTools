import { Worker } from 'node:worker_threads';
import type { FileCoverageData } from '../model';
import type { ParsedReport } from '../parsers/types';
import { errorOf, fromWireFile, type ParseRequest, type ParseResponse } from './protocol';

/** A thrown value as text; a worker can throw anything, not only an Error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Pending {
  worker: Worker;
  /** The files received so far, in report order. */
  files: FileCoverageData[];
  resolve(report: ParsedReport): void;
  reject(error: Error): void;
}

/**
 * Parses coverage reports in a worker thread. The worker is started by the first request and
 * terminated as soon as no request is pending; there is no idle timer. A report arrives in several
 * messages (see `ParseResponse`); `parse` resolves once, with all of it.
 */
export class ParserClient {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  /** Workers that were told to stop and have not exited yet. */
  private readonly stopping = new Set<Promise<unknown>>();
  private nextId = 1;
  private disposed = false;
  private started = 0;

  constructor(private readonly workerFile: string) {}

  /** Whether a worker is live (for tests). */
  get running(): boolean {
    return this.worker !== undefined;
  }

  /** How many workers this client has started (for tests). */
  get startedWorkers(): number {
    return this.started;
  }

  /** Resolves once every worker this client stopped has exited (for tests). */
  async idle(): Promise<void> {
    while (this.stopping.size > 0) await Promise.all(this.stopping);
  }

  parse(reportPath: string, roots: readonly string[]): Promise<ParsedReport> {
    if (this.disposed) return Promise.reject(new Error('The coverage parser was disposed'));
    const worker = this.worker ?? this.start();
    const id = this.nextId++;
    return new Promise<ParsedReport>((resolve, reject) => {
      this.pending.set(id, { worker, files: [], resolve, reject });
      const request: ParseRequest = { id, reportPath, roots: [...roots] };
      try {
        worker.postMessage(request);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
        if (this.pending.size === 0 && this.worker === worker) this.stop(worker);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.worker !== undefined) this.stop(this.worker);
    this.rejectAll(() => true, new Error('The coverage parser was disposed'));
  }

  private start(): Worker {
    const worker = new Worker(this.workerFile);
    this.started++;
    this.worker = worker;
    worker.on('message', (response: ParseResponse) => this.onResponse(response));
    worker.on('error', (error: unknown) => this.onDeath(worker, `The coverage parser worker crashed: ${describe(error)}`));
    worker.on('messageerror', (error: unknown) => this.onDeath(worker, `The coverage parser worker sent an unreadable message: ${describe(error)}`));
    worker.on('exit', code => this.onDeath(worker, `The coverage parser worker exited unexpectedly (code ${code})`));
    return worker;
  }

  private onResponse(response: ParseResponse): void {
    const entry = this.pending.get(response.id);
    if (entry === undefined) return; // A request already rejected (or disposed): the rest of its answer is dropped.
    if (response.ok && response.part === 'files') {
      for (const f of response.files) entry.files.push(fromWireFile(f));
      return;
    }
    this.pending.delete(response.id);
    if (response.ok) entry.resolve({ files: entry.files, signature: response.signature, dropped: response.dropped });
    else entry.reject(errorOf(response.kind, response.message));
    if (this.pending.size === 0 && this.worker !== undefined) this.stop(this.worker);
  }

  /** Rejects what the dead worker still owed; the next request starts a fresh worker. */
  private onDeath(worker: Worker, message: string): void {
    if (this.worker === worker) this.stop(worker);
    this.rejectAll(entry => entry.worker === worker, new Error(message));
  }

  /** Detaches the worker at once, so that a request made while it terminates starts a new one. */
  private stop(worker: Worker): void {
    if (this.worker === worker) this.worker = undefined;
    const exited = worker.terminate().catch(() => undefined);
    this.stopping.add(exited);
    void exited.then(() => this.stopping.delete(exited));
  }

  private rejectAll(match: (entry: Pending) => boolean, error: Error): void {
    for (const [id, entry] of this.pending) {
      if (!match(entry)) continue;
      this.pending.delete(id);
      entry.reject(error);
    }
  }
}
