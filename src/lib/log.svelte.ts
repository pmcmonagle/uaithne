// Console drawer contents: engine logs, eval errors and app messages.
// Everything is mirrored to the terminal running the app.

import { frontendLog } from '$lib/ipc';

export type LogLevel = 'info' | 'warning' | 'error';

export interface LogLine {
  id: number;
  time: Date;
  source: string;
  level: LogLevel;
  message: string;
}

const MAX_LINES = 500;
let nextId = 0;

export const log = $state<{ lines: LogLine[]; unseenErrors: number }>({ lines: [], unseenErrors: 0 });

export function addLog(source: string, message: string, level: LogLevel = 'info') {
  log.lines.push({ id: nextId++, time: new Date(), source, level, message });
  if (log.lines.length > MAX_LINES) log.lines.splice(0, log.lines.length - MAX_LINES);
  if (level === 'error') log.unseenErrors++;
  frontendLog(level, source, message).catch(() => {});
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => addLog('js', `${e.message} (${e.filename}:${e.lineno})`, 'error'));
  window.addEventListener('unhandledrejection', (e) => addLog('js', `unhandled rejection: ${e.reason}`, 'error'));
}

export function clearLog() {
  log.lines = [];
  log.unseenErrors = 0;
}
