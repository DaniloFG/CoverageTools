import { FileBuilder } from '../model';
import { resolveReportPath } from './paths';
import type { ParseContext, ParsedReport } from './types';

/**
 * Collects one FileBuilder per resolved source file while a report is parsed: resolves each raw
 * report path once, merges entries that resolve to the same file and counts the distinct raw paths
 * that resolve to no existing file.
 */
export class FileCollector {
  private readonly builders = new Map<string, FileBuilder>();
  private readonly resolved = new Map<string, string | undefined>();
  private readonly unresolved = new Set<string>();

  constructor(private readonly ctx: ParseContext) {}

  /** The builder for a raw report path, or undefined when it resolves to no existing file. */
  builderFor(raw: string, sources: readonly string[] = []): FileBuilder | undefined {
    let path = this.resolved.get(raw);
    if (path === undefined && !this.resolved.has(raw)) {
      path = resolveReportPath(raw, sources, this.ctx);
      this.resolved.set(raw, path);
    }
    if (path === undefined) {
      this.unresolved.add(raw);
      return undefined;
    }
    let builder = this.builders.get(path);
    if (builder === undefined) this.builders.set(path, (builder = new FileBuilder(path)));
    return builder;
  }

  /** Builds every file, sorted by path. */
  finish(signature: string): ParsedReport {
    return {
      files: [...this.builders.keys()].sort().map(p => this.builders.get(p)!.build()),
      signature,
      dropped: this.unresolved.size,
    };
  }
}
