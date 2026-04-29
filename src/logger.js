// Module: Logger
//
// Shared logger for standalone HAP-NodeJS applications.
// Inspired by the Homebridge logger, but simplified for direct application use.
//
// Taken from https://github.com/homebridge/homebridge/blob/latest/src/logger.ts
// Converted back to JS for using under HAP-NodeJS library directly.
//
// Provides terminal logging and colour formatting only.
//
// Responsibilities:
// - Provide prefixed log functions for each application/module
// - Format messages using util.format(...) style placeholders
// - Colour terminal output by log level
// - Write formatted output to console.log / console.error
//
// Notes:
// - Prefixes are instance-specific and used only for formatting
// - Debug logging is disabled by default
//
// Code version 2026.04.29
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import console from 'node:console';
import process from 'node:process';
import util from 'node:util';

// Define external module requirements
import chalk from 'chalk';

// Define log level constants
export const LogLevel = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

// Define our logger class
export default class Logger {
  // Shared logger state
  static #debugEnabled = false; // Debug logging disabled by default
  static #timestampEnabled = true; // Timestamp logging enabled by default

  static internal = new Logger();

  prefix = undefined;

  constructor(prefix = undefined) {
    // Store optional prefix for display formatting only.
    this.prefix = typeof prefix === 'string' && prefix !== '' ? prefix : undefined;

    // Force ANSI when explicitly requested or when running under non-TTY environments such as systemd/journald.
    if (process.env.FORCE_COLOR !== undefined) {
      chalk.level =
        Number.isFinite(Number(process.env.FORCE_COLOR)) && Number(process.env.FORCE_COLOR) > 0 ? Number(process.env.FORCE_COLOR) : 1;
    } else if (process.stdout.isTTY !== true) {
      chalk.level = 1;
    }
  }

  static withPrefix(prefix) {
    // Create a callable Homebridge-style logger: log(...), log.info(...), log.warn(...), etc.
    let logger = new Logger(prefix);
    let log = logger.info.bind(logger);

    log.info = logger.info.bind(logger);
    log.success = logger.success.bind(logger);
    log.warn = logger.warn.bind(logger);
    log.error = logger.error.bind(logger);
    log.debug = logger.debug.bind(logger);
    log.log = logger.log.bind(logger);
    log.prefix = logger.prefix;

    return log;
  }

  static setDebugEnabled(enabled = true) {
    // Debug logs can be noisy, so they are globally controlled.
    Logger.#debugEnabled = enabled === true;
  }

  static setTimestampEnabled(enabled = true) {
    // Timestamps are global so all logger instances use the same format behaviour.
    Logger.#timestampEnabled = enabled === true;
  }

  static forceColor(level = 1) {
    // Force ANSI colour support when the runtime cannot auto-detect it.
    chalk.level = Number.isFinite(Number(level)) && Number(level) > 0 ? Number(level) : 1;
  }

  info(message, ...parameters) {
    this.log(LogLevel.INFO, message, ...parameters);
  }

  success(message, ...parameters) {
    this.log(LogLevel.SUCCESS, message, ...parameters);
  }

  warn(message, ...parameters) {
    this.log(LogLevel.WARN, message, ...parameters);
  }

  error(message, ...parameters) {
    this.log(LogLevel.ERROR, message, ...parameters);
  }

  debug(message, ...parameters) {
    this.log(LogLevel.DEBUG, message, ...parameters);
  }

  log(level, message, ...parameters) {
    // Debug messages are ignored unless debug has been explicitly enabled.
    if (level === LogLevel.DEBUG && Logger.#debugEnabled !== true) {
      return;
    }

    // Normalise invalid levels back to info so custom callers cannot break output.
    if (Object.values(LogLevel).includes(level) === false) {
      level = LogLevel.INFO;
    }

    // util.format keeps existing logger behaviour for "%s", "%d", objects, etc.
    let terminalMessage = util.format(message, ...parameters);
    let loggingFunction = console.log;

    // Apply level colour to the message body only. Prefix and timestamp are added afterwards.
    if (level === LogLevel.SUCCESS) {
      terminalMessage = chalk.green(terminalMessage);
    }
    if (level === LogLevel.WARN) {
      terminalMessage = chalk.yellow(terminalMessage);
      loggingFunction = console.error;
    }
    if (level === LogLevel.ERROR) {
      terminalMessage = chalk.red(terminalMessage);
      loggingFunction = console.error;
    }
    if (level === LogLevel.DEBUG) {
      terminalMessage = chalk.gray(terminalMessage);
    }

    // Add optional prefix after colourising the message. This mirrors Homebridge-style output.
    if (this.prefix !== undefined) {
      terminalMessage = chalk.cyan('[' + this.prefix + ']') + ' ' + terminalMessage;
    }

    // Add timestamp last so terminal output matches the final console line.
    if (Logger.#timestampEnabled === true) {
      terminalMessage = chalk.white('[' + new Date().toLocaleString() + '] ') + terminalMessage;
    }

    // Write formatted output to console
    loggingFunction(terminalMessage);
  }
}

export function getLogPrefix(prefix) {
  // Return a coloured Homebridge-style prefix.
  return chalk.cyan('[' + prefix + ']');
}
