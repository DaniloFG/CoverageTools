import type { Timers } from '../watcher/batcher';

/** How long the watcher keeps ignoring a project after a run of ours released it. */
export const SUPPRESSION_TAIL_MS = 2_000;

interface Entry {
  active: number;
  tail?: unknown;
}

/**
 * The projects the report watcher must ignore: those an extension run is working on, and those
 * released less than `SUPPRESSION_TAIL_MS` ago (a tool may still be writing). A timer exists only
 * during a tail.
 */
export class RunSuppressions {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly timers: Timers) {}

  suppress(key: string): { release(): void } {
    let entry = this.entries.get(key);
    if (entry === undefined) this.entries.set(key, (entry = { active: 0 }));
    if (entry.tail !== undefined) {
      this.timers.clear(entry.tail);
      entry.tail = undefined;
    }
    entry.active++;
    const e = entry;
    let released = false;
    return {
      release: () => {
        if (released || this.entries.get(key) !== e) return;
        released = true;
        if (--e.active > 0) return;
        e.tail = this.timers.set(() => {
          if (this.entries.get(key) === e && e.active === 0) this.entries.delete(key);
        }, SUPPRESSION_TAIL_MS);
      },
    };
  }

  isSuppressed(key: string): boolean {
    return this.entries.has(key);
  }

  dispose(): void {
    for (const entry of this.entries.values()) if (entry.tail !== undefined) this.timers.clear(entry.tail);
    this.entries.clear();
  }
}
