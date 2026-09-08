/** Log severity levels, ordered from most to least verbose. */
export enum LogLevel {
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
  Silent = 5,
}

export interface Logger {
  trace(message: string, ...meta: unknown[]): void;
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

/** A logger that writes to the console, filtered by {@link LogLevel}. */
export class ConsoleLogger implements Logger {
  constructor(private level: LogLevel = LogLevel.Info) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  trace(message: string, ...meta: unknown[]): void {
    this.log(LogLevel.Trace, "trace", message, meta);
  }

  debug(message: string, ...meta: unknown[]): void {
    this.log(LogLevel.Debug, "debug", message, meta);
  }

  info(message: string, ...meta: unknown[]): void {
    this.log(LogLevel.Info, "info", message, meta);
  }

  warn(message: string, ...meta: unknown[]): void {
    this.log(LogLevel.Warn, "warn", message, meta);
  }

  error(message: string, ...meta: unknown[]): void {
    this.log(LogLevel.Error, "error", message, meta);
  }

  private log(level: LogLevel, label: string, message: string, meta: unknown[]): void {
    if (level < this.level) {
      return;
    }
    const prefix = `[dap-client:${label}]`;
    if (meta.length > 0) {
      console.error(prefix, message, ...meta);
    } else {
      console.error(prefix, message);
    }
  }
}

/** A logger that discards everything. Handy as a default. */
export const noopLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
