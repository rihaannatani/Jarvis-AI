'use strict';
const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const config = require('./config');

const { combine, timestamp, colorize, printf, errors } = format;

const logFormat = printf(({ level, message, timestamp: ts, stack }) => {
  return `${ts} [${level}]: ${stack || message}`;
});

const logger = createLogger({
  level: config.app.logLevel,
  format: combine(errors({ stack: true }), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
  transports: [
    new transports.Console({
      format: combine(colorize(), errors({ stack: true }), timestamp({ format: 'HH:mm:ss' }), logFormat),
    }),
    new DailyRotateFile({
      dirname: path.join(process.cwd(), 'logs'),
      filename: 'jarvis-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
    }),
    new DailyRotateFile({
      dirname: path.join(process.cwd(), 'logs'),
      filename: 'jarvis-error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '30d',
    }),
  ],
});

// The codebase's convention is logger.error('label:', err.message) — Winston only
// pulls message/stack out of an actual Error passed as metadata, so a trailing
// plain string (or Error) arg was being silently dropped instead of appended.
// Wrap the level methods to fold extra args into the log line so nothing vanishes.
function wrapLevel(level) {
  const original = logger[level].bind(logger);
  logger[level] = (message, ...args) => {
    if (!args.length) return original(message);
    const extra = args
      .map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join(' ');
    return original(`${message} ${extra}`);
  };
}

['error', 'warn', 'info', 'debug'].forEach(wrapLevel);

module.exports = logger;
