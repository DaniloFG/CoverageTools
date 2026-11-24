import type { FileCoverageData } from '../model';
import { NotCoverageReportError, ReportParseError, type ParsedReport } from '../parsers/types';

export interface ParseRequest {
  id: number;
  reportPath: string;
  roots: readonly string[];
}

/** A file as it crosses the thread boundary: each array's buffer is transferred, not copied. */
export interface WireFile {
  path: string;
  statements: ArrayBuffer;
  branches: ArrayBuffer;
  declarations: ArrayBuffer;
  names: string[];
}

export interface WireReport {
  files: WireFile[];
  signature: string;
  dropped: number;
}

export type ErrorKind = 'parse' | 'not-coverage' | 'io';

export type ParseResponse =
  | { id: number; ok: true; report: WireReport }
  | { id: number; ok: false; kind: ErrorKind; message: string };

/** A buffer holding exactly the array's elements, so that transferring it moves nothing else. */
function ownBuffer(a: Uint32Array): ArrayBuffer {
  const exact = a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && a.buffer instanceof ArrayBuffer;
  return (exact ? a : a.slice()).buffer as ArrayBuffer;
}

/** Converts a report for posting; `transfer` lists the buffers to move with it. */
export function toWire(report: ParsedReport): { report: WireReport; transfer: ArrayBuffer[] } {
  const transfer = new Set<ArrayBuffer>();
  const files = report.files.map((f): WireFile => {
    const wire = {
      path: f.path,
      statements: ownBuffer(f.statements),
      branches: ownBuffer(f.branches),
      declarations: ownBuffer(f.declarations),
      names: [...f.names],
    };
    transfer.add(wire.statements).add(wire.branches).add(wire.declarations);
    return wire;
  });
  return { report: { files, signature: report.signature, dropped: report.dropped }, transfer: [...transfer] };
}

export function fromWire(report: WireReport): ParsedReport {
  const files = report.files.map((f): FileCoverageData => ({
    path: f.path,
    statements: new Uint32Array(f.statements),
    branches: new Uint32Array(f.branches),
    declarations: new Uint32Array(f.declarations),
    names: f.names,
  }));
  return { files, signature: report.signature, dropped: report.dropped };
}

export function errorKindOf(e: unknown): ErrorKind {
  if (e instanceof ReportParseError) return 'parse';
  if (e instanceof NotCoverageReportError) return 'not-coverage';
  return 'io';
}

/** Rebuilds the error class that the worker reported. */
export function errorOf(kind: ErrorKind, message: string): Error {
  switch (kind) {
    case 'parse':
      return new ReportParseError(message);
    case 'not-coverage':
      return new NotCoverageReportError(message);
    case 'io':
      return new Error(message);
  }
}
