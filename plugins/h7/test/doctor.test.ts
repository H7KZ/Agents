import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { main, nodeAtLeast, runChecks, spawnRun, summarize, type Check, type DoctorEnv, type RunResult } from '../scripts/doctor.ts';
import { SLOW, cleanupTmp, runNode, tmpDir, writeTree } from '../../../scripts/test/helpers.ts';

cleanupTmp();

const OK: RunResult = { status: 0, stdout: 'v 1.0\nsecond line' };
const BAD: RunResult = { status: 1, stdout: '' };

function env(over: Partial<DoctorEnv> & { files?: Record<string, string>; fail?: string[] } = {}): DoctorEnv {
  const home = over.home ?? tmpDir();
  writeTree(home, over.files ?? {});
  return {
    home,
    nodeVersion: over.nodeVersion ?? '24.1.0',
    run: over.run ?? ((command, args) => (over.fail?.includes([command, ...args].join(' ')) ? BAD : OK)),
  };
}

const byId = (checks: Check[], id: string): Check => checks.find((c) => c.id === id) as Check;

const healthyFiles = {
  '.claude/plugins/known_marketplaces.json': JSON.stringify({ h7kz: { source: { source: 'github', repo: 'H7KZ/Agents' } } }),
  '.claude/settings.json': JSON.stringify({ extraKnownMarketplaces: { h7kz: { source: { source: 'github', repo: 'H7KZ/Agents' }, autoUpdate: true } } }),
  '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'mattpocock-skills@claude-plugins-official': [], 'h7@h7kz': [] } }),
  '.h7/.keep': '',
};

describe('nodeAtLeast', () => {
  it('compares major and minor against 22.18', () => {
    assert.ok(nodeAtLeast('22.18.0'));
    assert.ok(nodeAtLeast('v22.18.5'));
    assert.ok(nodeAtLeast('22.19.0'));
    assert.ok(nodeAtLeast('23.0.0'));
    assert.ok(nodeAtLeast('26.3.0'));
    assert.ok(!nodeAtLeast('22.17.9'));
    assert.ok(!nodeAtLeast('22.0.0'));
    assert.ok(!nodeAtLeast('20.19.0'));
    assert.ok(!nodeAtLeast('22'));
    assert.ok(!nodeAtLeast('nonsense'));
    assert.ok(nodeAtLeast('22.18', [22, 18]));
  });

  it('property: agrees with tuple comparison', () => {
    fc.assert(
      fc.property(fc.nat(40), fc.nat(40), fc.nat(40), (major, minor, patch) => {
        const expected = major > 22 || (major === 22 && minor >= 18);
        assert.equal(nodeAtLeast(`${major}.${minor}.${patch}`), expected);
      }),
    );
  });
});

describe('runChecks on a healthy machine', () => {
  it('passes everything', () => {
    const checks = runChecks(env({ files: healthyFiles }));
    assert.deepEqual(checks.map((c) => [c.id, c.status]), [
      ['node', 'pass'],
      ['git', 'pass'],
      ['gh', 'pass'],
      ['gh-auth', 'pass'],
      ['claude', 'pass'],
      ['marketplace', 'pass'],
      ['auto-update', 'pass'],
      ['mattpocock', 'pass'],
      ['mattpocock-duplicates', 'pass'],
      ['h7-dir', 'pass'],
    ]);
    assert.equal(byId(checks, 'git').detail, 'v 1.0');
    assert.equal(byId(checks, 'node').detail, 'node 24.1.0');
    assert.ok(checks.every((c) => c.fix === undefined));
  });
});

