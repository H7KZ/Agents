import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { runChecks, type Check, type DoctorEnv } from '../../plugins/h7/scripts/doctor.ts';
import { similarity, unmarkedCopies } from '../../plugins/h7/scripts/duplicates.ts';
import { MARKER } from '../../plugins/h7/scripts/workspace.ts';
import { cleanupTmp, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const healthy = {
  '.claude/plugins/known_marketplaces.json': JSON.stringify({ h7kz: { source: { source: 'github', repo: 'H7KZ/Agents' } } }),
  '.claude/settings.json': JSON.stringify({ extraKnownMarketplaces: { h7kz: { autoUpdate: true } } }),
  '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'mattpocock-skills@claude-plugins-official': [], 'h7@h7kz': [] } }),
  '.h7/.keep': '',
};

function env(files: Record<string, string> = healthy): DoctorEnv {
  const home = tmpDir();
  writeTree(home, files);
  return { home, cwd: home, nodeVersion: '24.1.0', run: () => ({ status: 0, stdout: 'ok' }) };
}

const byId = (checks: Check[], id: string): Check => checks.find((c) => c.id === id) as Check;
const slash = (p: string): string => p.split('\\').join('/');

describe('workspace check', () => {
  /** <home>/team with the marker, repos web and server, and the files the marker names. */
  function ws(marker: unknown, extra: Record<string, string> = {}): { e: DoctorEnv; dir: string } {
    const e = env();
    const dir = join(e.home, 'team');
    mkdirSync(join(dir, 'web', '.git'), { recursive: true });
    mkdirSync(join(dir, 'server', '.git'), { recursive: true });
    writeTree(dir, { 'docs/agents/verification-web.md': '', 'docs/agents/verification-server.md': '', 'AGENTS.md': '', ...extra });
    writeFileSync(join(dir, MARKER), typeof marker === 'string' ? marker : JSON.stringify(marker));
    return { e: { ...e, cwd: join(dir, 'web') }, dir };
  }
  const good = { version: 1, repos: { web: {}, server: {} } };

  it('reports workspace mode with the repo count', () => {
    const { e, dir } = ws(good);
    const check = byId(runChecks(e), 'workspace');
    assert.equal(check.status, 'pass');
    assert.equal(check.detail, `workspace mode: ${slash(dir)} (2 repos)`);
  });

  it('also works from the workspace root, which is not a repository', () => {
    const { e, dir } = ws(good);
    assert.equal(byId(runChecks({ ...e, cwd: dir }), 'workspace').status, 'pass');
  });

  it('fails for a missing repo, a non-git repo, h7 state inside a repo and missing referenced files', () => {
    const { e, dir } = ws({ version: 1, repos: { web: { prTemplate: 'docs/pr.md' }, server: {}, ghost: {}, plain: { verification: 'v.md' } } }, { 'plain/x': '' });
    mkdirSync(join(dir, 'web', '.h7'));
    mkdirSync(join(dir, 'server', 'docs', 'agents'), { recursive: true });
    const check = byId(runChecks(e), 'workspace');
    assert.equal(check.status, 'fail');
    for (const part of ['repo ghost does not exist', 'repo plain does not exist', 'repo web contains .h7/', 'repo server contains docs/agents/', 'web: docs/pr.md does not exist', 'plain: v.md does not exist']) assert.ok(check.detail.includes(part), part);
    assert.ok(check.fix);
  });

  it('warns when the workspace AGENTS.md does not exist yet', () => {
    const { e, dir } = ws(good);
    rmSync(join(dir, 'AGENTS.md'));
    assert.equal(byId(runChecks(e), 'workspace').status, 'warn');
  });

  it('fails with the reason for a marker it cannot trust, and still passes without one', () => {
    const { e } = ws('{broken');
    const check = byId(runChecks(e), 'workspace');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /not valid JSON/);
    assert.equal(byId(runChecks(env()), 'workspace').detail, 'no workspace marker: single-repo mode');
    assert.equal(byId(runChecks({ ...e, cwd: tmpDir() }), 'workspace').status, 'pass');
  });

  it('treats copies of mattpocock skills in the workspace skills folder as duplicates', () => {
    const lock = { '.agents/.skill-lock.json': JSON.stringify({ skills: { tdd: { source: 'mattpocock/skills' } } }) };
    const { e, dir } = ws(good, { '.claude/skills/tdd/SKILL.md': 'x' });
    writeTree(e.home, lock);
    const dupes = byId(runChecks(e), 'mattpocock-duplicates');
    assert.equal(dupes.status, 'fail');
    assert.match(dupes.detail, /1 unmarked copy\(ies\) of mattpocock skills \(tdd\) in .*team\/\.claude\/skills/);
    assert.ok((dupes.fix as string).includes(join(dir, '.claude', 'skills', 'tdd')));
    const bad = ws('{broken', { '.claude/skills/tdd/SKILL.md': 'x' });
    writeTree(bad.e.home, lock);
    assert.equal(byId(runChecks(bad.e), 'mattpocock-duplicates').status, 'pass');
  });

  it('abbreviates a long list of copies', () => {
    const names = ['a', 'b', 'c', 'd'];
    const e = env({ ...healthy, '.agents/.skill-lock.json': JSON.stringify({ skills: Object.fromEntries(names.map((n) => [n, { source: 'mattpocock/skills' }])) }), ...Object.fromEntries(names.map((n) => [`.claude/skills/${n}/SKILL.md`, 'x'])) });
    assert.match(byId(runChecks(e), 'mattpocock-duplicates').detail, /4 unmarked copy\(ies\).*\(a, b, c, \.\.\.\)/);
  });
});

