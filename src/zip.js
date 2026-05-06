'use strict';

// Use the macOS-bundled `zip` and `unzip` binaries instead of an npm
// dependency. Both are part of the base system at /usr/bin and have been
// since at least Mac OS X 10.4. This keeps the tool runnable without
// `npm install` — `node bin/cli.js` works straight out of the repo.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ZIP_EXCLUDES = [
  // SQLite sidecars from a still-locking process, never useful in a backup
  '*-wal', '*-shm', '*-journal',
  // macOS resource-fork cruft (unzip/zip globs match `*` across slashes,
  // so a single `*.DS_Store` covers both top-level and nested)
  '*.DS_Store',
  '*__MACOSX*',
];

const UNZIP_EXCLUDES = [
  '*__MACOSX*',
  '*.DS_Store',
];

// Zip the contents of `dataDir` into `outZip`, with a top-level `Data/`
// entry inside the archive (matches the convention the legacy app's
// "duplicate the container" backups used).
//
// We run `zip` with cwd=parentOfDataDir so the archive sees `Data/...`
// regardless of where on disk the source actually lives.
function zipContainerData(dataDir, outZip) {
  const abs = path.resolve(dataDir);
  if (!fs.existsSync(abs)) throw new Error(`source directory does not exist: ${abs}`);
  if (path.basename(abs) !== 'Data') {
    // Edge case: caller passed something other than a "Data" directory.
    // Stage it under a temp "Data/" symlink so the archive layout still matches.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'shapr3d-stage-'));
    const linked = path.join(stage, 'Data');
    fs.symlinkSync(abs, linked, 'dir');
    try {
      runZip(stage, outZip);
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    }
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(outZip)), { recursive: true });
  runZip(path.dirname(abs), outZip);
}

function runZip(cwd, outZip) {
  // -r recurse, -q quiet, -X drop UID/GID/extended attrs (smaller, more portable),
  // -y preserve symlinks rather than dereferencing (containers have none inside
  //   Data so this matters only defensively),
  // -x apply exclude globs.
  const args = ['-r', '-q', '-X', '-y', path.resolve(outZip), 'Data', '-x', ...ZIP_EXCLUDES];
  try {
    execFileSync('/usr/bin/zip', args, {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch (e) {
    throw new Error(`zip failed (exit ${e.status}): ${e.message}`);
  }
}

// Extract `zipPath` into `outDir`, skipping macOS metadata.
function extractTo(zipPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // -qq fully quiet (suppresses cautions about non-matching exclude
  //   patterns), -o overwrite without prompting, -d destination,
  //   -x exclude globs.
  const args = ['-qq', '-o', path.resolve(zipPath), '-d', path.resolve(outDir), '-x', ...UNZIP_EXCLUDES];
  try {
    execFileSync('/usr/bin/unzip', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) {
    // unzip exit 1 = "one or more warnings but completed", which is fine.
    if (e.status === 1) return;
    throw new Error(`unzip failed (exit ${e.status}): ${e.message}`);
  }
}

module.exports = { zipContainerData, extractTo };