describe('runChecks failures', () => {
  it('fails node, tools and gh auth with fixes', () => {
    const checks = runChecks(env({ files: healthyFiles, nodeVersion: '20.0.0', fail: ['git --version', 'gh --version', 'gh auth status', 'claude --version'] }));
    for (const id of ['node', 'git', 'gh', 'gh-auth', 'claude']) {
      assert.equal(byId(checks, id).status, 'fail', id);
      assert.ok((byId(checks, id).fix ?? '').length > 0, id);
    }
    assert.match(byId(checks, 'node').detail, /20\.0\.0 is older than 22\.18/);
    assert.match(byId(checks, 'gh-auth').fix as string, /gh auth login/);
  });

  it('fails an unknown marketplace and warns about auto-update', () => {
    const checks = runChecks(env({ files: { '.h7/.keep': '' } }));
    assert.equal(byId(checks, 'marketplace').status, 'fail');
    assert.match(byId(checks, 'marketplace').fix as string, /marketplace add H7KZ\/Agents/);
    assert.equal(byId(checks, 'auto-update').status, 'warn');
  });

  it('accepts autoUpdate from known_marketplaces.json, a local directory marketplace, and fails otherwise', () => {
    const known = (entry: object) => ({ '.claude/plugins/known_marketplaces.json': JSON.stringify({ h7kz: entry }) });
    assert.equal(byId(runChecks(env({ files: known({ autoUpdate: true }) })), 'auto-update').status, 'pass');
    const local = runChecks(env({ files: known({ source: { source: 'directory', path: '/x' } }) }));
    assert.match(byId(local, 'marketplace').detail, /local directory/);
    assert.match(byId(local, 'auto-update').detail, /not needed/);
    const off = runChecks(env({ files: { ...known({ source: { source: 'github' } }), '.claude/settings.json': JSON.stringify({ extraKnownMarketplaces: { h7kz: { autoUpdate: false } } }) } }));
    assert.equal(byId(off, 'auto-update').status, 'fail');
    assert.match(byId(off, 'auto-update').fix as string, /autoUpdate/);
    const noSettings = runChecks(env({ files: known({}) }));
    assert.equal(byId(noSettings, 'auto-update').status, 'fail');
  });

  it('fails when mattpocock-skills is missing from the official marketplace', () => {
    const checks = runChecks(env({ files: { ...healthyFiles, '.claude/plugins/installed_plugins.json': '{"plugins":{}}' } }));
    assert.equal(byId(checks, 'mattpocock').status, 'fail');
    assert.match(byId(checks, 'mattpocock').fix as string, /claude plugin install mattpocock-skills@claude-plugins-official/);
  });

  it('reports the legacy plugin copy as a duplicate', () => {
    const files = { ...healthyFiles, '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'mattpocock-skills@claude-plugins-official': [], 'mattpocock-skills@local-desktop-app-uploads': [] } }) };
    const dupes = byId(runChecks(env({ files })), 'mattpocock-duplicates');
    assert.equal(dupes.status, 'fail');
    assert.match(dupes.detail, /plugin mattpocock-skills@local-desktop-app-uploads/);
    assert.match(dupes.fix as string, /claude plugin uninstall mattpocock-skills@local-desktop-app-uploads/);
  });

  it('reports skill symlinks into ~/.agents/skills, abbreviating long lists', () => {
    const e = env({ files: { ...healthyFiles, '.agents/.skill-lock.json': JSON.stringify({ skills: Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [n, { source: 'mattpocock/skills' }])) }) } });
    mkdirSync(join(e.home, '.claude', 'skills'), { recursive: true });
    for (const name of ['a', 'b', 'c']) {
      mkdirSync(join(e.home, '.agents', 'skills', name), { recursive: true });
      symlinkSync(join(e.home, '.agents', 'skills', name), join(e.home, '.claude', 'skills', name), 'junction');
    }
    const three = byId(runChecks(e), 'mattpocock-duplicates');
    assert.match(three.detail, /3 skill symlink\(s\).*\(a, b, c\)/);
    mkdirSync(join(e.home, '.agents', 'skills', 'd'), { recursive: true });
    symlinkSync(join(e.home, '.agents', 'skills', 'd'), join(e.home, '.claude', 'skills', 'd'), 'junction');
    const four = byId(runChecks(e), 'mattpocock-duplicates');
    assert.match(four.detail, /4 skill symlink\(s\).*\(a, b, c, \.\.\.\)/);
    assert.match(four.fix as string, /remove those symlinks/);
  });

  it('reports both duplicate kinds together', () => {
    const files = { ...healthyFiles, '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'mattpocock-skills@local-desktop-app-uploads': [] } }), '.agents/.skill-lock.json': JSON.stringify({ skills: { a: { source: 'mattpocock/skills' } } }) };
    const e = env({ files });
    mkdirSync(join(e.home, '.agents', 'skills', 'a'), { recursive: true });
    mkdirSync(join(e.home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(e.home, '.agents', 'skills', 'a'), join(e.home, '.claude', 'skills', 'a'), 'junction');
    const dupes = byId(runChecks(e), 'mattpocock-duplicates');
    assert.match(dupes.detail, /plugin .*; 1 skill symlink/);
    assert.match(dupes.fix as string, / and remove those symlinks/);
  });

  it('fails when ~/.h7 is missing or is a file', () => {
    const missing = byId(runChecks(env({ files: {} })), 'h7-dir');
    assert.equal(missing.status, 'fail');
    assert.match(missing.fix as string, /mkdir /);
    const file = byId(runChecks(env({ files: { '.h7': 'a file' } })), 'h7-dir');
    assert.equal(file.status, 'fail');
  });
});

describe('summarize and main', () => {
  it('counts statuses', () => {
    const checks: Check[] = [
      { id: 'a', status: 'pass', detail: '' },
      { id: 'b', status: 'warn', detail: '' },
      { id: 'c', status: 'fail', detail: '' },
      { id: 'd', status: 'fail', detail: '' },
    ];
    assert.deepEqual(summarize(checks), { ok: false, pass: 1, warn: 1, fail: 2 });
    assert.deepEqual(summarize(checks.slice(0, 2)), { ok: true, pass: 1, warn: 1, fail: 0 });
    assert.deepEqual(summarize([]), { ok: true, pass: 0, warn: 0, fail: 0 });
  });

  it('prints JSON with summary and checks and exits 0 even on failures', () => {
    const out: string[] = [];
    assert.equal(main(env({ files: {}, fail: ['gh auth status'] }), (t) => out.push(t)), 0);
    const parsed = JSON.parse(out[0] as string);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.fail >= 1);
    assert.equal(parsed.checks.length, 10);
    assert.deepEqual(Object.keys(parsed).slice(0, 4), ['ok', 'pass', 'warn', 'fail']);
  });
});

