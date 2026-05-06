# Notes on Shapr3D's macOS storage internals

Reverse-engineered from a pair of macOS containers — one written by
Shapr3D `26.32` (DB schema `user_version = 20`), one by `26.70`
(`user_version = 28`) — while building a tool to migrate projects
between accounts. None of this is from source; everything below is
inferred from observing on-disk state. Treat it as a sketch, not a
spec.

This is the companion piece to **`shapr3d-migrate`** — the migration
tool that this work produced. The tool is the answer to the question
"how do I move projects between accounts"; this doc is the answer to
"why isn't that just a copy".

---

## The container layout

Shapr3D on macOS is a sandboxed app, so all its user data lives under

```
~/Library/Containers/com.shapr3d.shapr/Data/
```

The two paths that matter are

```
Data/Documents/projects/<projectID>/<slotID>/        ← actual model files
Data/Library/Application Support/com.shapr3d.shapr/  ← databases & thumbs
```

Inside Application Support you'll find three SQLite files and one
folder of binary blobs:

| file                            | what's in it                                                                 |
|---------------------------------|------------------------------------------------------------------------------|
| `storage/projectStorage.db`     | Project metadata, folder hierarchy, owner, sync state. The interesting one.  |
| `storage/resources/<UUID>`      | Project thumbnails. Each is a 800×600 PNG.                                   |
| `user.db`                       | Cached account profile JSON keyed by `userID`.                               |
| `sync.db`                       | Cloud sync queue and per-device state. Safely deletable; the app rebuilds it. |

`Data/Library/Preferences/com.shapr3d.shapr.plist` holds user defaults,
including the per-user Cloud Sync toggle described in the last section.

A project on disk is *two* SQLite files in a directory:

```
Documents/projects/
  <projectID>/
    <slotID>/
      drawings/             ← 2D drawings (often empty)
      workspace             ← SQLite, the actual CAD model
```

`workspace` is the only file that's irreplaceable — history, sketches,
bodies, items, all of it. About 4–10 MiB per project, sometimes more.

---

## What `projectStorage.db` actually contains

By v28 there are 12 tables, but you can ignore all but five:

| table     | rows are…                                                                                               |
|-----------|---------------------------------------------------------------------------------------------------------|
| `Teams`   | One per (userID, teamID) pair the user has been a member of.                                            |
| `Spaces`  | One per (userID, teamID, spaceID). `isPrivate=1` is your "Drafts"; `=0` is a shared team space.         |
| `Folders` | Folder paths under each space. `path` is a string like `"iMac Studio Display"` (no nesting separators). |
| `Projects`| One per project. The main table.                                                                        |
| `Slots`   | Working copies of a project. Pointed at by the on-disk `<slotID>` directory.                            |

The shape of `Projects` (abridged):

```sql
CREATE TABLE Projects (
    projectID                TEXT NOT NULL PRIMARY KEY,
    userID                   TEXT NOT NULL,         -- the account UUID
    spaceID                  TEXT,                  -- private/team space
    sharingID                TEXT,
    title                    TEXT NOT NULL,
    folderPath               TEXT,                  -- references Folders.path
    thumbnailLight           TEXT,                  -- UUID -> resources/<UUID>
    thumbnailDark            TEXT,
    remoteID                 TEXT,                  -- cloud project ID, if uploaded
    revisionID               INTEGER,               -- last uploaded revision number
    remoteHeadRevisionID     INTEGER,               -- (renamed from remoteRevisionID in v22-ish)
    isOffloaded              INTEGER NOT NULL DEFAULT 0,  -- "cloud-only, no local copy"
    isRemotePlaceholder      INTEGER NOT NULL DEFAULT 0,  -- "stub for a cloud project we haven't downloaded"
    isTemporary              INTEGER NOT NULL,
    isDeleted                INTEGER NOT NULL DEFAULT 0,
    -- ...lots more sync bookkeeping...

    FOREIGN KEY (userID, spaceID) REFERENCES Spaces (userID, spaceID),
    CHECK       (spaceID IS NOT NULL OR sharingID IS NOT NULL)
);
```

The two foreign keys are doing all the work that makes "just copy the
files" not work. More on that in a second.

---

## userID / spaceID is per-account, and that's the whole problem

Sign into Shapr3D as account A. The app calls the cloud, gets back A's
profile JSON, caches it in `user.db`, and seeds `Teams` and `Spaces`
with rows like

```
Teams (userID="A", teamID="A's primary team", isPrimary=1)
Spaces(userID="A", teamID="A's primary team", spaceID="A-private", isPrivate=1)
Spaces(userID="A", teamID="A's primary team", spaceID="A-team",    isPrivate=0)
```

