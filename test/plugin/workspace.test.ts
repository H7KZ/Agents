import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { cleanupTmp, runNode, runs, SLOW, tmpDir } from '../../scripts/test/helpers.ts';
import {
  MARKER,
  MAX_MARKER_BYTES,
  MAX_REPOS,
  WorkspaceError,
  base,
  canonicalPath,
  defaultHome,
  findRepoRoot,
  findWorkspace,
  glossaryName,
  main,
  memory,
  parseMarker,
  realFsIo,
  resolveContext,
  settings,
  readTrust,
  sha256,
  stateDir,
  trustFile,
  trustMain,
  realTrustDeps,
  trustOf,
  workspaceFor,
  type FsIo,
  type TrustDeps,
} from '../../plugins/h7/scripts/workspace.ts';

cleanupTmp();

const SCRIPT = join(import.meta.dirname, '../../plugins/h7/scripts/workspace.ts');
const json = (value: unknown): string => JSON.stringify(value);
const MIN = json({ version: 1, repos: { web: {} } });
const slash = (p: string): string => p.split('\\').join('/');

/** A workspace folder: <ws>/web and <ws>/server are "repos" (a .git directory is enough for the resolver). */
function makeWs(marker: unknown = { version: 1, repos: { web: { base: 'develop' }, server: {} } }, repos: string[] = ['web', 'server']): { ws: string; home: string } {
  const home = tmpDir('h7-ws-home-');
  const ws = join(home, 'code', 'team');
  mkdirSync(ws, { recursive: true });
  for (const repo of repos) mkdirSync(join(ws, repo, '.git'), { recursive: true });
  if (marker !== null) writeFileSync(join(ws, MARKER), typeof marker === 'string' ? marker : json(marker));
  return { ws, home };
}

/** Records the hash of the marker as it is now (or of the given text) the way `workspace.ts trust` does. */
function trustIt(home: string, ws: string, text?: string): void {
  mkdirSync(join(home, '.h7'), { recursive: true });
  writeFileSync(trustFile(home), JSON.stringify({ [join(ws, MARKER)]: sha256(text ?? readFileSync(join(ws, MARKER), 'utf8')) }));
}

const rejects = (text: string, pattern: RegExp): void => assert.throws(() => parseMarker(text), (error: unknown) => error instanceof WorkspaceError && pattern.test(error.message));

