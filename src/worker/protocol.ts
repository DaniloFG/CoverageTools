import type { FileCoverageData } from '../model';
import { NotCoverageReportError, ReportParseError, type ParsedReport } from '../parsers/types';

export interface ParseRequest {
  id: number;
  reportPath: string;
  roots: readonly string[];
}

/** The client's go-ahead for the next message of request `id`, sent once it took in the previous one. */
export interface Ack {
  id: number;
  ack: true;
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

/**
 * The answer to one request, in several messages so that the main thread never deserializes a whole
 * large report at once: `files` messages with at most CHUNK_FILES files each, in report order, then
 * one `end`; or, at any point instead of what is left, one error. The worker sends the first
 * message at once and each further one only when the client acknowledges (`Ack`) the previous one,
 * which it does on a later turn of its event loop: a port delivers messages that are already
 * queued in one turn, so without the acknowledgements all chunks would be taken in as one block.
 */
export type ParseResponse =
  | { id: number; ok: true; part: 'files'; files: WireFile[] }
  | { id: number; ok: true; part: 'end'; signature: string; dropped: number }
  | { id: number; ok: false; kind: ErrorKind; message: string };

/** Files per `files` message. */
export const CHUNK_FILES = 250;

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

export function fromWireFile(f: WireFile): FileCoverageData {
  return {
    path: f.path,
    statements: new Uint32Array(f.statements),
    branches: new Uint32Array(f.branches),
    declarations: new Uint32Array(f.declarations),
    names: f.names,
  };
}

export function fromWire(report: WireReport): ParsedReport {
  return { files: report.files.map(fromWireFile), signature: report.signature, dropped: report.dropped };
}

/** The messages that answer request `id` with `report`, each with the buffers it moves. */
export function toResponses(id: number, report: ParsedReport, chunkFiles = CHUNK_FILES): Array<{ message: ParseResponse; transfer: ArrayBuffer[] }> {
  const out: Array<{ message: ParseResponse; transfer: ArrayBuffer[] }> = [];
  for (let i = 0; i < report.files.length; i += chunkFiles) {
    const wire = toWire({ files: report.files.slice(i, i + chunkFiles), signature: '', dropped: 0 });
    out.push({ message: { id, ok: true, part: 'files', files: wire.report.files }, transfer: wire.transfer });
  }
  out.push({ message: { id, ok: true, part: 'end', signature: report.signature, dropped: report.dropped }, transfer: [] });
  return out;
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
