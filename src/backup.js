'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const log = require('./log');
const paths = require('./paths');
const procheck = require('./procheck');
const zipMod = require('./zip');

function defaultOutPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(os.homedir(), 'Downloads', `Shapr3D_backup_${date}.zip`);
}

function backupCommand({ out, force }) {
  if (!force) procheck.assertShapr3DNotRunning();
  const root = paths.findContainerRoot();
  const L = paths.layout(root);

  const dataDir = L.data;
  if (!fs.existsSync(dataDir)) throw new Error(`Data directory missing under ${root}`);

  const outZip = path.resolve(out || defaultOutPath());
  if (fs.existsSync(outZip)) {
    if (!force) throw new Error(`refusing to overwrite ${outZip} (use --force)`);
    fs.rmSync(outZip);
  }

  const t0 = Date.now();
  log.step(`backing up ${dataDir}`);
  log.step(`writing ${outZip}`);
  zipMod.zipContainerData(dataDir, outZip);
  const sizeMB = (fs.statSync(outZip).size / (1024 * 1024)).toFixed(1);
  log.ok(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${sizeMB} MiB`);
  console.log(outZip);
}

module.exports = { backupCommand };