describe('parseMarker', () => {
  it('fills defaults for a minimal marker', () => {
    const marker = parseMarker(MIN);
    assert.equal(marker.stateDir, '.h7');
    assert.deepEqual(marker.memory, { agents: 'AGENTS.md', glossary: null, adr: 'docs/adr' });
    assert.equal(marker.scratch, null);
    assert.deepEqual(marker.repos.get('web'), { base: null, verification: 'docs/agents/verification-web.md', prTemplate: null, ship: 'pr', autoMerge: false });
  });

  it('keeps every configured field and a byte order mark is tolerated', () => {
    const text = `\uFEFF${json({
      version: 1,
      stateDir: '.state',
      scratch: 'tmp',
      repos: { 'apps/web': { base: 'release/1.x', verification: 'v/web.md', prTemplate: 'docs/pr.md', ship: 'push', autoMerge: true } },
      memory: { agents: 'A.md', glossary: 'GLOSSARY.md', adr: 'decisions' },
    })}`;
    const marker = parseMarker(text);
    assert.deepEqual(marker.repos.get('apps/web'), { base: 'release/1.x', verification: 'v/web.md', prTemplate: 'docs/pr.md', ship: 'push', autoMerge: true });
    assert.deepEqual([marker.stateDir, marker.scratch, marker.memory.glossary], ['.state', 'tmp', 'GLOSSARY.md']);
  });

  it('derives the default verification file name from nested keys', () => {
    assert.equal(parseMarker(json({ version: 1, repos: { 'apps/web': {} } })).repos.get('apps/web')?.verification, 'docs/agents/verification-apps-web.md');
  });

  it('refuses what is not a clean marker', () => {
    rejects('{', /not valid JSON/);
    rejects('[]', /must be an object/);
    rejects('null', /must be an object/);
    rejects(json({ version: 2, repos: {} }), /version must be 1/);
    rejects(json({ repos: {} }), /version must be 1/);
    rejects(json({ version: 1 }), /repos must be an object/);
    rejects(json({ version: 1, repos: [] }), /repos must be an object/);
    rejects(json({ version: 1, repos: {}, extra: 1 }), /unknown key: "extra"/);
    rejects(json({ version: 1, repos: { web: 1 } }), /repos.web must be an object/);
    rejects(json({ version: 1, repos: { web: { nope: 1 } } }), /unknown key: "nope"/);
    rejects(json({ version: 1, repos: { web: { ship: 'merge' } } }), /ship must be/);
    rejects(json({ version: 1, repos: { web: { autoMerge: 'yes' } } }), /autoMerge must be/);
    rejects(json({ version: 1, repos: { web: {} }, memory: [] }), /memory must be an object/);
    rejects(json({ version: 1, repos: { web: {} }, memory: { agents: 3 } }), /memory.agents/);
    rejects(`{"version":1,"repos":{"web":{},"WEB":{}}}`, /twice/);
  });

  it('refuses unusable paths and branch names', () => {
    for (const bad of ['', '/abs', '../x', 'a/../b', 'a//b', 'a/', './a', 'a\\b', 'C:/x', 'a/.git/b', 'x/.GIT', 'trail.', 'a /b', 'nul\u0000', 'q?', 'x'.repeat(301), 5]) {
      rejects(json({ version: 1, repos: { web: { verification: bad } } }), /verification/);
    }
    rejects(json({ version: 1, repos: { '': {} } }), /repos key/);
    rejects(json({ version: 1, stateDir: '..', repos: {} }), /stateDir/);
    rejects(json({ version: 1, scratch: '.', repos: {} }), /scratch/);
    for (const bad of ['-x', '', 'a..b', 'a b', 'main/', 'x.lock', 'x'.repeat(201), '/m', 1]) {
      rejects(json({ version: 1, repos: { web: { base: bad } } }), /plain branch name/);
    }
  });

  it('keeps state and scratch out of every repo and apart from each other', () => {
    rejects(json({ version: 1, stateDir: 'web', repos: { web: {} } }), /overlaps the repository "web"/);
    rejects(json({ version: 1, stateDir: 'web/.h7', repos: { web: {} } }), /overlaps/);
    rejects(json({ version: 1, stateDir: 'WEB', repos: { web: {} } }), /overlaps/);
    rejects(json({ version: 1, stateDir: 'apps', repos: { 'apps/web': {} } }), /overlaps/);
    rejects(json({ version: 1, scratch: 'web/tmp', repos: { web: {} } }), /scratch .* overlaps/);
    rejects(json({ version: 1, scratch: '.h7/tmp', repos: {} }), /scratch and stateDir/);
    rejects(json({ version: 1, scratch: 'tmp', stateDir: 'tmp/state', repos: {} }), /scratch and stateDir/);
    assert.equal(parseMarker(json({ version: 1, scratch: 'tmp', stateDir: '.h7', repos: { web: {} } })).scratch, 'tmp');
    assert.equal(parseMarker(json({ version: 1, stateDir: 'webstate', repos: { web: {} } })).stateDir, 'webstate');
  });

  it('bounds size and repo count and treats __proto__ as data', () => {
    rejects(`${MIN}${' '.repeat(MAX_MARKER_BYTES)}`, /larger than/);
    const many = Object.fromEntries(Array.from({ length: MAX_REPOS + 1 }, (_, i) => [`r${i}`, {}]));
    rejects(json({ version: 1, repos: many }), /more than/);
    const marker = parseMarker('{"version":1,"repos":{"__proto__":{"base":"x"}}}');
    assert.equal(marker.repos.get('__proto__')?.base, 'x');
    assert.equal(Object.getPrototypeOf(marker.repos) === Map.prototype, true);
  });

  it('property: never throws anything but WorkspaceError, and accepted markers are fully normalized', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json(), fc.jsonValue().map((v) => JSON.stringify(v))), (text) => {
        try {
          const marker = parseMarker(text);
          for (const [key, repo] of marker.repos) {
            for (const rel of [key, repo.verification, repo.prTemplate ?? 'ok']) assert.ok(!rel.startsWith('/') && !rel.includes('\\') && !rel.split('/').some((s) => s === '' || s === '.' || s === '..'));
            assert.ok(repo.base === null || !repo.base.startsWith('-'));
          }
        } catch (error) {
          assert.ok(error instanceof WorkspaceError, `unexpected ${String(error)}`);
        }
      }),
      { numRuns: runs(300) },
    );
  });

  it('property: generated valid markers round trip their settings', () => {
    const seg = fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/);
    const repo = fc.record({ base: fc.option(seg, { nil: undefined }), ship: fc.option(fc.constantFrom('pr', 'push'), { nil: undefined }), autoMerge: fc.option(fc.boolean(), { nil: undefined }) });
    fc.assert(
      fc.property(fc.dictionary(seg.map((s) => `r${s}`), repo, { minKeys: 1, maxKeys: 5 }), (repos) => {
        const parsed = parseMarker(json({ version: 1, repos }));
        for (const [key, value] of Object.entries(repos)) {
          const got = parsed.repos.get(key);
          assert.equal(got?.base, value.base ?? null);
          assert.equal(got?.ship, value.ship ?? 'pr');
          assert.equal(got?.autoMerge, value.autoMerge ?? false);
        }
      }),
      { numRuns: runs(100) },
    );
  });
});

