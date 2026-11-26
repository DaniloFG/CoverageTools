// The real built worker, except that a request for a path ending in "crash" throws an uncaught error
// instead of being handled, which kills the worker thread; requests after it are never answered.
import { parentPort } from 'node:worker_threads';

let crashed = false;
const on = parentPort.on.bind(parentPort);
parentPort.on = (event, listener) => on(event, event !== 'message' ? listener : (request) => {
  if (crashed) return;
  if (request.ack) return listener(request);
  if (request.reportPath.endsWith('crash')) {
    crashed = true;
    throw new Error('simulated worker crash');
  }
  if (request.reportPath.endsWith('crash-value')) {
    crashed = true;
    throw 42; // a thrown value that is not an Error
  }
  listener(request);
});
await import(new URL('../../../../dist/worker.js', import.meta.url).href);
