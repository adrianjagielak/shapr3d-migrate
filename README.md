# shapr3d-migrate

A small command-line tool for **macOS** that backs up Shapr3D's local
container, and restores a backup into another account by rewriting the
account-binding fields inside Shapr3D's local SQLite databases.

This is **unsupported** by Shapr3D. It works against undocumented
internal data structures and may break with future app updates. Don't use
it on data you don't have a separate copy of.

## What it does

Shapr3D's macOS container at `~/Library/Containers/com.shapr3d.shapr/`
holds three things that matter:

- **Project files** under `Documents/projects/<projectID>/<slotID>/`
  (a `workspace` SQLite per project — your actual model).
- **Project metadata** in
  `Library/Application Support/com.shapr3d.shapr/storage/projectStorage.db`
  (titles, folder paths, owner `userID`, `spaceID`, sync state).
- **Thumbnails** in `…/storage/resources/`.

Every row in `projectStorage.db` is bound to a `userID` and a `spaceID`.
If you sign out and into a different account, the new app session sees
the projects as belonging to a stranger and ignores them. This tool
rewrites those identifiers so projects "belong" to whichever account is
currently signed in on the destination machine.

It does this **non-destructively** for the destination: existing
projects in the destination account are kept; migrated projects are
*added* alongside them.

## Requirements

- macOS (relies on `pgrep`, `/usr/bin/zip`, `/usr/bin/unzip`, all part
  of the base system)
- Node.js 22.5 or later (for the built-in `node:sqlite` module — no
  native compile step needed)
- Shapr3D fully **quit** before you run any command

## Install

The tool has zero npm dependencies and zero native compile steps.
Clone, run:

```bash
git clone <this repo> && cd shapr3d-migrate
node bin/cli.js --help
```

If you want it on `$PATH` as `shapr3d-migrate`:

```bash
npm link    # or: ln -s "$(pwd)/bin/cli.js" /usr/local/bin/shapr3d-migrate
```

## Commands

### `backup`

```bash
shapr3d-migrate backup [--out <zip>] [--force]
```

Quit-checks Shapr3D, then zips the live container's `Data/` directory
into a single `.zip`. Default output path:

```
~/Downloads/Shapr3D_backup_<YYYY-MM-DD>.zip
```

Skips `.DS_Store`, SQLite WAL/SHM/journal sidecar files, and symlinks.

### `restore`

```bash
shapr3d-migrate restore <backup.zip> [options]
```

Quit-checks Shapr3D, snapshots the destination container, extracts the
backup to a temp directory, and merges:

- `Folders` rows from the source userID, with `spaceID` rewritten to the
  destination's matching space (private → private, team → team).
- `Projects` rows from the source userID, with `userID` and `spaceID`
  rewritten and remote-sync fields cleared so each migrated project
  looks like a fresh, never-uploaded local project.
- A fresh `Slots` row per project (with a new slotID UUID and
  `revisionID = NULL`, signalling "unsynced local changes").
- The on-disk project directory at `projects/<projectID>/<slotID>/`,
  copied from the backup.
- Both thumbnails per project, into `storage/resources/`.

Then:

- Removes the destination's `sync.db` so the app rebuilds its sync
  queue from scratch on next launch (clears stale references to any
  pre-migration state).

#### Options

| flag                     | default | meaning                                                                                                                                                                                                                                          |
|--------------------------|---------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `--from-user <uuid>`     | largest | If the backup contains projects from more than one userID (e.g. a machine that was signed in to several accounts over time), pick which one to migrate. Defaults to the userID with the most active projects.                                    |
| `--include-deleted`      | false   | Also import projects with `isDeleted = 1`.                                                                                                                                                                                                       |
| `--include-temporary`    | false   | Also import projects with `isTemporary = 1`.                                                                                                                                                                                                     |
| `--keep-remote`          | false   | Do **not** clear `remoteID` / `revisionID` / `remoteHeadRevisionID` / `remoteChangeSeqNo`. Only meaningful if you are also having Shapr3D transfer cloud ownership of those projects to the destination account — otherwise leaves dangling refs to the source account's cloud objects. |
| `--no-snapshot`          | false   | Skip the safety snapshot of the destination container. Faster, but no rollback path.                                                                                                                                                              |
| `--dry-run`              | false   | Print the plan and exit. Doesn't write anything.                                                                                                                                                                                                 |
| `--force`                | false   | Skip the running-process check (use only if you're sure Shapr3D really isn't running).                                                                                                                                                           |