describe('findRepoRoot and glossaryName', () => {
  it('finds the nearest .git and null outside a repository', () => {
    const { ws } = makeWs();
    mkdirSync(join(ws, 'web', 'src'));
    assert.equal(findRepoRoot(join(ws, 'web', 'src'), realFsIo), join(ws, 'web'));
    assert.equal(findRepoRoot(join(ws, 'web'), realFsIo), join(ws, 'web'));
    assert.equal(findRepoRoot(join(ws, 'nowhere'), { lstat: () => null }), null);
  });

  it('prefers CONTEXT.md and accepts GLOSSARY.md when it is the only one', () => {
    const dir = tmpDir('h7-glossary-');
    assert.equal(glossaryName(realFsIo, dir), 'CONTEXT.md');
    writeFileSync(join(dir, 'GLOSSARY.md'), '');
    assert.equal(glossaryName(realFsIo, dir), 'GLOSSARY.md');
    writeFileSync(join(dir, 'CONTEXT.md'), '');
    assert.equal(glossaryName(realFsIo, dir), 'CONTEXT.md');
  });
});

describe('workspace resolution', () => {
  it('maps a listed repo to <ws>/<stateDir>/<repo> from anywhere inside it', () => {
    const { ws, home } = makeWs();
    mkdirSync(join(ws, 'web', 'src'));
    const found = findWorkspace(join(ws, 'web', 'src'), realFsIo, home);
    assert.ok(found !== null);
    assert.equal(found.repo, 'web');
    assert.equal(found.root, ws);
    assert.equal(found.stateDir, join(ws, '.h7', 'web'));
    assert.equal(found.settings.base, 'develop');
    assert.equal(found.files.verification, join(ws, 'docs', 'agents', 'verification-web.md'));
    assert.equal(found.files.glossary, join(ws, 'CONTEXT.md'));
    assert.equal(found.files.prTemplate, null);
    assert.equal(found.scratch, null);
    assert.equal(stateDir(join(ws, 'server'), realFsIo, home), join(ws, '.h7', 'server'));
    assert.equal(base(join(ws, 'web'), realFsIo, home), 'develop');
    assert.equal(base(join(ws, 'server'), realFsIo, home), null);
  });

  it('resolves the optional files, scratch and a GLOSSARY.md that is present', () => {
    const { ws, home } = makeWs({ version: 1, scratch: 'tmp', repos: { web: { prTemplate: 'docs/pull-requests.md' } } });
    writeFileSync(join(ws, 'GLOSSARY.md'), '');
    const found = findWorkspace(join(ws, 'web'), realFsIo, home);
    assert.equal(found?.files.prTemplate, join(ws, 'docs', 'pull-requests.md'));
    assert.equal(found?.files.glossary, join(ws, 'GLOSSARY.md'));
    assert.equal(found?.scratch, join(ws, 'tmp'));
    assert.equal(settings(join(ws, 'web'), realFsIo, home).prTemplate, join(ws, 'docs', 'pull-requests.md'));
    assert.deepEqual(memory(join(ws, 'web'), realFsIo, home), { agents: join(ws, 'AGENTS.md'), glossary: join(ws, 'GLOSSARY.md'), adr: join(ws, 'docs', 'adr') });
  });

  it('changes nothing without a marker, for an unlisted repo, and outside any repository', () => {
    const { ws, home } = makeWs(MIN, ['web', 'other']);
    assert.equal(findWorkspace(join(ws, 'other'), realFsIo, home), null);
    const plain = resolveContext(join(ws, 'other'), realFsIo, home);
    assert.deepEqual([plain.workspace, plain.repoRoot, plain.stateDir, plain.containRoot], [null, join(ws, 'other'), join(ws, 'other', '.h7'), join(ws, 'other')]);
    const bare = tmpDir('h7-nogit-');
    const none = resolveContext(bare, { ...realFsIo, lstat: (file) => (file.endsWith('.git') ? null : realFsIo.lstat(file)) }, bare);
    assert.deepEqual([none.repoRoot, none.stateDir, none.containRoot], [null, join(bare, '.h7'), bare]);
    assert.equal(findWorkspace(bare, { ...realFsIo, lstat: () => null }), null);
    const s = settings(join(ws, 'other'), realFsIo, home);
    assert.deepEqual([s.mode, s.base, s.ship, s.autoMerge, s.verification], ['repo', null, null, null, join(ws, 'other', 'docs', 'agents', 'verification.md')]);
    assert.deepEqual(memory(join(ws, 'other'), realFsIo, home), { agents: join(ws, 'other', 'AGENTS.md'), glossary: join(ws, 'other', 'CONTEXT.md'), adr: join(ws, 'other', 'docs', 'adr') });
    assert.equal(settings(bare, { ...realFsIo, lstat: () => null }, home).verification, join(bare, 'docs', 'agents', 'verification.md'));
    assert.equal(memory(bare, { ...realFsIo, lstat: () => null }, home).adr, join(bare, 'docs', 'adr'));
  });

  it('skips a marker that does not list the repo and finds an outer one that does', () => {
    const { ws, home } = makeWs(MIN, ['web']);
    const inner = join(ws, 'group');
    mkdirSync(join(inner, 'tool', '.git'), { recursive: true });
    writeFileSync(join(inner, MARKER), json({ version: 1, repos: { other: {} } }));
    writeFileSync(join(ws, MARKER), json({ version: 1, repos: { 'group/tool': {} } }));
    assert.equal(findWorkspace(join(inner, 'tool'), realFsIo, home)?.root, ws);
    assert.equal(findWorkspace(join(inner, 'tool'), realFsIo, home)?.stateDir, join(ws, '.h7', 'group', 'tool'));
  });

  it('never looks at HOME itself or above it, and a repo outside HOME never gets workspace mode', () => {
    const { ws, home } = makeWs();
    writeFileSync(join(home, MARKER), json({ version: 1, repos: { 'code/team/web': {} } }));
    rmMarker(ws);
    assert.equal(findWorkspace(join(ws, 'web'), realFsIo, home), null);
    // The real marker sits at ws; with HOME = ws it is HOME itself, and with HOME below ws the repo is outside HOME.
    writeFileSync(join(ws, MARKER), json({ version: 1, repos: { web: {} } }));
    assert.equal(findWorkspace(join(ws, 'web'), realFsIo, ws), null);
    assert.equal(findWorkspace(join(ws, 'web'), realFsIo, join(ws, 'server')), null);
    assert.equal(findWorkspace(join(ws, 'web'), realFsIo, join(home, 'code'))?.root, ws);
    // HOME itself as the repo: nothing above it is considered.
    assert.equal(workspaceFor(home, realFsIo, home), null);
  });

  it('property: a marker is only ever found inside the real home', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 0, maxLength: 3 }), fc.integer({ min: 0, max: 3 }), (below, up) => {
        const { ws, home } = makeWs(MIN, ['web']);
        const marker = join(home, ...['code', 'team'].slice(0, Math.max(0, 2 - up)));
        const found = findWorkspace(join(ws, 'web', ...below), realFsIo, marker);
        assert.ok(found === null || found.root.startsWith(marker));
        assert.ok(found === null || found.root !== marker);
      }),
      { numRuns: runs(20) },
    );
  });

  it('fails with a clear error for an untrustworthy marker instead of falling back silently', () => {
    const cases: Array<[string, RegExp]> = [
      ['{nope', /not valid JSON/],
      [json({ version: 3, repos: { web: {} } }), /version must be 1/],
      [' '.repeat(MAX_MARKER_BYTES + 1), /larger than/],
    ];
    for (const [text, pattern] of cases) {
      const { ws, home } = makeWs(text);
      assert.throws(() => findWorkspace(join(ws, 'web'), realFsIo, home), (error: unknown) => error instanceof WorkspaceError && pattern.test(error.message) && error.message.includes(MARKER));
    }
    const { ws, home } = makeWs(null);
    mkdirSync(join(ws, MARKER));
    assert.throws(() => findWorkspace(join(ws, 'web'), realFsIo, home), /not a regular file/);
  });

  it('refuses a symlinked marker and an unreadable one', () => {
    const { ws, home } = makeWs();
    const fake = (link: boolean): FsIo => ({ ...realFsIo, lstat: (file) => (file.endsWith(MARKER) ? { isSymbolicLink: () => link, isFile: () => true, isDirectory: () => false, size: 3, uid: 0, mode: 0 } : realFsIo.lstat(file)), read: () => { throw new Error('EACCES'); } });
    assert.throws(() => findWorkspace(join(ws, 'web'), fake(true), home), /symlink/);
    assert.throws(() => findWorkspace(join(ws, 'web'), fake(false), home), /cannot read .*EACCES/);
  });

  it('a listed repo that is a symlink to elsewhere is outside HOME or a different repo, never trusted as itself', () => {
    const { ws, home } = makeWs({ version: 1, repos: { link: {}, web: {}, alias: {} } }, ['web']);
    const outside = tmpDir('h7-outside-');
    mkdirSync(join(outside, '.git'));
    symlinkSync(outside, join(ws, 'link'), 'junction');
    assert.equal(findWorkspace(join(ws, 'link'), { ...realFsIo, lstat: realFsIo.lstat }, join(ws, '..')), null);
    symlinkSync(join(ws, 'web'), join(ws, 'alias'), 'junction');
    assert.equal(findWorkspace(join(ws, 'alias'), realFsIo, home)?.repo, 'web');
  });

  it('refuses a stateDir, scratch or file that a symlink points outside the workspace or into a repo', () => {
    const outside = tmpDir('h7-outside-');
    const a = makeWs({ version: 1, stateDir: 'state', repos: { web: {} } }, ['web']);
    symlinkSync(outside, join(a.ws, 'state'), 'junction');
    assert.throws(() => findWorkspace(join(a.ws, 'web'), realFsIo, a.home), /stateDir resolves outside the workspace/);
    const b = makeWs({ version: 1, stateDir: 'state', repos: { web: {} } }, ['web']);
    symlinkSync(join(b.ws, 'web'), join(b.ws, 'state'), 'junction');
    assert.throws(() => findWorkspace(join(b.ws, 'web'), realFsIo, b.home), /stateDir resolves inside a repository/);
    const c = makeWs({ version: 1, scratch: 'tmp', repos: { web: {} } }, ['web']);
    symlinkSync(join(c.ws, 'web'), join(c.ws, 'tmp'), 'junction');
    assert.throws(() => findWorkspace(join(c.ws, 'web'), realFsIo, c.home), /scratch resolves inside a repository/);
    const d = makeWs({ version: 1, repos: { web: { verification: 'v.md' } } }, ['web']);
    symlinkSync(outside, join(d.ws, 'v.md'), 'junction');
    assert.throws(() => findWorkspace(join(d.ws, 'web'), realFsIo, d.home), /verification resolves outside the workspace/);
  });

  it('canonicalPath resolves the missing tail under the nearest real ancestor and gives up at the root', () => {
    const { ws } = makeWs();
    assert.equal(canonicalPath(realFsIo, join(ws, 'a', 'b')), join(ws, 'a', 'b'));
    const never: FsIo = { ...realFsIo, realpath: () => { throw new Error('ENOENT'); } };
    assert.equal(canonicalPath(never, join(ws, 'a')), join(ws, 'a'));
  });

  it('defaultHome honors H7_HOME', () => {
    const previous = process.env.H7_HOME;
    process.env.H7_HOME = join('x', 'y');
    assert.equal(defaultHome(), join('x', 'y'));
    delete process.env.H7_HOME;
    assert.ok(defaultHome().length > 0);
    if (previous !== undefined) process.env.H7_HOME = previous;
  });
});

