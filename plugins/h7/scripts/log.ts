import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LogEntry {
  ts: string;
  decision: 'block' | 'ask' | 'error' | 'disabled' | 'allow';
  rule: string;
  command: string;
  cwd: string;
  error?: string;
  /** Recovery ref saved before an allowed destructive command. */
  ref?: string;
}

const COMMAND_LIMIT = 500;
const VALUE = /(?:"[^"]*"|'[^']*'|[^\s'"]+)/.source;
const SECRET_NAME = /[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH)[A-Za-z0-9_]*/.source;
const SECRET_FLAG = /--?(?:token|password|passwd|pass|secret|auth\w*|api-?key|access-?key|key)/.source;

const REDACTIONS: [RegExp, string][] = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:'"]+:)[^\s/@'"]+@/gi, '$1[REDACTED]@'],
  [/(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s'"]+/gi, '$1[REDACTED]'],
  [/\b(bearer|basic)\s+[^\s'"]+/gi, '$1 [REDACTED]'],
  [new RegExp(`(${SECRET_FLAG}(?:\\s*=\\s*|\\s+))${VALUE}`, 'gi'), '$1[REDACTED]'],
  [new RegExp(`(\\s-p)(?=\\S)${VALUE}`, 'g'), '$1[REDACTED]'],
  [new RegExp(`(\\b${SECRET_NAME}\\s*=\\s*)${VALUE}`, 'gi'), '$1[REDACTED]'],
];

export function redact(command: string): string {
  return REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), command);
}

export function logPath(home: string): string {
  return join(home, '.h7', 'guard.log');
}

export function appendLog(home: string, entry: LogEntry): string | null {
  try {
    mkdirSync(join(home, '.h7'), { recursive: true, mode: 0o700 });
    const safe = { ...entry, command: redact(entry.command).slice(0, COMMAND_LIMIT) };
    if (safe.error !== undefined) safe.error = redact(safe.error);
    const line = JSON.stringify(safe);
    appendFileSync(logPath(home), `${line}\n`, { mode: 0o600 });
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