describe('models check', () => {
  const models = (value: string) => env({ ...healthy, '.h7/models.json': value });

  it('warns when reviewer and author are the same model, comparing families', () => {
    const check = byId(runChecks(models('{"author":"claude-sonnet-4-5","reviewer":"sonnet"}')), 'models');
    assert.equal(check.status, 'warn');
    assert.match(check.fix as string, /different "reviewer"/);
  });

  it('passes for different models, no models.json, or a lone role, and warns on a corrupt file', () => {
    assert.equal(byId(runChecks(models('{"author":"opus","reviewer":"sonnet"}')), 'models').status, 'pass');
    assert.equal(byId(runChecks(models('{"reviewer":"sonnet"}')), 'models').status, 'pass');
    assert.equal(byId(runChecks(models('{"author":"sonnet"}')), 'models').status, 'pass');
    assert.match(byId(runChecks(env()), 'models').detail, /no models.json/);
    assert.equal(byId(runChecks(models('nope')), 'models').status, 'warn');
  });
});

describe('unmarked skill copies by name and content', () => {
  const MANGLED = '# Domain modeling\n\nRead ../../../AGENTS.md and GLOSSARY.md before changing the model. Record decisions as ADRs.';
  const ORIGINAL = '# Domain modeling\n\nRead AGENTS.md and GLOSSARY.md before changing the model. Record decisions as ADRs.';

  function home(copy: string): { dir: string; copies: string[] } {
    const dir = tmpDir();
    const install = join(dir, 'cache', 'mp');
    writeTree(dir, {
      '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'mattpocock-skills@claude-plugins-official': [{ installPath: install }, null, {}, { installPath: join(dir, 'gone') }] } }),
      'cache/mp/skills/domain-modeling/SKILL.md': ORIGINAL,
      'cache/mp/skills/empty-dir/placeholder.txt': '',
      '.claude/skills/domain-modeling/SKILL.md': copy,
      '.claude/skills/own-skill/SKILL.md': MANGLED,
    });
    return { dir, copies: unmarkedCopies(dir, [join(dir, '.claude', 'skills'), join(dir, 'missing')]) };
  }

  it('finds an installer-mangled copy by name and similar content, and ignores unrelated names', () => {
    const { dir, copies } = home(MANGLED);
    assert.deepEqual(copies, [join(dir, '.claude', 'skills', 'domain-modeling')]);
  });

  it('does not flag a same-named skill whose content is different', () => {
    assert.deepEqual(home('Completely unrelated text about deploying servers to production clusters').copies, []);
  });

  it('flags by name alone when the plugin copy cannot be read, skips links and folders without SKILL.md', () => {
    const dir = tmpDir();
    writeTree(dir, { '.agents/.skill-lock.json': JSON.stringify({ skills: { tdd: { source: 'mattpocock/skills' }, nodoc: { source: 'mattpocock/skills' }, linked: { source: 'mattpocock/skills' } } }), '.claude/skills/tdd/SKILL.md': 'anything', '.claude/skills/nodoc/readme.txt': '' });
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, '.claude', 'skills', 'linked'), 'junction');
    assert.deepEqual(unmarkedCopies(dir, [join(dir, '.claude', 'skills')]), [join(dir, '.claude', 'skills', 'tdd')]);
  });

  it('a plugin entry that is not a list contributes nothing', () => {
    const dir = tmpDir();
    writeTree(dir, { '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'mattpocock-skills@claude-plugins-official': 'x' } }) });
    assert.deepEqual(unmarkedCopies(dir, []), []);
  });

  it('similarity is symmetric and bounded, 0 for empty text', () => {
    assert.equal(similarity('', ''), 0);
    assert.equal(similarity('alpha beta gamma', 'alpha beta gamma'), 1);
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const s = similarity(a, b);
        assert.ok(s >= 0 && s <= 1);
        assert.equal(s, similarity(b, a));
      }),
    );
  });
});