function rmMarker(ws: string): void {
  writeFileSync(join(ws, MARKER), json({ version: 1, repos: { other: {} } }));
}

/** The marker and the workspace directory report the given owner and mode; everything else is the real disk. */
function owned(ws: string, uid: number | null, fileMode: number, dirMode = 0o755, fileUid = uid, dirUid = uid): FsIo {
  return {
    ...realFsIo,
    uid,
    lstat(file) {
      const stat = realFsIo.lstat(file);
      if (stat === null || (!file.endsWith(MARKER) && file !== ws)) return stat;
      const marker = file.endsWith(MARKER);
      return { isSymbolicLink: () => stat.isSymbolicLink(), isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), size: stat.size, uid: (marker ? fileUid : dirUid) ?? 0, mode: marker ? fileMode : dirMode };
    },
  };
}

describe('marker trust', () => {
  const UID = 1000;
  const RISKY = { version: 1, repos: { web: { ship: 'push', autoMerge: true } } };

  it('accepts a marker and directory owned by the user and not writable by others', () => {
    const { ws, home } = makeWs(RISKY, ['web']);
    trustIt(home, ws);
    for (const mode of [0o600, 0o644, 0o640]) {
      const found = findWorkspace(join(ws, 'web'), owned(ws, UID, mode), home);
      assert.deepEqual([found?.trusted, found?.settings.ship, found?.settings.autoMerge], [true, 'push', true]);
    }
  });

  it('refuses, naming the reason, a marker owned by someone else', () => {
    const { ws, home } = makeWs(RISKY, ['web']);
    assert.throws(() => findWorkspace(join(ws, 'web'), owned(ws, UID, 0o644, 0o755, 0), home), (e: unknown) => e instanceof WorkspaceError && /workspace marker .* is owned by uid 0, not by you \(uid 1000\)/.test(e.message));
  });

  it('refuses a directory owned by someone else', () => {
    const { ws, home } = makeWs(RISKY, ['web']);
    assert.throws(() => findWorkspace(join(ws, 'web'), owned(ws, UID, 0o644, 0o755, UID, 0), home), /workspace directory .* is owned by uid 0/);
  });

  it('refuses a marker or directory that group or others can write', () => {
    const { ws, home } = makeWs(RISKY, ['web']);
    for (const mode of [0o666, 0o664, 0o646, 0o622, 0o020, 0o002]) {
      assert.throws(() => findWorkspace(join(ws, 'web'), owned(ws, UID, mode), home), /workspace marker .* writable by group or others \(mode \d+\)/);
      assert.throws(() => findWorkspace(join(ws, 'web'), owned(ws, UID, 0o644, mode), home), /workspace directory .* writable by group or others/);
    }
  });

  it('checks the marker before reading it, so an untrusted file is never parsed', () => {
    const { ws, home } = makeWs('{garbage', ['web']);
    assert.throws(() => findWorkspace(join(ws, 'web'), owned(ws, UID, 0o666), home), /writable by group or others/);
  });

  it('where ownership cannot be checked (Windows) the vouched marker is honoured: the typed-yes hash is the anchor', () => {
    const { ws, home } = makeWs(RISKY, ['web']);
    trustIt(home, ws);
    const found = findWorkspace(join(ws, 'web'), owned(ws, null, 0o666, 0o777), home);
    assert.deepEqual([found?.trusted, found?.settings.ship, found?.settings.autoMerge], [true, 'push', true]);
    assert.deepEqual([found?.marker.repos.get('web')?.ship, found?.marker.repos.get('web')?.autoMerge], ['push', true]);
    const s = settings(join(ws, 'web'), owned(ws, null, 0o666), home);
    assert.deepEqual([s.ship, s.autoMerge], ['push', true]);
  });

  it('property: a vouched marker is honoured whether or not the owner can be checked', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.constantFrom('pr', 'push'), (autoMerge, ownerKnown, ship) => {
        const { ws, home } = makeWs({ version: 1, repos: { web: { ship, autoMerge } } }, ['web']);
        trustIt(home, ws);
        const found = findWorkspace(join(ws, 'web'), owned(ws, ownerKnown ? UID : null, 0o600), home);
        assert.equal(found?.settings.autoMerge, autoMerge);
        assert.equal(found?.settings.ship, ship);
      }),
      { numRuns: runs(30) },
    );
  });

  it('the real file system reports a user id on POSIX and null on Windows', () => {
    assert.equal(realFsIo.uid === null, process.platform === 'win32');
  });
});

