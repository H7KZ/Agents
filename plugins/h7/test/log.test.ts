import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { appendDisabledOnce, appendLog, logPath, type LogEntry } from '../scripts/log.ts';
import { cleanupTmp, tmpDir } from '../../../scripts/test/helpers.ts';

cleanupTmp();

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  ts: '2026-01-01T00:00:00.000Z',
  decision: 'block',
  rule: 'r',
  command: 'cmd',
  cwd: '/x',
  ...over,
});

const lines = (home: string): Record<string, unknown>[] =>
  readFileSync(logPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('guard log', () => {
  it('creates ~/.h7 and appends one JSON line per entry', () => {
    const home = tmpDir();
    assert.equal(appendLog(home, entry()), null);
    assert.equal(appendLog(home, entry({ rule: 's' })), null);
    assert.deepEqual(lines(home).map((l) => l.rule), ['r', 's']);
    assert.deepEqual(Object.keys(lines(home)[0] as object), ['ts', 'decision', 'rule', 'command', 'cwd']);
    assert.equal(logPath(home), join(home, '.h7', 'guard.log'));
  });

  it('truncates commands to 500 characters', () => {
    const home = tmpDir();
    appendLog(home, entry({ command: 'x'.repeat(501) }));
    appendLog(home, entry({ command: 'y'.repeat(500) }));
    assert.equal((lines(home)[0] as { command: string }).command.length, 500);
    assert.equal((lines(home)[1] as { command: string }).command.length, 500);
  });

  it('returns the error message instead of throwing', () => {
    const home = tmpDir();
    writeFileSync(join(home, '.h7'), 'a file, not a directory');
    assert.match(appendLog(home, entry()) ?? '', /\S/);
  });

  it('logs the disabled marker once per disabled stretch', () => {
    const home = tmpDir();
    assert.equal(appendDisabledOnce(home, entry({ decision: 'disabled' })), null);
    assert.equal(appendDisabledOnce(home, entry({ decision: 'disabled' })), null);
    assert.equal(lines(home).length, 1);
    appendLog(home, entry());
    appendDisabledOnce(home, entry({ decision: 'disabled' }));
    assert.equal(lines(home).length, 3);
  });

  it('tolerates an empty or missing log when checking the marker', () => {
    const home = tmpDir();
    mkdirSync(join(home, '.h7'));
    writeFileSync(logPath(home), '');
    appendDisabledOnce(home, entry({ decision: 'disabled' }));
    assert.equal(lines(home).length, 1);
  });
});
