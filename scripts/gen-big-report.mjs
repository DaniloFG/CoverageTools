// Generates a synthetic Cobertura report for the lightness tests (test/perf): N source files of M
// lines each, with branches and methods, plus the (empty) source files themselves, since the
// parsers keep only files that exist. Nothing here is committed: it is written to a directory the
// caller chooses (a temporary one in the tests).
//
//   node scripts/gen-big-report.mjs <output dir> [files=5000] [lines=200] [variant=0]
//
// Prints the report's path. A variant other than 0 writes the same files and lines with other hit
// counts (a second run over the same code, e.g. a partial run to union with the first).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Files per package (and per source directory). */
const FILES_PER_PACKAGE = 100;
/** Every n-th line is a branch line with two arms. */
const BRANCH_EVERY = 10;
/** Every n-th line starts a method. */
const METHOD_EVERY = 20;

/** The source file path of file `i`, relative to the report's source root. */
export function sourcePath(i) {
  return `src/pkg${String(Math.floor(i / FILES_PER_PACKAGE)).padStart(3, '0')}/file${String(i).padStart(5, '0')}.ts`;
}

/** Hits of line `line` of file `file`: deterministic, about one line in four uncovered. */
function hits(file, line, variant) {
  const h = (file * 31 + line * 17 + variant * 7) % 8;
  return h < 2 ? 0 : h;
}

/**
 * Writes `<dir>/coverage.xml` (variant 0) or `<dir>/coverage-<variant>.xml` and the source files
 * under `<dir>/src`. Returns the report path.
 */
export function generateBigReport(dir, { files = 5000, lines = 200, variant = 0 } = {}) {
  for (let p = 0; p * FILES_PER_PACKAGE < files; p++) mkdirSync(join(dir, `src/pkg${String(p).padStart(3, '0')}`), { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(join(dir, sourcePath(i)), '');

  const out = [];
  out.push('<?xml version="1.0" ?>\n<coverage line-rate="0.75" branch-rate="0.5" version="1.9" timestamp="1700000000">\n');
  out.push(`<sources><source>${dir}</source></sources>\n<packages>\n`);
  for (let p = 0; p * FILES_PER_PACKAGE < files; p++) {
    out.push(`<package name="pkg${p}" line-rate="0.75" branch-rate="0.5" complexity="0"><classes>\n`);
    for (let i = p * FILES_PER_PACKAGE; i < Math.min(files, (p + 1) * FILES_PER_PACKAGE); i++) {
      out.push(`<class name="File${i}" filename="${sourcePath(i)}" line-rate="0.75" branch-rate="0.5" complexity="0"><methods>\n`);
      for (let start = 1; start <= lines; start += METHOD_EVERY) {
        out.push(`<method name="fn${start}" signature="()" line-rate="1" branch-rate="1"><lines><line number="${start}" hits="${hits(i, start, variant)}"/></lines></method>\n`);
      }
      out.push('</methods><lines>\n');
      for (let line = 1; line <= lines; line++) {
        const h = hits(i, line, variant);
        if (line % BRANCH_EVERY === 0) {
          const covered = h === 0 ? 0 : h % 2 === 0 ? 2 : 1;
          out.push(`<line number="${line}" hits="${h}" branch="true" condition-coverage="${covered * 50}% (${covered}/2)"/>\n`);
        } else {
          out.push(`<line number="${line}" hits="${h}" branch="false"/>\n`);
        }
      }
      out.push('</lines></class>\n');
    }
    out.push('</classes></package>\n');
  }
  out.push('</packages>\n</coverage>\n');
  const report = join(dir, variant === 0 ? 'coverage.xml' : `coverage-${variant}.xml`);
  writeFileSync(report, out.join(''));
  return report;
}

// Runs only when executed directly, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, files, lines, variant] = process.argv.slice(2);
  if (!dir) {
    process.stderr.write('Usage: node scripts/gen-big-report.mjs <output dir> [files] [lines] [variant]\n');
    process.exitCode = 1;
  } else {
    const opts = { files: files ? Number(files) : undefined, lines: lines ? Number(lines) : undefined, variant: variant ? Number(variant) : undefined };
    process.stdout.write(`${generateBigReport(dir, opts)}\n`);
  }
}
