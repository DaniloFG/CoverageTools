// Writes the body of the GitHub release from CHANGELOG.md.
//
//   node scripts/release-notes.mjs <version> <output file> <neutral|strict>
//
// The body is the `## [<version>]` section when the changelog has one; otherwise (the automatic patch the
// workflow publishes on a merge has no section of its own) it is the `### Done` list under `## [Unreleased]`.
// With nothing to say, `neutral` (used only for a branch push) writes a fixed maintenance note and `strict`
// fails, so a tag or a manual run never ships a release without text.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION = /^\d+\.\d+\.\d+$/;

/** The note of a release with no user-visible change. */
export const NEUTRAL_NOTE = 'Maintenance release.';

/** Lines of the block that starts after the heading matched by `isStart` and ends at the first line matching `isEnd`. */
function block(lines, isStart, isEnd) {
  const start = lines.findIndex(isStart);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isEnd(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

/** Title inside `## [title]`, or null when the line is not a version-level heading. */
function sectionTitle(line) {
  return /^##\s+\[([^\]]+)\]/.exec(line)?.[1] ?? null;
}

/** Whether the text has at least one bullet that says something ("Nothing yet." is the empty marker). */
function hasContent(lines) {
  return lines.some((line) => {
    const bullet = /^\s*[-*+]\s+(.*\S)\s*$/.exec(line)?.[1];
    return bullet !== undefined && !/^nothing yet\.?$/i.test(bullet);
  });
}

/**
 * The release body for `version`, trimmed. Throws when there is nothing to say, unless `allowNeutral` is set
 * and the changelog has no section of the version (then it returns NEUTRAL_NOTE). A section of the version
 * that exists but is empty is always an error.
 * @param {string} changelog
 * @param {string} version
 * @param {boolean} allowNeutral
 * @returns {string}
 */
export function releaseNotes(changelog, version, allowNeutral) {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`Invalid version: "${version}" (expected x.y.z, e.g. 0.3.0).`);
  }
  const lines = String(changelog).split(/\r?\n/);
  const isNextSection = (line) => /^##\s/.test(line);

  const own = block(lines, (line) => sectionTitle(line) === version, isNextSection);
  if (own !== null) {
    if (!hasContent(own)) {
      throw new Error(`The CHANGELOG section ## [${version}] lists no change: write what users get before publishing.`);
    }
    return own.join('\n').trim();
  }

  const unreleased = block(lines, (line) => sectionTitle(line) === 'Unreleased', isNextSection);
  const done =
    unreleased === null ? null : block(unreleased, (line) => /^###\s+Done\s*$/i.test(line), (line) => /^#{2,3}\s/.test(line));
  if (done !== null && hasContent(done)) return done.join('\n').trim();

  if (allowNeutral) return NEUTRAL_NOTE;
  throw new Error(
    `The CHANGELOG has nothing to say for ${version}: no ## [${version}] section and no Done item under ` +
      `## [Unreleased]. Write what users get before publishing.`,
  );
}

/** CI entry point: reads the root CHANGELOG.md and writes the release body to the output file. */
function main() {
  const [version, outputFile, mode] = process.argv.slice(2);
  if (!version || !outputFile || (mode !== 'neutral' && mode !== 'strict')) {
    throw new Error('Usage: node scripts/release-notes.mjs <version> <output file> <neutral|strict>');
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  writeFileSync(outputFile, `${releaseNotes(changelog, version, mode === 'neutral')}\n`);
}

// Runs only when executed directly, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