describe('hash trust', () => {
  const UID = 1000;
  const RISKY = { version: 1, repos: { web: { ship: 'push', autoMerge: true } }, scratch: 'tmp' };

  it('a marker nobody vouched for gives paths and base but no push, auto-merge or scratch', () => {
    const { ws, home } = makeWs({ ...RISKY, repos: { web: { ship: 'push', autoMerge: true, base: 'develop' } } }, ['web']);
    const found = findWorkspace(join(ws, 'web'), owned(ws, UID, 0o644), home);
    assert.deepEqual([found?.trust, found?.trusted, found?.settings.ship, found?.settings.autoMerge, found?.settings.base], ['untrusted', false, 'pr', false, 'develop']);
    assert.equal(found?.stateDir, join(ws, '.h7', 'web'));
    assert.equal(found?.scratch, join(ws, 'tmp'));
  });

  it('a recorded hash trusts exactly those contents, and any edit makes it changed', () => {
    const { ws, home } = makeWs(RISKY, ['web']);
    trustIt(home, ws);
    assert.deepEqual([findWorkspace(join(ws, 'web'), owned(ws, UID, 0o644), home)?.trust, findWorkspace(join(ws, 'web'), owned(ws, UID, 0o644), home)?.trusted], ['trusted', true]);
    writeFileSync(join(ws, MARKER), json({ ...RISKY, scratch: 'elsewhere' }));
    const changed = findWorkspace(join(ws, 'web'), owned(ws, UID, 0o644), home);
    assert.deepEqual([changed?.trust, changed?.trusted, changed?.settings.autoMerge], ['changed', false, false]);
    writeFileSync(join(ws, MARKER), `${json(RISKY)} `);
    assert.equal(findWorkspace(join(ws, 'web'), owned(ws, UID, 0o644), home)?.trust, 'changed');
  });

  it('a trusted hash is honoured where ownership cannot be verified (Windows)', () => {
    const { ws, home } = makeWs(RISKY, ['web']);
    trustIt(home, ws);
    const found = findWorkspace(join(ws, 'web'), owned(ws, null, 0o644), home);
    assert.deepEqual([found?.trust, found?.trusted, found?.settings.autoMerge], ['trusted', true, true]);
  });

  it('reads the trust file defensively', () => {
    const { ws, home } = makeWs(RISKY, ['web']);
    const file = join(ws, MARKER);
    for (const body of ['{nope', '[]', 'null', '"x"', '{"a":1}']) {
      mkdirSync(join(home, '.h7'), { recursive: true });
      writeFileSync(trustFile(home), body);
      assert.equal(trustOf(realFsIo, home, file, 'text'), 'untrusted', body);
    }
    assert.equal(readTrust(realFsIo, tmpDir('h7-no-trust-')).size, 0);
    writeFileSync(trustFile(home), JSON.stringify({ [file.toUpperCase()]: sha256('t').toUpperCase() }));
    assert.equal(trustOf(realFsIo, home, file, 't'), 'trusted');
    assert.equal(trustOf(realFsIo, home, file, 'u'), 'changed');
  });

  it('property: only the exact recorded text is trusted', () => {
    const { home, ws } = makeWs();
    mkdirSync(join(home, '.h7'), { recursive: true });
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        writeFileSync(trustFile(home), JSON.stringify({ [join(ws, MARKER)]: sha256(a) }));
        assert.equal(trustOf(realFsIo, home, join(ws, MARKER), b), a === b ? 'trusted' : 'changed');
      }),
      { numRuns: runs(40) },
    );
  });
});

