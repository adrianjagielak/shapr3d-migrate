'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const log = require('./log');
const paths = require('./paths');
const procheck = require('./procheck');
const zipMod = require('./zip');
const { readIdentity, listUserIDsByProjectCount } = require('./identity');

const uuid = () => crypto.randomUUID();

// Fields cleared on every migrated Project to make it look like a freshly
// authored, never-uploaded local project.
const LOCAL_ONLY_PROJECT_OVERRIDES = {
  remoteID:                 null,
  revisionID:               null,
  remoteHeadRevisionID:     null,
  remoteRevisionID:         null,   // schema name on older DBs
  remoteChangeSeqNo:        null,
  isOffloaded:              0,
  isRemotePlaceholder:      0,
  isRemotelyDeleted:        0,
  isMarkedForRemoteUndelete:0,
  isMarkedForCleanup:       0,
  spaceAccessDeletedAtMsec: null,
  remoteHeadRevisionClientVersion:       0,
  remoteHeadRevisionSourceServerVersion: null,
};

// Column renames between schema versions. (oldName -> newName)
const PROJECT_COLUMN_RENAMES = {
  remoteRevisionID: 'remoteHeadRevisionID',
};

// ---------------------------------------------------------------------------

function recursiveCopy(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.DS_Store') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) recursiveCopy(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function snapshotContainer(L) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = path.join(path.dirname(L.root), `${path.basename(L.root)}.snapshot-${stamp}`);
  log.step(`snapshotting current container -> ${dst}`);
  recursiveCopy(L.root, dst);
  return dst;
}

