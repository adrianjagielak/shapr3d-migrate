'use strict';

// Tiny ANSI-only logging helpers, no chalk dep. Auto-disable on non-TTY.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s);

const c = {
  bold:  wrap('1'),
  dim:   wrap('2'),
  red:   wrap('31'),
  green: wrap('32'),
  yellow:wrap('33'),
  blue:  wrap('34'),
  cyan:  wrap('36'),
  gray:  wrap('90'),
};

const ts = () => new Date().toISOString().slice(11, 19);

function info(...args)  { console.log(c.gray(ts()),               ...args); }
function step(...args)  { console.log(c.gray(ts()), c.cyan('•'),  ...args); }
function ok(...args)    { console.log(c.gray(ts()), c.green('✓'), ...args); }
function warn(...args)  { console.log(c.gray(ts()), c.yellow('!'),...args); }
function err(...args)   { console.error(c.gray(ts()), c.red('✗'), ...args); }
function header(t)      { console.log('\n' + c.bold(t)); }
function debug(...args) { if (process.env.SHAPR3D_DEBUG) console.log(c.gray(ts() + ' [debug]'), ...args); }

module.exports = { c, info, step, ok, warn, err, header, debug };
