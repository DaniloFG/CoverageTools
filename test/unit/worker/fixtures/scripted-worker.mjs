// A worker that answers with scripted message sequences, to test the client's side of the chunked
// protocol. The request's path names the script:
//   chunks:<n>     n `files` messages of one file each (/w/<n>-<i>.js), then `end`
//   slow:<n>       the same, one message every 5 ms (so that two requests interleave)
//   fail-mid       one `files` message, then a parse error
//   die-mid        one `files` message, then the worker crashes
import { parentPort } from 'node:worker_threads';

const file = (name) => {
  const statements = new Uint32Array([1, 0, 0, 0, 1]);
  return { path: `/w/${name}.js`, statements: statements.buffer, branches: new ArrayBuffer(0), declarations: new ArrayBuffer(0), names: [] };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

parentPort.on('message', async ({ id, reportPath }) => {
  const [script, arg] = reportPath.split(':');
  if (script === 'chunks' || script === 'slow') {
    for (let i = 0; i < Number(arg); i++) {
      if (script === 'slow') await sleep(5);
      const f = file(`${arg}-${i}`);
      parentPort.postMessage({ id, ok: true, part: 'files', files: [f] }, [f.statements]);
    }
    if (script === 'slow') await sleep(5);
    parentPort.postMessage({ id, ok: true, part: 'end', signature: `sig-${arg}`, dropped: 1 });
  } else if (script === 'fail-mid') {
    parentPort.postMessage({ id, ok: true, part: 'files', files: [file('x')] });
    parentPort.postMessage({ id, ok: false, kind: 'parse', message: 'broken in the middle' });
  } else if (script === 'die-mid') {
    parentPort.postMessage({ id, ok: true, part: 'files', files: [file('x')] });
    setTimeout(() => { throw new Error('simulated crash mid-stream'); }, 5);
  }
});
