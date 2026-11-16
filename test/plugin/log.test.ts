import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import fc from 'fast-check';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { appendDisabledOnce, appendLog, logPath, redact, type LogEntry } from '../../plugins/h7/scripts/log.ts';
import { cleanupTmp, tmpDir, runs } from '../../scripts/test/helpers.ts';

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

describe('redaction', () => {
  const cases: [string, string][] = [
    ['curl --token abc123SECRET https://x', 'abc123SECRET'],
    ['tool --token=abc123SECRET', 'abc123SECRET'],
    ['tool --password "p4ss w0rd9" next', 'p4ss'],
    ["tool --secret 'sh h9 shh'", 'shh'],
    ['tool --passwd=zzTopSecret1', 'zzTopSecret1'],
    ['tool --pass zzTopSecret1', 'zzTopSecret1'],
    ['tool --auth-token=zzTopSecret1', 'zzTopSecret1'],
    ['tool --api-key zzTopSecret1', 'zzTopSecret1'],
    ['mysql -pzzTopSecret1 db', 'zzTopSecret1'],
    ['curl -H "Authorization: Bearer zzTopSecret1" x', 'zzTopSecret1'],
    ["curl -H 'Authorization: Basic zzTopSecret1==' x", 'zzTopSecret1'],
    ['curl -H Authorization:zzTopSecret1 x', 'zzTopSecret1'],
    ['curl --header "authorization=token zzTopSecret1"', 'zzTopSecret1'],
    ['echo Bearer zzTopSecret1', 'zzTopSecret1'],
    ['git clone https://user:zzTopSecret1@github.com/a/b', 'zzTopSecret1'],
    ['git push https://u:zzTopSecret1@h/x', 'zzTopSecret1'],
    ['GITHUB_TOKEN=zzTopSecret1 gh pr merge 1', 'zzTopSecret1'],
    ['API_KEY="zz Top Secret1" run', 'Secret1'],
    ['export DB_PASSWORD=zzTopSecret1; run', 'zzTopSecret1'],
    ['MY_SECRET=zzTopSecret1 x', 'zzTopSecret1'],
    ['$env:NPM_AUTH = "zzTopSecret1"', 'zzTopSecret1'],
    ['PASS=zzTopSecret1 git commit', 'zzTopSecret1'],
  ];

  it('removes the secret in every supported form', () => {
    for (const [command, secret] of cases) {
      const out = redact(command);
      assert.ok(!out.includes(secret), `${command} -> ${out}`);
      assert.ok(out.includes('[REDACTED]'), out);
    }
  });

  it('keeps harmless commands intact', () => {
    for (const command of ['git push --force origin main', 'git commit -m "fix: keyboard"', 'rm -rf dist', 'git push -p', 'ssh://git@host/x']) {
      assert.equal(redact(command), command);
    }
  });

  it('property: generated secrets never reach the log line', () => {
    const secret = fc.stringMatching(/^[A-Za-z0-9]{12,24}$/);
    const templates: ((s: string) => string)[] = [
      (s) => `curl --token ${s} u`,
      (s) => `curl --token=${s} u`,
      (s) => `x --password '${s}'`,
      (s) => `x --secret "${s}" y`,
      (s) => `mysql -p${s}`,
      (s) => `curl -H "Authorization: Bearer ${s}" u`,
      (s) => `curl -H "Authorization: Basic ${s}" u`,
      (s) => `curl -H 'X: Bearer ${s}'`,
      (s) => `git clone https://bob:${s}@host/r.git`,
      (s) => `NPM_TOKEN=${s} npm publish`,
      (s) => `SOME_API_KEY="${s}" run`,
      (s) => `export DB_PASS=${s}`,
      (s) => `$env:GH_AUTH = '${s}'`,
    ];
    fc.assert(
      fc.property(secret, fc.constantFrom(...templates), (value, template) => {
        const home = tmpDir();
        appendLog(home, entry({ command: `${template(value)} # ${'x'.repeat(5)}`, cwd: '/c' }));
        appendLog(home, entry({ command: 'ok', error: template(value) }));
        const text = readFileSync(logPath(home), 'utf8');
        assert.ok(!text.includes(value), text);
      }),
      { numRuns: runs(150) },
    );
  });

  it('redacts before truncating so a cut cannot leak a prefix', () => {
    const home = tmpDir();
    appendLog(home, entry({ command: `${'a'.repeat(490)} --token zzTopSecret1234567` }));
    assert.ok(!readFileSync(logPath(home), 'utf8').includes('zzTop'));
  });

  it('creates the directory and file with private permissions on POSIX', { skip: process.platform === 'win32' }, () => {
    const home = tmpDir();
    appendLog(home, entry());
    assert.equal(statSync(join(home, '.h7')).mode & 0o777, 0o700);
    assert.equal(statSync(logPath(home)).mode & 0o777, 0o600);
  });
});
