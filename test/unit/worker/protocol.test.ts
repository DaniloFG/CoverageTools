import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { FileBuilder } from '../../../src/model';
import { NotCoverageReportError, ReportParseError } from '../../../src/parsers/types';
import { errorKindOf, errorOf, fromWire, toWire, type WireReport } from '../../../src/worker/protocol';

function receive(port: MessagePort): Promise<WireReport> {
  return new Promise(resolve => port.once('message', resolve));
}

test('toWire buffers are moved through a MessagePort, not copied', async () => {
  const b = new FileBuilder('/w/a.js');
  b.addLine(1, 3);
  b.addLine(2, 0);
  b.addBranch(1, 0, 0, 1);
  b.addDeclaration('f', 1, 0, 2, 5, 4);
  const file = b.build();
  const { report, transfer } = toWire({ files: [file], signature: 's', dropped: 2 });
  const sent = report.files[0];
  expect(transfer).toEqual(expect.arrayContaining([sent.statements, sent.branches, sent.declarations]));

  const { port1, port2 } = new MessageChannel();
  try {
    const received = receive(port2);
    port1.postMessage(report, transfer);
    expect(sent.statements.byteLength).toBe(0);
    expect(sent.branches.byteLength).toBe(0);
    expect(sent.declarations.byteLength).toBe(0);

    const back = fromWire(await received);
    expect(back.signature).toBe('s');
    expect(back.dropped).toBe(2);
    const f = back.files[0];
    expect(f.statements).toBeInstanceOf(Uint32Array);
    expect(Array.from(f.statements)).toEqual([1, 0, 0, 0, 3, 2, 0, 0, 0, 0]);
    expect(Array.from(f.branches)).toEqual([1, 0, 0, 1]);
    expect(Array.from(f.declarations)).toEqual([1, 0, 2, 5, 4, 0]);
    expect(f.names).toEqual(['f']);
  } finally {
    port1.close();
    port2.close();
  }
});

test('toWire copies a view that does not cover its whole buffer, leaving the source intact', () => {
  const backing = new Uint32Array([9, 1, 0, 0, 0, 3, 9]);
  const view = backing.subarray(1, 6);
  const { report, transfer } = toWire({ files: [{ path: '/w/a.js', statements: view, branches: new Uint32Array(0), declarations: new Uint32Array(0), names: [] }], signature: '', dropped: 0 });
  expect(new Set(transfer).size).toBe(transfer.length);
  expect(transfer).not.toContain(backing.buffer);
  expect(Array.from(new Uint32Array(report.files[0].statements))).toEqual([1, 0, 0, 0, 3]);
});

test('error kinds round-trip to their classes', () => {
  expect(errorOf(errorKindOf(new ReportParseError('a')), 'a')).toBeInstanceOf(ReportParseError);
  expect(errorOf(errorKindOf(new NotCoverageReportError('b')), 'b')).toBeInstanceOf(NotCoverageReportError);
  const io = errorOf(errorKindOf(new Error('c')), 'c');
  expect(io).toBeInstanceOf(Error);
  expect(io).not.toBeInstanceOf(ReportParseError);
  expect(io).not.toBeInstanceOf(NotCoverageReportError);
});
