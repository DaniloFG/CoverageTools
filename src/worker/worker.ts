import { parentPort } from 'node:worker_threads';
import { loadReport } from '../parsers/load';
import { errorKindOf, toResponses, type Ack, type ParseRequest, type ParseResponse } from './protocol';

const port = parentPort;
if (port === null) throw new Error('The coverage parser must run in a worker thread');

/** The messages still to send for each request, one per acknowledgement of the client. */
const remaining = new Map<number, ReturnType<typeof toResponses>>();

function sendNext(id: number): void {
  const queue = remaining.get(id);
  const next = queue?.shift();
  if (queue === undefined || next === undefined) {
    remaining.delete(id);
    return;
  }
  if (queue.length === 0) remaining.delete(id);
  try {
    port!.postMessage(next.message, next.transfer);
  } catch (e) {
    // A message that cannot be posted (e.g. DataCloneError) fails only its own request, not the worker;
    // what was already sent is discarded by the client.
    remaining.delete(id);
    const text = `The parsed report could not be sent back: ${e instanceof Error ? e.message : String(e)}`;
    port!.postMessage({ id, ok: false, kind: 'io', message: text } satisfies ParseResponse);
  }
}

port.on('message', (request: ParseRequest | Ack) => {
  if ('ack' in request) {
    sendNext(request.id);
    return;
  }
  try {
    remaining.set(request.id, toResponses(request.id, loadReport(request.reportPath, request.roots)));
  } catch (e) {
    port.postMessage({ id: request.id, ok: false, kind: errorKindOf(e), message: e instanceof Error ? e.message : String(e) } satisfies ParseResponse);
    return;
  }
  sendNext(request.id);
});
