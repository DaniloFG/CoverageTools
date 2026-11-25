import { parentPort } from 'node:worker_threads';
import { loadReport } from '../parsers/load';
import { errorKindOf, toResponses, type ParseRequest, type ParseResponse } from './protocol';

const port = parentPort;
if (port === null) throw new Error('The coverage parser must run in a worker thread');

port.on('message', (request: ParseRequest) => {
  let responses: ReturnType<typeof toResponses>;
  try {
    responses = toResponses(request.id, loadReport(request.reportPath, request.roots));
  } catch (e) {
    port.postMessage({ id: request.id, ok: false, kind: errorKindOf(e), message: e instanceof Error ? e.message : String(e) } satisfies ParseResponse);
    return;
  }
  for (const { message, transfer } of responses) {
    try {
      port.postMessage(message, transfer);
    } catch (e) {
      // A message that cannot be posted (e.g. DataCloneError) fails only its own request, not the worker;
      // what was already sent is discarded by the client.
      const text = `The parsed report could not be sent back: ${e instanceof Error ? e.message : String(e)}`;
      port.postMessage({ id: request.id, ok: false, kind: 'io', message: text } satisfies ParseResponse);
      return;
    }
  }
});
