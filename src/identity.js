'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// Read account identity from a layout (live or backup).
//   - userID and primary teamID + email/name come from user.db (cached profile).
//   - private/team spaceIDs come from projectStorage.db Spaces table, which is
//     authoritative on disk and survives even when the cache is stale.
function readIdentity(L) {
  if (!fs.existsSync(L.userDb)) {
    throw new Error(`user.db not found at ${L.userDb} — has anyone signed in here yet?`);
  }
  if (!fs.existsSync(L.projectDb)) {
    throw new Error(`projectStorage.db not found at ${L.projectDb}`);
  }

  const u = new DatabaseSync(L.userDb, { readOnly: true });
  let cacheRows;
  try {
    cacheRows = u.prepare("SELECT userID, value FROM UserCache WHERE key = 'teamProfileResponse'").all();
  } finally { u.close(); }

  if (!cacheRows.length) throw new Error('UserCache is empty in user.db (account not initialised).');

  // If multiple userIDs are cached, prefer the one with most projects in projectStorage.
  const p = new DatabaseSync(L.projectDb, { readOnly: true });
  let chosen;
  try {
    let bestCount = -1;
    for (const r of cacheRows) {
      const c = p.prepare("SELECT COUNT(*) AS n FROM Projects WHERE userID = ?").get(r.userID).n;
      if (c > bestCount) { bestCount = c; chosen = r; }
    }
  } finally { /* keep open for next query */ }

  const profile = JSON.parse(chosen.value);
  const team = (profile.teams || []).find((t) => t.isPrimary) || profile.teams?.[0];
  if (!team) throw new Error('No team in cached profile.');

  // Cross-check spaces against the on-disk Spaces table.
  const spaceRows = p.prepare(
    "SELECT spaceID, isPrivate FROM Spaces WHERE userID = ? AND deletedAtMsec IS NULL"
  ).all(chosen.userID);
  p.close();

  let privateSpaceID = null;
  let teamSpaceID = null;
  for (const s of spaceRows) {
    if (s.isPrivate) privateSpaceID = s.spaceID;
    else teamSpaceID = s.spaceID;
  }
  // Fall back to cached spaces if the on-disk table is empty.
  for (const s of (team.spaces || [])) {
    if (s.type === 'private' && !privateSpaceID) privateSpaceID = s.spaceID;
    if (s.type === 'team'    && !teamSpaceID)    teamSpaceID    = s.spaceID;
  }

  return {
    userID:         chosen.userID,
    teamID:         team.teamID,
    privateSpaceID,
    teamSpaceID,
    name:           profile.name || null,
    email:          profile.email || null,
    tier:           team.individualSubscription?.tier || null,
    expirationDate: team.individualSubscription?.expirationDate || null,
  };
}

// Detect every userID present in the projectStorage.db, regardless of which one
// the user.db is "primary" for. Useful when one container has been signed in
// with multiple accounts over time.
function listUserIDsByProjectCount(L) {
  const p = new DatabaseSync(L.projectDb, { readOnly: true });
  try {
    return p.prepare(
      "SELECT userID, COUNT(*) AS total, " +
      "       SUM(CASE WHEN isDeleted=0 AND isTemporary=0 THEN 1 ELSE 0 END) AS active " +
      "FROM Projects GROUP BY userID ORDER BY active DESC, total DESC"
    ).all();
  } finally { p.close(); }
}

module.exports = { readIdentity, listUserIDsByProjectCount };
