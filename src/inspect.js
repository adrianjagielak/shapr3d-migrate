'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const log = require('./log');
const paths = require('./paths');
const zipMod = require('./zip');
const { readIdentity, listUserIDsByProjectCount } = require('./identity');

function fmtDate(msec) { return msec ? new Date(msec).toISOString().slice(0, 10) : '----------'; }

// Inspect a layout (live container or extracted backup) and print a summary.
function inspectLayout(L, label = 'container') {
  log.header(`${label}: ${L.root}`);
  let id;
  try {
    id = readIdentity(L);
    console.log(`  account:        ${log.c.bold(id.name || '?')} <${id.email || '?'}>`);
    console.log(`  userID:         ${id.userID}`);
    console.log(`  primary teamID: ${id.teamID}`);
    console.log(`  private space:  ${id.privateSpaceID}`);
    console.log(`  team space:     ${id.teamSpaceID}`);
    console.log(`  subscription:   ${id.tier || '?'} (expires ${id.expirationDate || '?'})`);
  } catch (e) {
    log.warn(`could not read identity: ${e.message}`);
  }

  const userBreakdown = listUserIDsByProjectCount(L);
  if (userBreakdown.length > 1) {
    console.log(`\n  ${log.c.yellow('multiple userIDs found')} in projectStorage.db:`);
    for (const u of userBreakdown) {
      console.log(`    ${u.userID}  total=${u.total}  active=${u.active}`);
    }
  }

  // Project listing for the "primary" userID
  const primary = id?.userID || userBreakdown[0]?.userID;
  if (!primary) return;

  const db = new DatabaseSync(L.projectDb, { readOnly: true });
  let rows;
  try {
    rows = db.prepare(
      `SELECT projectID, title, folderPath, spaceID, isOffloaded, isRemotePlaceholder,
              isTemporary, isDeleted, lastModifiedAtMsec, remoteID
       FROM Projects WHERE userID = ? ORDER BY lastModifiedAtMsec DESC`
    ).all(primary);
  } finally { db.close(); }

  const onDisk = fs.existsSync(L.projects)
    ? new Set(fs.readdirSync(L.projects).filter((d) => !d.startsWith('.')))
    : new Set();

  let active = 0, deleted = 0, temp = 0, cloudOnly = 0, withFiles = 0;
  for (const r of rows) {
    if (r.isDeleted)       deleted++;
    else if (r.isTemporary)temp++;
    else                   active++;
    if (r.isRemotePlaceholder || r.isOffloaded) cloudOnly++;
    if (onDisk.has(r.projectID)) withFiles++;
  }
  console.log(
    `\n  projects: ${rows.length} total — ${active} active, ${temp} temp, ${deleted} deleted, ` +
    `${cloudOnly} cloud-only, ${withFiles} with on-disk files`
  );

  // Sample first 12 newest non-deleted projects
  const visible = rows.filter((r) => !r.isDeleted).slice(0, 12);
  for (const r of visible) {
    const fold = r.folderPath ? `[${r.folderPath}]` : '';
    const flag = r.isRemotePlaceholder || r.isOffloaded ? log.c.dim('cloud') : '';
    const title = r.title || log.c.dim('(untitled)');
    console.log(`    ${fmtDate(r.lastModifiedAtMsec)}  ${title}  ${log.c.gray(fold)} ${flag}`);
  }
  if (rows.filter((r) => !r.isDeleted).length > visible.length) {
    console.log(`    ... ${rows.filter((r) => !r.isDeleted).length - visible.length} more`);
  }
}

async function inspectCommand({ target }) {
  if (!target) {
    const root = paths.findContainerRoot();
    inspectLayout(paths.layout(root), 'live container');
    return;
  }
  // target is either a directory (already extracted) or a zip
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    inspectLayout(paths.layout(target), `directory: ${target}`);
    return;
  }
  // Treat as zip — extract to a temp dir
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shapr3d-inspect-'));
  log.step(`extracting backup to ${tmp}`);
  zipMod.extractTo(target, tmp);
  inspectLayout(paths.layout(tmp), `backup zip: ${path.basename(target)}`);
  log.info(`(left extracted at ${tmp}; remove with: rm -rf "${tmp}")`);
}

module.exports = { inspectCommand, inspectLayout };