Every `Projects` row gets `userID = "A"` and `spaceID` pointing at one
of those two. A's "private space" UUID and B's "private space" UUID are
**not the same UUID**, even though they're conceptually the same kind
of space.

Sign out. Sign in as B. `user.db` gets B's profile cached. `Teams` and
`Spaces` get B's rows. But the `Projects` table still has all of A's
rows — `userID = "A"`, `spaceID = "A-private"` — and the foreign-key
constraint to `Spaces` still has to hold. It does (those Spaces rows
weren't deleted), but B's UI filters by B's `userID` and ignores
everything else. You see an empty dashboard.

In other words: signing out doesn't remove A's data, but signing in as
B doesn't make it visible either.

Worse, if Cloud Sync is on, the sync engine *does* see "local projects
that don't match the cloud account" as a discrepancy, and may try to
reconcile by deleting them locally. So a naive "swap containers between
machines" can both not-work *and* destroy data.

---

## Schema migration v20 → v28: the `Slots` table

The interesting structural change between the two versions I looked at
is how on-disk project files are laid out. In v20:

```
Documents/projects/<projectID>/project/{drawings,workspace}
```

The directory name was the literal string `project`. There was one
checked-out working copy per project, period.

In v28:

```
Documents/projects/<projectID>/<slotID>/{drawings,workspace}
Slots(slotID, projectID, revisionID, localChangeCount, ...)
Revisions(projectID, revisionID, uploadedByUserID, thumbnailLight, ...)
```

`Slots` is a table of working copies. Each row corresponds to a
`<projectID>/<slotID>/` directory on disk. A slot has a `revisionID`
that says which uploaded revision it's based on, plus a
`localChangeCount` that increments as the user edits. When
`localChangeCount > 0` and `revisionID IS NULL`, the slot is a brand
new project the cloud has never heard of. When `revisionID = N` and
`localChangeCount = 0`, the slot is exactly the cloud's revision N.

`Revisions` is the version history (right-click a project → "Show
Versions" in the dashboard). The migration tool doesn't bother with
this — migrated projects show up in the destination as freshly
authored, with no historical revisions.

There's also a column rename in `Projects`:
`remoteRevisionID → remoteHeadRevisionID`. Plus two new NOT-NULL columns
with defaults (`remoteHeadRevisionClientVersion`,
`remoteHeadRevisionSourceServerVersion`). Cheap to handle in a
schema-aware insert.

The mental model that makes the new design click is git: `Projects` is
the repo, `Revisions` are commits the cloud knows about, `Slots` are
working trees on disk. A "fresh local project" is a working tree with
no commits behind it yet.

---

## What "fresh local project" looks like

A project is treated by the app as freshly authored — never seen by
the cloud, no upstream to reconcile against — when these fields line
up:

- `Projects.remoteID IS NULL` (cloud has never seen this project)
- `Projects.revisionID IS NULL` and
  `Projects.remoteHeadRevisionID IS NULL`
- `Projects.isOffloaded = 0` (we have local files)
- `Projects.isRemotePlaceholder = 0` (this isn't a stub for a cloud
  project we haven't downloaded yet)
- `Slots.revisionID IS NULL` (the working tree isn't pinned to a
  cloud revision)
- `Slots.localChangeCount > 0` (there's local work the cloud
  doesn't have)

Take any project, set those, bump `localChangeCount` to 1, and the
app treats it as if you'd just clicked "New project" and started
editing.

There used to also be an account-level Cloud Sync toggle stored under
`com.shapr3d.shapr.userDefaults.remoteProperties.sync.isEnabled~<userID>`
in `Library/Preferences/com.shapr3d.shapr.plist` — older Shapr3D
versions exposed it as the "local-only" mode. Recent app versions
appear to ignore that preference entirely; flipping it via the
filesystem no longer disables uploads. So if you migrate projects
into an account that has sync turned on at the cloud level, expect
them to start syncing up to that account's cloud the next time the
app talks to the server. The per-project flags above are still
respected — they just don't make the *account* offline anymore, only
make each individual project look like a fresh local one.

---

## Why the rewrite-IDs approach works

Given the binding above, there are exactly four UUIDs that the
migrating account "knows" and that the destination account doesn't:

```
oldUserID        → newUserID
oldTeamID        → newTeamID
oldPrivateSpaceID → newPrivateSpaceID
oldTeamSpaceID   → newTeamSpaceID
```

The destination's UUIDs are sitting right there in the destination's
own `user.db` and `Spaces` table, populated when the user signed in.
You read them with one query. The mapping is a four-entry dict.

Then to migrate one project from old to new:

1. Insert a new `Projects` row, copying the old row's columns
   verbatim, except: `userID := newUserID`, `spaceID :=
   spaceMap[old.spaceID]`, and the local-only fields cleared as
   above.
2. Insert a fresh `Slots` row with `slotID := uuid()`, `projectID :=
   old.projectID`, `revisionID := NULL`, `localChangeCount := 1`.
3. Move the on-disk directory from `<projectID>/project/` (or
   `<projectID>/<oldSlotID>/`) to `<projectID>/<newSlotID>/`.
4. Copy the two thumbnail PNGs from `resources/<oldUUID>` —
   the UUIDs in `thumbnailLight`/`thumbnailDark` are random and don't
   collide with the destination's existing thumbs.

Done in a single transaction across `Projects`, `Slots`, and (if any
project references one) `Folders`. Validate with `PRAGMA
foreign_key_check` before commit. If anything is wrong, the constraint
is triggered, the transaction rolls back, and you've changed nothing.

The whole thing is ~150 lines of SQL+JS, and on the test corpus (62
projects, 410 MiB of workspace files) it ran in under a second for the
DB part, plus a few seconds of `cp`-bound work for the files.

---

## Useful one-liners while poking at this

Inspect a backup zip without modifying anything:

```bash
unzip -d /tmp/inspect Shapr3D_backup.zip
DB="/tmp/inspect/Data/Library/Application Support/com.shapr3d.shapr/storage/projectStorage.db"
```

Project counts by userID (e.g. for spotting machines that have hosted
multiple accounts):

```bash
sqlite3 "$DB" \
  "SELECT userID, COUNT(*) AS total,
          SUM(CASE WHEN isDeleted=0 AND isTemporary=0 THEN 1 ELSE 0 END) AS active
   FROM Projects GROUP BY userID ORDER BY active DESC;"
```

Cached account email/name (no signing-in required):

```bash
sqlite3 "/tmp/inspect/Data/Library/Application Support/com.shapr3d.shapr/user.db" \
  "SELECT json_extract(value, '\$.email'),
          json_extract(value, '\$.name'),
          json_extract(value, '\$.teams[0].individualSubscription.tier'),
          json_extract(value, '\$.teams[0].individualSubscription.expirationDate')
   FROM UserCache;"
```

How many projects had ever been uploaded?

```bash
sqlite3 "$DB" \
  "SELECT COUNT(*)            AS total,
          SUM(remoteID IS NOT NULL) AS in_cloud,
          SUM(isRemotePlaceholder)  AS cloud_only_stub,
          SUM(isOffloaded)          AS offloaded
   FROM Projects WHERE userID = '<userID>';"
```

Schema version (so you know whether you're looking at v20 or v28):

```bash
sqlite3 "$DB" 'PRAGMA user_version;'
```

Workspace file health — the only check that matters for "is the
underlying CAD data intact":

```bash
for ws in $(find /tmp/inspect/Data/Documents/projects -name workspace); do
  echo "$(sqlite3 "$ws" 'PRAGMA integrity_check;') $ws"
done
```

---

## What I haven't figured out

In rough order of "things that would matter if they bit you":

- **`SharedProjects` and `SharedProjectsChangeSeqNos`.** Both empty in
  the data I looked at. Likely the path that handles
  individually-shared (not via team space) projects. If you migrate a
  project that was shared with you out of someone else's space, this
  is presumably where it lives, and the rewrite logic above probably
  doesn't cover it.
- **`Revisions` and design history.** The migration tool throws this
  away. Whether the app ever tries to re-upload a migrated project as
  a brand new cloud project, and whether doing so reconstructs any
  meaningful history, I haven't tested.
- **`ProjectsWithoutMetadata`.** Empty in both DBs I looked at. Name
  suggests a quarantine table for projects that the cloud knows about
  but whose metadata is missing locally.
- **`ChangeSeqNo`.** A single-row table with one monotonic integer.
  Used as a logical clock for "next change number" within the local
  DB. The migration tool advances it past every row it inserts; it's
  unclear whether the cloud cares about contiguity.
- **`createID`.** Always 0 in the data I have. Possibly an
  ID-generation strategy field that's been retired.
- **iPad / iOS / Windows.** All this is macOS only. The on-disk
  layout on iPad is presumably different (sandbox path differs at
  minimum), and I haven't checked any of it.

---

## Acknowledgements / non-acknowledgements

This was reverse-engineered from observing on-disk state, not from any
Shapr3D source, documentation, or proprietary information. Shapr3D
itself supports project migration via their native `.shapr` export
format on Pro tier subscriptions, and that's still the only
*supported* path. This doc is for cases where that path isn't
available — typically, a legacy account whose subscription has lapsed
and which had Cloud Sync turned off so the cloud never received a
copy.

The tool that puts this into practice is **`shapr3d-migrate`**.
