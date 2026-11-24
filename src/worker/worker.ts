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
  try {
    port.postMessage(response, transfer);
  } catch (e) {
    // A response that cannot be posted (e.g. DataCloneError) fails only its own request, not the worker.
    const message = `The parsed report could not be sent back: ${e instanceof Error ? e.message : String(e)}`;
    port.postMessage({ id: request.id, ok: false, kind: 'io', message } satisfies ParseResponse);
  }
});
