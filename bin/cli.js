#!/usr/bin/env node
'use strict';

// Suppress Node's experimental-warning for node:sqlite. We require Node >= 22.5.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const { backupCommand }  = require('../src/backup');
const { restoreCommand } = require('../src/restore');
const { inspectCommand } = require('../src/inspect');
const log = require('../src/log');

const HELP = `shapr3d-migrate — backup and restore your Shapr3D macOS container

USAGE
  shapr3d-migrate backup  [--out <zip>] [--force]
  shapr3d-migrate restore <backup.zip> [options]
  shapr3d-migrate inspect [<path>]
  shapr3d-migrate --help

COMMANDS
  backup
      Quit-check Shapr3D, then zip up the live container into a single .zip.
      Default output: ~/Downloads/Shapr3D_backup_<YYYY-MM-DD>.zip
      Options:
        --out <zip>    write to a specific path
        --force        overwrite an existing zip / skip the running-process check

  restore <backup.zip>
      Quit-check Shapr3D, then merge the projects, folders and thumbnails from
      the backup into the currently signed-in account, rewriting userID and
      space IDs as needed. Existing projects in the destination account are
      preserved.
      Options:
        --from-user <uuid>   pick a specific source userID when the backup
                             contains projects from more than one account
        --include-deleted    also import soft-deleted projects
        --include-temporary  also import temporary/scratch projects
        --keep-remote        do NOT clear remoteID/revisionID fields
                             (advanced; only meaningful if you are also
                              transferring cloud ownership somehow)
        --no-snapshot        do not snapshot the destination container first
                             (faster, no rollback safety net)
        --dry-run            print plan without writing anything
        --force              skip the running-process check

  inspect [<path>]
      With no argument, summarise the live container.
      With a path to a .zip backup or an extracted directory, summarise that.

ENVIRONMENT
  SHAPR3D_DEBUG=1     verbose per-project decisions

EXIT CODES
  0 success    1 user error    2 internal error    3 Shapr3D is running
`;

function parseArgs(argv) {
  const args = argv.slice();
  const positional = [];
  const flags = {};
  while (args.length) {
    const a = args.shift();
    if (a === '--' )                 { positional.push(...args); break; }
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--out')          flags.out = args.shift();
    else if (a === '--force')        flags.force = true;
    else if (a === '--from-user')    flags.fromUser = args.shift();
    else if (a === '--include-deleted')   flags.includeDeleted = true;
    else if (a === '--include-temporary') flags.includeTemporary = true;
    else if (a === '--keep-remote')  flags.keepRemote = true;
    else if (a === '--no-snapshot')  flags.snapshot = false;
    else if (a === '--dry-run')      flags.dryRun = true;
    else if (a.startsWith('--'))     throw new Error(`unknown option: ${a}`);
    else                             positional.push(a);
  }
  return { positional, flags };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); return 0; }

  let parsed;
  try { parsed = parseArgs(rest); }
  catch (e) { log.err(e.message); return 1; }
  const { positional, flags } = parsed;
  if (flags.help) { console.log(HELP); return 0; }

  try {
    switch (cmd) {
      case 'backup':
        backupCommand({ out: flags.out, force: !!flags.force });
        return 0;

      case 'restore':
        if (!positional[0]) { log.err('restore: pass a path to a backup.zip'); return 1; }
        await restoreCommand({
          zipPath:          positional[0],
          fromUser:         flags.fromUser,
          includeDeleted:   !!flags.includeDeleted,
          includeTemporary: !!flags.includeTemporary,
          keepRemote:       !!flags.keepRemote,
          snapshot:         flags.snapshot !== false,
          dryRun:           !!flags.dryRun,
          force:            !!flags.force,
        });
        return 0;

      case 'inspect':
        await inspectCommand({ target: positional[0] });
        return 0;

      default:
        log.err(`unknown command: ${cmd}`);
        console.log(HELP);
        return 1;
    }
  } catch (e) {
    if (e.code === 'SHAPR3D_RUNNING') { log.err(e.message); return 3; }
    log.err(e.message);
    if (process.env.SHAPR3D_DEBUG) console.error(e.stack);
    return 2;
  }
}

main().then((code) => { process.exitCode = code || 0; });
