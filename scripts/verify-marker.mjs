import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const forbiddenMarkers = [
  [0x67, 0x70, 0x74],
  [0x6f, 0x70, 0x65, 0x6e, 0x61, 0x69],
  [0x63, 0x6f, 0x64, 0x65, 0x78],
];

function containsNeedle(bytes, needle) {
  for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      const byte = bytes[index + offset];
      const folded = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
      if (folded !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function containsMarker(bytes) {
  return forbiddenMarkers.some((needle) => containsNeedle(bytes, needle));
}

function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'buffer',
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.toString() || 'Could not list tracked files.',
    );
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function filesBelow(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(path));
    else if (entry.isFile()) output.push(relative(root, path));
  }
  return output;
}

const candidates = new Set(trackedFiles());
const builtOutput = join(root, 'dist');
if (statSync(builtOutput, { throwIfNoEntry: false })?.isDirectory()) {
  for (const file of filesBelow(builtOutput)) candidates.add(file);
}

const violations = [];
for (const file of candidates) {
  if (
    containsMarker(Buffer.from(file, 'utf8')) ||
    containsMarker(readFileSync(join(root, file)))
  ) {
    violations.push(file);
  }
}

if (violations.length) {
  console.error(`Forbidden marker found in ${violations.length} file(s):`);
  for (const file of violations) console.error(`- ${file}`);
  process.exitCode = 1;
} else {
  console.log(`Marker check passed across ${candidates.size} files.`);
}
