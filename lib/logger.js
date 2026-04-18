// Minimal structured logger. Zero runtime deps, writes JSON lines.
// Honours LOG_LEVEL=debug|info|warn|error (default info). In dev it prints
// a prettier single-line format for readability.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const level = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const pretty = process.env.LOG_FORMAT !== 'json' && process.env.NODE_ENV !== 'production';

function emit(lvl, msg, meta = {}) {
  if (LEVELS[lvl] < level) return;
  const rec = { ts: new Date().toISOString(), level: lvl, msg, ...meta };
  if (pretty) {
    const color = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[lvl];
    const rest = Object.entries(meta)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    // eslint-disable-next-line no-console
    console.log(`${color}${lvl.toUpperCase().padEnd(5)}\x1b[0m ${msg}${rest ? '  ' + rest : ''}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rec));
  }
}

export const logger = {
  debug: (m, meta) => emit('debug', m, meta),
  info:  (m, meta) => emit('info',  m, meta),
  warn:  (m, meta) => emit('warn',  m, meta),
  error: (m, meta) => emit('error', m, meta),
  child(fields = {}) {
    return {
      debug: (m, meta) => emit('debug', m, { ...fields, ...meta }),
      info:  (m, meta) => emit('info',  m, { ...fields, ...meta }),
      warn:  (m, meta) => emit('warn',  m, { ...fields, ...meta }),
      error: (m, meta) => emit('error', m, { ...fields, ...meta }),
    };
  },
};

export function makeRequestId() {
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