describe('workspace.ts status and trust', () => {
  const sh = (): { out: string[]; err: string[]; o: (t: string) => void; e: (t: string) => void } => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, o: (t) => out.push(t), e: (t) => err.push(t) };
  };
  const deps = (answer: string, tty = true): TrustDeps & { prompts: string[]; written: Array<[string, string, string]>; dirs: string[] } => {
    const prompts: string[] = [];
    const written: Array<[string, string, string]> = [];
    const dirs: string[] = [];
    return {
      isTTY: tty,
      prompt: async (q) => {
        prompts.push(q);
        return answer;
      },
      mkdir: (dir) => void dirs.push(dir),
      write: (file, text, root) => void written.push([file, text, root]),
      prompts,
      written,
      dirs,
    };
  };

  it('status reports untrusted, then trusted, then changed, and null without a marker', () => {
    const { ws, home } = makeWs(MIN, ['web']);
    const s = sh();
    const status = (cwd: string): Record<string, unknown> => {
      s.out.length = 0;
      assert.equal(main(['status'], s.o, s.e, cwd, realFsIo, home), 0);
      return JSON.parse(s.out[0] as string);
    };
    assert.equal(status(join(ws, 'web')).trust, 'untrusted');
    assert.match(status(ws).note as string, /ignored until you run: workspace.ts trust/);
    assert.equal(status(ws).sha256, sha256(MIN));
    trustIt(home, ws);
    const ok = status(join(ws, 'web'));
    assert.deepEqual([ok.trust, ok.ownerVerified === (realFsIo.uid !== null), /honoured/.test(ok.note as string)], ['trusted', true, true]);
    writeFileSync(join(ws, MARKER), `${MIN} `);
    assert.equal(status(ws).trust, 'changed');
    assert.deepEqual(status(tmpDir('h7-elsewhere-')), { marker: null });
    const shown = JSON.parse((main(['show'], s.o, s.e, join(ws, 'web'), realFsIo, home), s.out.at(-1)) as string);
    assert.deepEqual([shown.trust, shown.trusted], ['changed', false]);
    const plain = makeWs(null, ['web']);
    const none = JSON.parse((main(['show'], s.o, s.e, join(plain.ws, 'web'), realFsIo, plain.home), s.out.at(-1)) as string);
    assert.deepEqual([none.trust, none.trusted], [null, null]);
  });

  it('refuses without a terminal and writes nothing', async () => {
    const { ws, home } = makeWs(MIN, ['web']);
    const s = sh();
    const d = deps('yes', false);
    assert.equal(await trustMain([], s.o, s.e, join(ws, 'web'), realFsIo, home, d), 2);
    assert.match(s.err[0] as string, /needs an interactive terminal/);
    assert.deepEqual([d.prompts, d.written, d.dirs], [[], [], []]);
  });

  it('shows the marker, and anything but a typed yes trusts nothing', async () => {
    const { ws, home } = makeWs(MIN, ['web']);
    for (const answer of ['', 'y', 'YES', 'no', 'yes please']) {
      const s = sh();
      const d = deps(answer);
      assert.equal(await trustMain([], s.o, s.e, join(ws, 'web'), realFsIo, home, d), 1, answer);
      assert.ok((s.out[0] as string).includes(MIN) && (s.out[0] as string).includes(sha256(MIN)));
      assert.deepEqual(d.written, []);
    }
  });

  it('records the hash of exactly the shown text, keeping other entries, and the marker is then trusted', async () => {
    const { ws, home } = makeWs(MIN, ['web']);
    mkdirSync(join(home, '.h7'), { recursive: true });
    writeFileSync(trustFile(home), JSON.stringify({ '/other/.h7-workspace.json': 'abc', bad: 3 }));
    const s = sh();
    const d = deps(' yes ');
    assert.equal(await trustMain([], s.o, s.e, join(ws, 'web'), realFsIo, home, d), 0);
    assert.equal(d.written.length, 1);
    const [file, text, root] = d.written[0] as [string, string, string];
    assert.deepEqual([file, root, d.dirs], [trustFile(home), home, [join(home, '.h7')]]);
    assert.deepEqual(JSON.parse(text), { '/other/.h7-workspace.json': 'abc', [join(ws, MARKER)]: sha256(MIN) });
    writeFileSync(trustFile(home), text);
    assert.equal(trustOf(realFsIo, home, join(ws, MARKER), MIN), 'trusted');
    assert.match(s.out.at(-1) as string, /^trusted /);
  });

  it('takes an explicit marker path or directory, and rejects other places', async () => {
    const { ws, home } = makeWs(MIN, ['web']);
    for (const target of [join(ws, MARKER), ws, join(ws, '..', 'team')]) {
      const d = deps('yes');
      assert.equal(await trustMain([target], () => undefined, () => undefined, tmpDir('h7-cwd-'), realFsIo, home, d), 0, target);
      assert.equal(d.written.length, 1);
    }
    const s = sh();
    const d = deps('yes');
    assert.equal(await trustMain([join(ws, 'web')], s.o, s.e, ws, realFsIo, home, d), 2);
    assert.match(s.err[0] as string, /no \.h7-workspace\.json found in /);
    assert.equal(await trustMain(['relative'], s.o, s.e, ws, realFsIo, home, d), 2);
    assert.equal(await trustMain([], s.o, s.e, tmpDir('h7-cwd-'), realFsIo, home, d), 2);
    assert.match(s.err.at(-1) as string, /found above here/);
    assert.equal(await trustMain(['a', 'b'], s.o, s.e, ws, realFsIo, home, d), 2);
    assert.deepEqual(d.written, []);
  });

  it('refuses a malformed trust file instead of replacing it, and reports an untrustworthy marker', async () => {
    const { ws, home } = makeWs(MIN, ['web']);
    mkdirSync(join(home, '.h7'), { recursive: true });
    for (const body of ['{nope', '[1]']) {
      writeFileSync(trustFile(home), body);
      const s = sh();
      const d = deps('yes');
      assert.equal(await trustMain([], s.o, s.e, join(ws, 'web'), realFsIo, home, d), 2);
      assert.match(s.err[0] as string, /workspaces\.json (is not valid JSON|must be a JSON object)/);
      assert.deepEqual(d.written, []);
    }
    writeFileSync(join(ws, MARKER), '{bad');
    const s = sh();
    assert.equal(await trustMain([], s.o, s.e, join(ws, 'web'), realFsIo, home, deps('yes')), 2);
    assert.match(s.err[0] as string, /not valid JSON/);
    const boom = sh();
    const throwing = { ...realFsIo, lstat: () => { throw new Error('kaput'); } };
    assert.equal(await trustMain([], boom.o, boom.e, ws, throwing, home, deps('yes')), 2);
    assert.match(boom.err[0] as string, /workspace failed: kaput/);
  });

  it('the real terminal glue: prompt reads a line, mkdir and write make an owner-only file', () => {
    const real = realTrustDeps();
    assert.equal(typeof real.isTTY, 'boolean');
    const home = tmpDir('h7-glue-');
    real.mkdir(join(home, '.h7'));
    real.write(trustFile(home), '{"a":"b"}', home);
    assert.equal(readFileSync(trustFile(home), 'utf8'), '{"a":"b"}');
    if (process.platform !== 'win32') assert.equal(statSync(trustFile(home)).mode & 0o077, 0);
    const code = `import { realTrustDeps } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; console.log(JSON.stringify(await realTrustDeps().prompt('q? ')));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { input: ['yes', 'ignored', ''].join('\n'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"yes"/);
  });

  it('the script refuses without a terminal', SLOW, () => {
    const { ws, home } = makeWs(MIN, ['web']);
    const result = runNode(SCRIPT, ['trust'], { cwd: join(ws, 'web'), env: { H7_HOME: home } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /interactive terminal/);
    assert.ok(!existsSyncSafe(trustFile(home)));
  });
});

function existsSyncSafe(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

describe('workspace.ts command line', () => {
  const run = (cwd: string, args: string[], home: string, extra: Record<string, string> = {}): ReturnType<typeof main> extends number ? { code: number; out: string[]; err: string[] } : never => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(args, (t) => out.push(t), (t) => err.push(t), cwd, realFsIo, home);
    return { code, out, err, ...extra } as never;
  };

  it('prints the resolved settings and state directory', () => {
    const { ws, home } = makeWs({ version: 1, scratch: 'tmp', repos: { web: { base: 'develop', prTemplate: 'pr.md' } } }, ['web']);
    const shown = run(join(ws, 'web'), ['show'], home);
    assert.equal(shown.code, 0);
    const data = JSON.parse(shown.out[0] as string);
    assert.equal(data.mode, 'workspace');
    assert.equal(data.repo, 'web');
    assert.equal(data.stateDir, slash(join(ws, '.h7', 'web')));
    assert.equal(data.scratch, slash(join(ws, 'tmp')));
    assert.equal(data.prTemplate, slash(join(ws, 'pr.md')));
    assert.equal(data.base, 'develop');
    assert.deepEqual([data.ship, data.autoMerge], ['pr', false]);
    assert.equal(run(join(ws, 'web'), ['state-dir'], home).out[0], slash(join(ws, '.h7', 'web')));
  });

  it('prints plain-repo values with nulls', () => {
    const { ws, home } = makeWs(null, ['web']);
    const data = JSON.parse(run(join(ws, 'web'), ['show'], home).out[0] as string);
    assert.deepEqual([data.mode, data.workspace, data.repo, data.scratch, data.prTemplate, data.ship], ['repo', null, null, null, null, null]);
    assert.equal(data.stateDir, slash(join(ws, 'web', '.h7')));
  });

  it('reports usage and marker errors with exit 2', () => {
    const { ws, home } = makeWs('{oops', ['web']);
    assert.equal(run(ws, [], home).code, 2);
    assert.equal(run(ws, ['show', 'x'], home).code, 2);
    const bad = run(join(ws, 'web'), ['show'], home);
    assert.deepEqual([bad.code, /not valid JSON/.test(bad.err[0] as string)], [2, true]);
    const boom = main(['show'], () => {}, (t) => assert.match(t, /workspace failed: kaput/), ws, { ...realFsIo, lstat: () => { throw new Error('kaput'); } }, home);
    assert.equal(boom, 2);
  });

  it('runs as a script', SLOW, () => {
    const { ws, home } = makeWs();
    const result = runNode(SCRIPT, ['state-dir'], { cwd: join(ws, 'web'), env: { H7_HOME: home } });
    assert.deepEqual([result.status, result.stdout.trim()], [0, slash(join(ws, '.h7', 'web'))]);
    const usage = runNode(SCRIPT, [], { cwd: ws });
    assert.deepEqual([usage.status, usage.stderr.includes('usage')], [2, true]);
  });
});
