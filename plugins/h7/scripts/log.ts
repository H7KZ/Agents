import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LogEntry {
  ts: string;
  decision: 'block' | 'ask' | 'error' | 'disabled';
  rule: string;
  command: string;
  cwd: string;
  error?: string;
}

const COMMAND_LIMIT = 500;

export function logPath(home: string): string {
  return join(home, '.h7', 'guard.log');
}

export function appendLog(home: string, entry: LogEntry): string | null {
  try {
    mkdirSync(join(home, '.h7'), { recursive: true });
    const line = JSON.stringify({ ...entry, command: entry.command.slice(0, COMMAND_LIMIT) });
    appendFileSync(logPath(home), `${line}\n`);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

function lastLine(home: string): string {
  try {
    const lines = readFileSync(logPath(home), 'utf8').split('\n').filter((line) => line !== '');
    return lines[lines.length - 1] ?? '';
  } catch {
    return '';
  }
}

export function appendDisabledOnce(home: string, entry: LogEntry): string | null {
  return lastLine(home).includes('"decision":"disabled"') ? null : appendLog(home, entry);
}
