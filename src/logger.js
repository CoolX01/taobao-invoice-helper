'use strict';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = LEVELS.info;

/**
 * 设置最低输出级别
 * @param {'debug'|'info'|'warn'|'error'} level
 */
function setLogLevel(level) {
  if (LEVELS[level] === undefined) {
    throw new Error(`Invalid log level: ${level}`);
  }
  currentLevel = LEVELS[level];
}

/**
 * 结构化日志输出
 * @param {'info'|'warn'|'error'|'debug'} level
 * @param {string|null} orderId
 * @param {string} action
 * @param {string} message
 * @param {object} [meta]
 */
function log(level, orderId, action, message, meta) {
  if (LEVELS[level] === undefined) {
    level = 'info';
  }
  if (LEVELS[level] < currentLevel) {
    return;
  }

  const entry = {
    ts: new Date().toISOString(),
    level,
    orderId: orderId || null,
    action,
    msg: message,
  };

  if (meta && Object.keys(meta).length > 0) {
    entry.meta = meta;
  }

  const line = JSON.stringify(entry);

  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

module.exports = { log, setLogLevel, LEVELS };
