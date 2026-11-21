// One small logger so no other file calls console directly.
// Level comes from LOG_LEVEL and is read on every call so tests can silence it.
type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentThreshold(): number {
  const setting = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (setting === "silent") return Infinity;
  return order[setting as Level] ?? order.info;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  function write(level: Level, message: string, fields?: Record<string, unknown>): void {
    if (order[level] < currentThreshold()) return;
    const extra = fields ? " " + JSON.stringify(fields) : "";
    process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}${extra}\n`);
  }
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
