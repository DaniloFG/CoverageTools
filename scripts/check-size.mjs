import { existsSync, statSync } from 'node:fs';

const LIMIT_BYTES = 204_800;
const files = ['dist/extension.js', 'dist/worker.js'];

if (!existsSync(files[0])) {
  console.error(`${files[0]} not found; run "npm run build" first.`);
  process.exit(1);
}

let total = 0;
for (const file of files) {
  if (existsSync(file)) {
    const size = statSync(file).size;
    total += size;
    console.log(`${file}: ${size} bytes`);
  }
}

console.log(`total: ${total} bytes (limit ${LIMIT_BYTES})`);
if (total > LIMIT_BYTES) {
  console.error(`Bundle size ${total} bytes exceeds the limit of ${LIMIT_BYTES} bytes.`);
  process.exit(1);
}
