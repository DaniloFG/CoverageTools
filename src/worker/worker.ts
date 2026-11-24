import { parentPort } from 'node:worker_threads';
import { loadReport } from '../parsers/load';
import { errorKindOf, toWire, type ParseRequest, type ParseResponse } from './protocol';

const port = parentPort;
if (port === null) throw new Error('The coverage parser must run in a worker thread');

port.on('message', (request: ParseRequest) => {
  let response: ParseResponse;
  let transfer: ArrayBuffer[] = [];
  try {
    const wire = toWire(loadReport(request.reportPath, request.roots));
    response = { id: request.id, ok: true, report: wire.report };
    transfer = wire.transfer;
  } catch (e) {
    response = { id: request.id, ok: false, kind: errorKindOf(e), message: e instanceof Error ? e.message : String(e) };
  }
  port.postMessage(response, transfer);
});