// Locate the on-disk source directory for an old project, regardless of
// whether the backup is in v20 layout (`<projectID>/project/`) or v28+ layout
// (`<projectID>/<slotID>/`). Returns the inner directory path or null.
function locateSourceProjectDir(projectsRoot, projectID) {
  const projDir = path.join(projectsRoot, projectID);
  if (!fs.existsSync(projDir)) return null;
  // Old layout: <projectID>/project/
  const oldLay = path.join(projDir, 'project');
  if (fs.existsSync(path.join(oldLay, 'workspace'))) return oldLay;
  // New layout: <projectID>/<slotID>/
  for (const ent of fs.readdirSync(projDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (fs.existsSync(path.join(projDir, ent.name, 'workspace'))) {
      return path.join(projDir, ent.name);
    }
  }
  return null;
}

// Build a row to INSERT into NEW Projects from an OLD row, by intersecting
// columns and renaming where the schema changed.
function projectRowForNewSchema(oldRow, oldCols, newCols) {
  const oldSet = new Set(oldCols);
  const out = {};
  for (const c of newCols) {
    let srcCol = c;
    if (!(c in oldRow)) {
      // try reverse rename: NEW name -> OLD name
      for (const [oldName, newName] of Object.entries(PROJECT_COLUMN_RENAMES)) {
        if (newName === c && oldSet.has(oldName)) { srcCol = oldName; break; }
      }
    }
    out[c] = (srcCol in oldRow) ? oldRow[srcCol] : null;
  }
  return out;
}

function asInt(b) { return b ? 1 : 0; }

// ---------------------------------------------------------------------------

async function restoreCommand(opts) {
  const {
    zipPath,
    fromUser,
    includeDeleted = false,
    includeTemporary = false,
    keepRemote = false,   // if true, do NOT clear remoteID/revisionID
    dryRun = false,
    snapshot = true,
    force = false,
  } = opts;

  if (!zipPath) throw new Error('restore: missing path to backup zip');

  if (!force) procheck.assertShapr3DNotRunning();

  // 1. extract backup to temp dir
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shapr3d-restore-'));
  log.step(`extracting ${zipPath} -> ${tmp}`);
  zipMod.extractTo(zipPath, tmp);
  const oldL = paths.layout(tmp);
  if (!fs.existsSync(oldL.projectDb)) {
    throw new Error(`backup does not look like a Shapr3D container (missing ${oldL.projectDb})`);
  }

  // 2. locate live container
  const newRoot = paths.findContainerRoot();
  const newL = paths.layout(newRoot);
  if (!fs.existsSync(newL.projectDb)) {
    throw new Error(
      `live container at ${newRoot} has no projectStorage.db. ` +
      `Open Shapr3D, sign in to the destination account once, then re-run.`
    );
  }

  // 3. read identities, choose the OLD userID
  const newId = readIdentity(newL);
  log.header('destination account');
  console.log(`  ${log.c.bold(newId.name || '?')} <${newId.email || '?'}>`);
  console.log(`  userID = ${newId.userID}`);
  console.log(`  private space = ${newId.privateSpaceID}`);
  console.log(`  team space    = ${newId.teamSpaceID}`);
  console.log(`  subscription  = ${newId.tier} (expires ${newId.expirationDate})`);

  const breakdown = listUserIDsByProjectCount(oldL);
  let oldUserID = fromUser;
  if (!oldUserID) {
    const top = breakdown[0];
    if (!top) throw new Error('no projects found in backup');
    oldUserID = top.userID;
    if (breakdown.length > 1) {
      log.warn(`backup contains projects from ${breakdown.length} userIDs; picking the largest:`);
      for (const u of breakdown) {
        const marker = u.userID === oldUserID ? log.c.green('→') : ' ';
        console.log(`  ${marker} ${u.userID}  total=${u.total} active=${u.active}`);
      }
      log.info(`use --from-user <uuid> to pick a different one`);
    }
  } else if (!breakdown.some((u) => u.userID === oldUserID)) {
    throw new Error(`--from-user ${oldUserID} not present in backup`);
  }

  // Determine source spaces from on-disk Spaces table (more reliable than cache)
  const oldDb = new DatabaseSync(oldL.projectDb, { readOnly: true });
  const oldSpaces = oldDb.prepare(
    "SELECT spaceID, isPrivate FROM Spaces WHERE userID = ? AND deletedAtMsec IS NULL"
  ).all(oldUserID);
  let oldPrivateSpaceID = null, oldTeamSpaceID = null;
  for (const s of oldSpaces) {
    if (s.isPrivate) oldPrivateSpaceID = s.spaceID;
    else             oldTeamSpaceID    = s.spaceID;
  }

  log.header('source account in backup');
  console.log(`  userID = ${oldUserID}`);
  console.log(`  private space = ${oldPrivateSpaceID}`);
  console.log(`  team space    = ${oldTeamSpaceID}`);

  // Build space remap. Old private -> new private, old team -> new team.
  // Anything else (shared spaces) gets dropped onto new private as a safe default.
  const spaceMap = {};
  if (oldPrivateSpaceID && newId.privateSpaceID) spaceMap[oldPrivateSpaceID] = newId.privateSpaceID;
  if (oldTeamSpaceID    && newId.teamSpaceID)    spaceMap[oldTeamSpaceID]    = newId.teamSpaceID;

  const mapSpace = (sid) => spaceMap[sid] || newId.privateSpaceID;

  // 4. enumerate migrate-able projects
  const filterParts = [
    `userID = ?`,
    includeDeleted   ? null : `isDeleted = 0`,
    includeTemporary ? null : `isTemporary = 0`,
    `spaceID IS NOT NULL`,
  ].filter(Boolean);
  const oldProjectCols = oldDb.prepare("PRAGMA table_info(Projects)").all().map((r) => r.name);
  const oldRows = oldDb.prepare(
    `SELECT * FROM Projects WHERE ${filterParts.join(' AND ')} ORDER BY lastModifiedAtMsec`
  ).all(oldUserID);

  const oldFolders = oldDb.prepare(
    `SELECT * FROM Folders WHERE userID = ? AND isDeleted = 0`
  ).all(oldUserID);
  oldDb.close();

  log.header(`planning migration (${oldRows.length} projects, ${oldFolders.length} folders)`);

  // 5. open NEW DB, build planned actions (without writing yet)
  const dst = new DatabaseSync(newL.projectDb);
  const newProjectCols = dst.prepare("PRAGMA table_info(Projects)").all().map((r) => r.name);
  const newSlotCols    = dst.prepare("PRAGMA table_info(Slots)").all().map((r) => r.name);
  const newFolderCols  = dst.prepare("PRAGMA table_info(Folders)").all().map((r) => r.name);

  let seq = dst.prepare("SELECT value FROM ChangeSeqNo").get().value;
  let seqStart = seq;

  const folderActions = [];
  for (const f of oldFolders) {
    const newSpace = mapSpace(f.spaceID);
    const exists = dst.prepare(
      "SELECT 1 FROM Folders WHERE userID = ? AND spaceID = ? AND path = ?"
    ).get(newId.userID, newSpace, f.path);
    if (exists) continue;
    const row = {};
    for (const c of newFolderCols) row[c] = (c in f) ? f[c] : null;
    row.userID            = newId.userID;
    row.spaceID           = newSpace;
    row.path              = f.path;
    row.changeSeqNo       = ++seq;
    row.isLocalOnly       = 1;
    row.remoteChangeSeqNo = null;
    row.isDeleted         = 0;
    row.isRemotelyDeleted = 0;
    row.movedFromChangeSeqNo = null;
    row.movedFromSpaceID  = null;
    row.movedFromPath     = null;
    folderActions.push(row);
  }

  const projectActions = [];
  let skipped = 0;
  for (const old of oldRows) {
    const srcDir = locateSourceProjectDir(oldL.projects, old.projectID);
    if (!srcDir) {
      skipped++;
      log.debug(`skip ${old.projectID.slice(0, 8)} (${old.title || 'untitled'}): no on-disk files`);
      continue;
    }

    // Skip if the project already exists in destination DB (idempotent re-runs)
    const dup = dst.prepare("SELECT 1 FROM Projects WHERE projectID = ?").get(old.projectID);
    if (dup) {
      skipped++;
      log.debug(`skip ${old.projectID.slice(0, 8)}: already in destination DB`);
      continue;
    }

    const row = projectRowForNewSchema(old, oldProjectCols, newProjectCols);
    row.userID  = newId.userID;
    row.spaceID = mapSpace(old.spaceID);
    row.changeSeqNo          = ++seq;
    row.createdAtChangeSeqNo = old.createdAtChangeSeqNo ?? row.changeSeqNo;
    row.lastModifiedInAppSessionID    = null;
    row.lastModifiedAtEditorSequenceNo= null;
    row.titleSourceServerVersion      = null;
    row.folderSourceServerVersion     = null;

    if (!keepRemote) {
      for (const [k, v] of Object.entries(LOCAL_ONLY_PROJECT_OVERRIDES)) {
        if (k in row) row[k] = v;
      }
    }
    // Required NOT NULL fallbacks (from observed schema)
    if (row.changeSeqNo == null) row.changeSeqNo = ++seq;
    if (row.createID == null)    row.createID = 0;
    if (row.title == null)       row.title = '';
    if (row.titleClientVersion == null) row.titleClientVersion = 1;
    if (row.folderClientVersion == null) row.folderClientVersion = 1;
    if (row.lastAccessedAtMsec == null) row.lastAccessedAtMsec = Date.now();
    if (row.lastTouchedAtMsec == null)  row.lastTouchedAtMsec  = Date.now();
    if (row.isTemporary == null) row.isTemporary = 0;
    if (row.isDeleted == null)   row.isDeleted = 0;
    if (row.isRemotelyDeleted == null) row.isRemotelyDeleted = 0;
    if (row.isRemotePlaceholder == null) row.isRemotePlaceholder = 0;
    if (row.isLocallyUndeleted == null) row.isLocallyUndeleted = 0;
    if (row.isOffloaded == null) row.isOffloaded = 0;
    if (row.shouldKeepDownloaded == null) row.shouldKeepDownloaded = 0;
    if (row.isMarkedForRemoteUndelete == null) row.isMarkedForRemoteUndelete = 0;
    if (row.isMarkedForCleanup == null) row.isMarkedForCleanup = 0;
    if (row.remoteHeadRevisionClientVersion == null) row.remoteHeadRevisionClientVersion = 0;

    const slotID = uuid();
    const slot = {
      slotID,
      projectID:          old.projectID,
      revisionID:         null,                 // local-only: not tied to an uploaded revision
      localChangeCount:   1,                    // > 0 -> "has unsaved changes"
      createdAtMsec:      old.lastModifiedAtMsec || Date.now(),
      lastAccessedAtMsec: old.lastAccessedAtMsec || Date.now(),
      isPending:          0,
      isMigrationPending: 0,
      isMarkedForCleanup: 0,
    };
    const slotFiltered = {};
    for (const c of newSlotCols) if (c in slot) slotFiltered[c] = slot[c];

    projectActions.push({
      projectID: old.projectID,
      title:     old.title || '(untitled)',
      row,
      slot:      slotFiltered,
      srcDir,
      dstDir:    path.join(newL.projects, old.projectID, slotID),
      thumbs:    [old.thumbnailLight, old.thumbnailDark]
        .filter(Boolean)
        .map((tid) => ({
          src: path.join(oldL.resources, tid),
          dst: path.join(newL.resources, tid),
        }))
        .filter((t) => fs.existsSync(t.src)),
    });
  }

  // 6. summary
  log.header('summary');
  console.log(`  folders to insert:  ${folderActions.length}`);
  console.log(`  projects to insert: ${projectActions.length}` +
              (skipped ? `  ${log.c.dim(`(${skipped} skipped)`)}` : ''));
  const bytes = projectActions
    .map((a) => dirSize(a.srcDir))
    .reduce((s, n) => s + n, 0);
  console.log(`  files to copy:      ${(bytes / (1024 * 1024)).toFixed(1)} MiB`);
  console.log(`  changeSeqNo:        ${seqStart} -> ${seq}`);

  if (dryRun) {
    log.warn('dry run — no changes written');
    dst.close();
    return;
  }

  // 7. snapshot for rollback
  let snapshotPath = null;
  if (snapshot) snapshotPath = snapshotContainer(newL);

  // 8. apply DB changes in a single transaction
  log.step('writing database changes');
  try {
    dst.exec('BEGIN');
    for (const f of folderActions) {
      const cols = newFolderCols.filter((c) => c in f);
      const sql = `INSERT INTO Folders (${cols.map(quoteIdent).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      dst.prepare(sql).run(...cols.map((c) => f[c]));
    }
    for (const a of projectActions) {
      const pcols = newProjectCols.filter((c) => c in a.row);
      const psql  = `INSERT INTO Projects (${pcols.map(quoteIdent).join(',')}) VALUES (${pcols.map(() => '?').join(',')})`;
      dst.prepare(psql).run(...pcols.map((c) => a.row[c]));
      const scols = newSlotCols.filter((c) => c in a.slot);
      const ssql  = `INSERT INTO Slots (${scols.map(quoteIdent).join(',')}) VALUES (${scols.map(() => '?').join(',')})`;
      dst.prepare(ssql).run(...scols.map((c) => a.slot[c]));
    }
    dst.prepare('UPDATE ChangeSeqNo SET value = ?').run(seq);
    // sanity-check before commit
    const fk = dst.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) {
      throw new Error(`foreign-key violation after inserts:\n${JSON.stringify(fk.slice(0, 5), null, 2)}`);
    }
    dst.exec('COMMIT');
  } catch (e) {
    try { dst.exec('ROLLBACK'); } catch {}
    dst.close();
    log.err(`DB transaction failed: ${e.message}`);
    if (snapshotPath) log.warn(`restore from snapshot at: ${snapshotPath}`);
    throw e;
  }
  dst.close();
  log.ok(`database updated (${projectActions.length} projects, ${folderActions.length} folders)`);

  // 9. copy files & thumbnails
  log.step('copying project files');
  for (const a of projectActions) {
    fs.mkdirSync(path.dirname(a.dstDir), { recursive: true });
    if (fs.existsSync(a.dstDir)) fs.rmSync(a.dstDir, { recursive: true, force: true });
    recursiveCopy(a.srcDir, a.dstDir);
    for (const t of a.thumbs) {
      fs.mkdirSync(path.dirname(t.dst), { recursive: true });
      if (!fs.existsSync(t.dst)) fs.copyFileSync(t.src, t.dst);
    }
  }
  log.ok(`copied ${projectActions.length} project directories`);

  // 10. clear sync.db so the app rebuilds it from scratch on next launch
  if (fs.existsSync(newL.syncDb)) {
    fs.rmSync(newL.syncDb);
    log.ok('removed stale sync.db (app will rebuild on next launch)');
  }

  log.header('done');
  console.log(`  Open Shapr3D and verify your projects appear under ${log.c.bold(newId.name || newId.email)}.`);
  if (snapshotPath) {
    console.log(`  Pre-migration snapshot kept at:`);
    console.log(`    ${snapshotPath}`);
    console.log(`  Once you've confirmed everything works, you can remove it:`);
    console.log(`    rm -rf "${snapshotPath}"`);
  }
}

function quoteIdent(c) { return `"${c.replace(/"/g, '""')}"`; }

function dirSize(d) {
  let total = 0;
  if (!fs.existsSync(d)) return 0;
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) total += dirSize(p);
    else if (ent.isFile()) {
      try { total += fs.statSync(p).size; } catch {}
    }
  }
  return total;
}

module.exports = { restoreCommand };
