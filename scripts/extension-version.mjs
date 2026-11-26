// Chooses the extension version the publish workflow releases.
//
// The Marketplace rejects a version that already exists. So that nobody has to remember to bump the number on
// every merge, CI derives the version from the repository's v<version> tags (each publication creates its tag
// when it attaches the release). A minor or major bump is still made by hand in package.json.
//
// Rule:
//  - no valid tag, or the file version is above the last tag: the file version;
//  - otherwise (equal or below): the last tag with its last number + 1 (0.12.0 becomes 0.12.1).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TAG = /^v\d+\.\d+\.\d+$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/** "0.10.0" or "v0.10.0" become [0, 10, 0]: versions compare number by number, not as text. */
function parts(version) {
  return version.replace(/^v/, '').split('.').map(Number);
}

/** Negative, zero or positive, like a `sort` comparator. */
function compare(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * The version to publish, given the one in package.json and the repository's tag names.
 * Tags that are not `v<x>.<y>.<z>` are ignored.
 * @param {string} fileVersion
 * @param {string[]} [tags]
 * @returns {string}
 */
export function nextExtensionVersion(fileVersion, tags = []) {
  if (typeof fileVersion !== 'string' || !VERSION.test(fileVersion)) {
    throw new Error(`Invalid package.json version: "${fileVersion}" (expected x.y.z, e.g. 0.3.0).`);
  }

  const validTags = tags.filter((tag) => typeof tag === 'string' && TAG.test(tag));
  if (validTags.length === 0) return fileVersion;

  // The highest valid tag, compared by number.
  const last = validTags.reduce((max, tag) => (compare(tag, max) > 0 ? tag : max)).replace(/^v/, '');

  // File version above the last tag: bumped by hand (minor or major).
  if (compare(fileVersion, last) > 0) return fileVersion;

  // Equal or below: publish the next patch of the last tag.
  const [major, minor, patch] = parts(last);
  return `${major}.${minor}.${patch + 1}`;
}

/** CI entry point: reads the file version and the tags, and prints only the chosen version. */
function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // Needs a checkout with fetch-depth: 0; without it the tags are missing and the automatic version is wrong.
  const output = execFileSync('git', ['tag', '-l', 'v*'], { cwd: root, encoding: 'utf8' });
  const tags = output.split('\n').map((line) => line.trim()).filter(Boolean);
  process.stdout.write(`${nextExtensionVersion(pkg.version, tags)}\n`);
}

// Runs only when executed directly (node scripts/extension-version.mjs), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