describe('spawnRun', SLOW, () => {
  it('runs real commands through the shell', () => {
    const ok = spawnRun('node', ['--version']);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /^v\d+/);
    assert.notEqual(spawnRun('definitely-not-a-command-h7', []).status, 0);
  });
});

describe('doctor.ts as a subprocess', SLOW, () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'doctor.ts');

  it('emits JSON for an empty home using H7_HOME', () => {
    const home = tmpDir();
    const result = runNode(script, [], { env: { H7_HOME: home } });
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.checks.find((c: Check) => c.id === 'marketplace').status, 'fail');
    assert.equal(parsed.checks.find((c: Check) => c.id === 'node').status, 'pass');
  });

  it('falls back to the real home directory', () => {
    const home = tmpDir();
    writeTree(home, { '.h7/.keep': '' });
    const result = runNode(script, [], { env: { H7_HOME: undefined, HOME: home, USERPROFILE: home } });
    assert.equal(JSON.parse(result.stdout).checks.find((c: Check) => c.id === 'h7-dir').status, 'pass');
  });
});

describe('spawnRun with an injected spawner', () => {
  it('maps a failed spawn (null stdout) to an empty string', () => {
    const fake = (() => ({ status: null, stdout: null })) as unknown as typeof import('node:child_process').spawnSync;
    assert.deepEqual(spawnRun('x', ['y'], fake), { status: null, stdout: '' });
  });
});
