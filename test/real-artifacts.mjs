/**
 * Manual check against artifacts this machine's harness actually wrote.
 *
 * `npm test` runs against fixtures; this script runs the same reader over real
 * `session.v4.jsonl.zstd` artifacts (the raw per-Session files an older export
 * shipped, and the same logical log a current export serializes), which is how
 * a stale event vocabulary or a wrong Zstandard frame walk shows up.
 *
 * Usage: node test/real-artifacts.mjs [directory]
 * Default directory: $DSH_HOME/sessions
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSessionLog } from '../lib/archive.js';
import { isZstd, zstdDecompressFrames } from '../lib/zip.js';
import { readSessionArchive } from '../lib/archive.js';

/**
 * Every `session*.jsonl*` artifact under a directory tree.
 * @param {string} root - directory to scan.
 * @param {number} [depth] - remaining recursion depth.
 * @returns {Promise<string[]>} artifact paths.
 */
async function findArtifacts(root, depth = 4) {
  const found = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...(await findArtifacts(path, depth - 1)));
    else if (entry.isFile() && /^session(\.[\w]+)*\.jsonl(\.zstd)?$/u.test(entry.name)) found.push(path);
  }
  return found;
}

const root = resolve(process.argv[2] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions'));
const artifacts = await findArtifacts(root);
if (artifacts.length === 0) {
  console.log(`no session artifacts under ${root}`);
  process.exit(0);
}
let failures = 0;
let legacy = 0;
const typeCounts = new Map();
for (const path of artifacts) {
  const bytes = await readFile(path);
  const framed = isZstd(bytes);
  let text;
  try {
    text = framed ? zstdDecompressFrames(bytes).toString('utf8') : bytes.toString('utf8');
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${path}\n      ${error.message}`);
    continue;
  }
  // A migrated Session keeps its original-generation artifact beside the
  // current one; that file is refused by design and is not a failure.
  const version = /"version"\s*:\s*(\d+)/u.exec(text.slice(0, 400));
  if (version !== null && Number(version[1]) !== 4) {
    legacy += 1;
    console.log(`skip  ${path}  (generation v${version[1]}, not a v4 export)`);
    continue;
  }
  try {
    const log = parseSessionLog(text, { zipPath: path.replaceAll('\\', '/'), legacy: framed });
    for (const event of log.events) typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
    console.log(`ok    ${log.header.id}  ${String(log.events.length).padStart(6)} events  ${log.header.cwd ?? '(no cwd)'}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${path}\n      ${error.message}`);
  }
}
console.log('\nevent types seen:');
for (const [type, count] of [...typeCounts].sort((left, right) => right[1] - left[1])) {
  console.log(String(count).padStart(7), type);
}
console.log(`\n${artifacts.length - failures - legacy}/${artifacts.length - legacy} v4 artifacts parsed, ${legacy} older-generation artifact(s) skipped`);
process.exit(failures === 0 ? 0 : 1);