### `inspect`

```bash
shapr3d-migrate inspect              # the live container
shapr3d-migrate inspect <backup.zip> # a backup zip
shapr3d-migrate inspect <directory>  # an already-extracted backup
```

Reports the account identity, project counts (active / temp / deleted /
cloud-only), and the 12 most recently modified projects.

## Typical workflow

```bash
# 1. On the OLD machine (or the machine where the OLD account is signed in):
shapr3d-migrate backup --out ~/Downloads/old-account-backup.zip

# 2. Switch to the NEW account: in Shapr3D, sign out, sign in to the
#    destination account, let it complete first-time setup, then ⌘Q.

# 3. See what's in the backup and confirm the destination looks right:
shapr3d-migrate inspect ~/Downloads/old-account-backup.zip
shapr3d-migrate inspect

# 4. Dry-run the migration:
shapr3d-migrate restore ~/Downloads/old-account-backup.zip --dry-run

# 5. Do it for real:
shapr3d-migrate restore ~/Downloads/old-account-backup.zip

# 6. Open Shapr3D. Verify the migrated projects appear in the dashboard.

# 7. When you're confident everything works, drop the safety snapshot:
rm -rf ~/Library/Containers/com.shapr3d.shapr.snapshot-*
```

## What the tool does **not** touch

- Anything under `Library/Caches/`, `Library/HTTPStorages/`,
  `Library/Cookies/`, `Library/WebKit/`, `Library/Logs/`, `tmp/`,
  `SystemData/`. These are auth, network and cache state for the
  destination account and you want them as they are.
- `user.db` — keeps the destination account's cached profile.
- Auth tokens — those live in the macOS Keychain, not in the container.
- Older "design history" / Revisions of migrated projects. The migrated
  project starts as if it were just authored locally, with no version
  history attached. The current state of the model is preserved in
  full; older revisions in the source account's cloud are not pulled
  down.

## Caveats and known sharp edges

- **Schema versions change.** This tool reads the destination DB's
  schema at runtime and intersects against the backup's columns, with
  one explicit rename map (`remoteRevisionID` → `remoteHeadRevisionID`,
  observed between Shapr3D 26.32 and 26.70). If a future version
  introduces *new required* columns or tables that the migration must
  populate (e.g. another mandatory child of `Projects`), inserts will
  fail until the tool is updated. The transaction will roll back and
  the snapshot is preserved, so this is a "didn't migrate" failure
  mode, not a "destroyed your data" failure mode.
- **`--keep-remote` is rarely what you want.** Source-account
  `remoteID`/`revisionID` values point at cloud objects owned by the
  source account. Keeping them in the destination DB will cause the
  app to think the destination account already has those cloud
  objects, with the obvious confusion that ensues.
- **`isTemporary = 1` is for scratch projects.** Skipped by default
  because those usually aren't worth keeping; pass `--include-temporary`
  if you want them anyway.
- **Folders that only existed under spaces this tool doesn't know
  how to map** (shared spaces, deleted spaces) are dropped onto the
  destination's private space.
- **Shapr3D's own export to `.shapr` is still the supported mechanism
  for cross-account moves.** Use it instead of this tool whenever the
  source account is accessible and on a Pro tier. This tool exists for
  the case where that's not practical (e.g. local-only legacy data,
  expired subscription on the source account).

## Recovery / rollback

By default the tool snapshots the destination container before
modifying it. The snapshot lives next to the original:

```
~/Library/Containers/com.shapr3d.shapr.snapshot-<timestamp>/
```

To roll back:

```bash
# quit Shapr3D first
rm -rf ~/Library/Containers/com.shapr3d.shapr
mv  ~/Library/Containers/com.shapr3d.shapr.snapshot-<timestamp> \
    ~/Library/Containers/com.shapr3d.shapr
```

## Environment variables

- `SHAPR3D_CONTAINER` — override the container path the tool reads
  from / writes to. Useful for testing or for non-standard setups.
- `SHAPR3D_DEBUG=1` — print per-project decisions (skip reasons,
  rename mappings).
- `NO_COLOR=1` — disable ANSI colour output.
