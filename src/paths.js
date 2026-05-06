'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();

// Container roots that may exist on a given Mac. On modern macOS the bundle ID
// is the directory name; on older systems a "Shapr3D" symlink/dir is also seen.
const CANDIDATE_ROOTS = [
  path.join(HOME, 'Library/Containers/com.shapr3d.shapr'),
  path.join(HOME, 'Library/Containers/Shapr3D'),
];

function findContainerRoot() {
  if (process.env.SHAPR3D_CONTAINER) {
    const r = process.env.SHAPR3D_CONTAINER;
    try {
      const real = fs.realpathSync(r);
      if (fs.statSync(real).isDirectory()) return real;
    } catch {}
    throw new Error(`SHAPR3D_CONTAINER=${r} but that path does not exist.`);
  }
  for (const r of CANDIDATE_ROOTS) {
    try {
      const real = fs.realpathSync(r);
      if (fs.statSync(real).isDirectory()) return real;
    } catch {}
  }
  throw new Error(
    `Could not find Shapr3D container. Tried:\n  ${CANDIDATE_ROOTS.join('\n  ')}\n` +
    `Open Shapr3D once and let it sign in, then re-run.\n` +
    `(Or set SHAPR3D_CONTAINER=/path/to/container to override.)`
  );
}

// Sub-paths relative to a container root (or to a backup-tree root when
// the backup zips up Data/ or container-root/).
function layout(root) {
  const data = fs.existsSync(path.join(root, 'Data'))
    ? path.join(root, 'Data')
    : root; // some backups zip the contents of Data/ directly
  return {
    root,
    data,
    docs:        path.join(data, 'Documents'),
    projects:    path.join(data, 'Documents/projects'),
    appSupport:  path.join(data, 'Library/Application Support/com.shapr3d.shapr'),
    storage:     path.join(data, 'Library/Application Support/com.shapr3d.shapr/storage'),
    projectDb:   path.join(data, 'Library/Application Support/com.shapr3d.shapr/storage/projectStorage.db'),
    resources:   path.join(data, 'Library/Application Support/com.shapr3d.shapr/storage/resources'),
    userDb:      path.join(data, 'Library/Application Support/com.shapr3d.shapr/user.db'),
    syncDb:      path.join(data, 'Library/Application Support/com.shapr3d.shapr/sync.db'),
    prefsPlist:  path.join(data, 'Library/Preferences/com.shapr3d.shapr.plist'),
  };
}

module.exports = { CANDIDATE_ROOTS, findContainerRoot, layout, HOME };
