'use strict';

const { execFileSync } = require('node:child_process');

// Returns array of pids matching Shapr3D, or [] if none.
function findShapr3DPids() {
  // pgrep -fil 'Shapr3D' will match the process name. -f matches the full
  // command line which catches the macOS app's executable path.
  try {
    const out = execFileSync('pgrep', ['-fl', '-i', 'Shapr3D'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // Filter out our own process and obvious false positives (this CLI itself).
      .filter((l) => !/shapr3d-migrate/i.test(l))
      .map((l) => {
        const [pid, ...cmd] = l.split(/\s+/);
        return { pid: parseInt(pid, 10), cmd: cmd.join(' ') };
      });
  } catch (e) {
    // pgrep exits 1 when nothing matches; that is success here.
    if (e.status === 1) return [];
    throw e;
  }
}

function assertShapr3DNotRunning() {
  const pids = findShapr3DPids();
  if (pids.length === 0) return;
  const err = new Error(
    'Shapr3D is currently running. Quit the app fully (⌘Q, then check Activity Monitor) and try again.\n' +
    pids.map((p) => `  pid ${p.pid}: ${p.cmd}`).join('\n')
  );
  err.code = 'SHAPR3D_RUNNING';
  throw err;
}

module.exports = { findShapr3DPids, assertShapr3DNotRunning };
