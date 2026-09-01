// Minimal structured logger + in-memory ring buffer the dashboard can read.

type Level = 'info' | 'warn' | 'error' | 'trade';

export interface LogEntry {
  time: number;
  level: Level;
  msg: string;
}

const RING_SIZE = 1000; // ~a day of per-minute SCAN heartbeats + events
const ring: LogEntry[] = [];

function push(level: Level, msg: string): void {
  const entry: LogEntry = { time: Date.now(), level, msg };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  const stamp = new Date(entry.time).toISOString();
  const line = `[${stamp}] ${level.toUpperCase()} ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string) => push('info', msg),
  warn: (msg: string) => push('warn', msg),
  error: (msg: string) => push('error', msg),
  trade: (msg: string) => push('trade', msg),
  recent: (): LogEntry[] => [...ring].reverse(),
};
