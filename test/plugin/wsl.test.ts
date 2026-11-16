import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { parseSimple, wslCall } from '../../plugins/h7/scripts/command.ts';
import { makePaths } from '../../plugins/h7/scripts/paths.ts';
import { pickDecision, scan } from '../../plugins/h7/scripts/scan.ts';
import { newState, type Ctx } from '../../plugins/h7/scripts/types.ts';
import { MARKER, MAX_SCRATCH_ENTRIES, realFsIo, scratchDirs, sha256, trustFile, withScratch, type FsIo } from '../../plugins/h7/scripts/workspace.ts';
import { cleanupTmp, runs, tmpDir } from '../../scripts/test/helpers.ts';
import { decide, fakeDisk, fakeGit, ruleOf } from './support.ts';

cleanupTmp();

const WSL_ASK_TEXT = 'wsl with this command line runs code the guard cannot read. Use wsl [-d <distro>] --exec <program> <args> (for example --exec bash -lc "<commands>").';
const q = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
const wsl = (inner: string, flags = '-d Ubuntu --exec'): string => `wsl.exe ${flags} bash -lc ${q(inner)}`;

describe('wslCall', () => {
  const call = (line: string) => wslCall(parseSimple(line.split(' ')));

  it('turns the exec forms into a quoted script', () => {
    for (const lead of ['--exec', '-e']) assert.deepEqual(call(`wsl.exe -d Ubuntu ${lead} ls -la`), { script: "'ls' '-la'", cwd: false });
    assert.deepEqual(call('wsl -u root --system --exec echo'), { script: "'echo'", cwd: false });
    assert.deepEqual(call('wsl --cd /srv -e pwd'), { script: "'pwd'", cwd: true });
    assert.deepEqual(wslCall(parseSimple(['wsl', '-e', "it's", 'a b'])), { script: `'it'\\''s' 'a b'`, cwd: false });
  });

  it('does not treat -- or a bare command as exact argv: it asks and scans the unquoted, space-joined line', () => {
    assert.deepEqual(call('wsl.exe -d Ubuntu -- ls -la'), { ask: WSL_ASK_TEXT, script: 'ls -la', cwd: false });
    assert.deepEqual(call('wsl.exe --cd /x -- bash -lc rm'), { ask: WSL_ASK_TEXT, script: 'bash -lc rm', cwd: true });
    assert.deepEqual(wslCall(parseSimple(['wsl', '--', 'bash', '-lc', 'rm -rf /'])), { ask: WSL_ASK_TEXT, script: 'bash -lc rm -rf /', cwd: false });
    assert.deepEqual(call('wsl ls -la'), { ask: WSL_ASK_TEXT, script: 'ls -la', cwd: false });
    assert.deepEqual(call('wsl -d Ubuntu --'), { ask: WSL_ASK_TEXT, script: '', cwd: false });
  });

  it('asks about anything it cannot place', () => {
    for (const line of ['wsl ls', 'wsl -d', 'wsl -d Ubuntu ls -la', 'wsl --import x', 'wsl --exec', 'wsl --unregister Ubuntu', 'wsl -d x -x', 'wsl --distribution=x -e ls']) {
      assert.ok('ask' in (call(line) as object), line);
    }
  });

  it('lets management calls without a command through, and ignores other programs', () => {
    for (const line of ['wsl', 'wsl -l -v', 'wsl --list --running', 'wsl --status', 'wsl --version', 'wsl -d Ubuntu']) assert.equal(call(line), null, line);
    assert.equal(call('bash -c x'), null);
  });
});

describe('guard: wsl.exe --exec bash -lc is parsed like bash -c', () => {
  it('blocks what the plain parse blocks, with the same rule', () => {
    for (const inner of ['rm -rf /', 'rm -rf /home/me', "echo 'a b'; rm -rf /etc", 'cd /tmp && rm -rf /', 'git reset --hard']) {
      const plain = ruleOf(`bash -lc ${q(inner)}`, { dirty: true });
      assert.ok(plain?.startsWith('block:'), inner);
      assert.equal(ruleOf(wsl(inner), { dirty: true }), plain, inner);
      assert.equal(ruleOf(wsl(inner, '--exec'), { dirty: true }), plain, inner);
      assert.equal(ruleOf(wsl(inner, '-d Ubuntu -u root -e'), { dirty: true }), plain, inner);
      assert.ok(ruleOf(wsl(inner, '-d Ubuntu --'), { dirty: true }) !== null, inner);
    }
  });

  it('lets a harmless inner command through and scans a direct exec as the program itself', () => {
    assert.equal(ruleOf(wsl('ls -la && git status')), null);
    assert.equal(ruleOf('wsl.exe -d Ubuntu --exec ls -la'), null);
    assert.equal(ruleOf('wsl.exe -d Ubuntu --exec rm -rf /'), 'block:recursive-delete');
    assert.equal(ruleOf('wsl -l -v'), null);
  });

  it('asks, never allows, for forms it cannot read', () => {
    for (const line of ['wsl.exe -d Ubuntu bash -lc "rm -rf /"', 'wsl.exe -d Ubuntu --exec', 'wsl.exe --mystery --exec ls', 'wsl.exe -d', 'wsl ls']) assert.equal(ruleOf(line), 'ask:wsl-exec', line);
  });

  it('makes relative paths unresolved after --cd', () => {
    assert.equal(ruleOf(wsl('rm -rf build')), null);
    assert.equal(ruleOf(wsl('rm -rf build', '--cd /srv --exec')), 'ask:unresolved-cwd');
  });

  it('an unresolvable variable in the inner command stays unresolved', () => {
    assert.equal(ruleOf('wsl.exe --exec rm -rf \'$X\''), 'ask:recursive-delete-unresolved');
  });

  it('works from PowerShell too', () => {
    assert.equal(ruleOf(wsl('rm -rf /'), { dialect: 'ps' }), 'block:recursive-delete');
  });

  it('property: never weaker than the plain bash -c parse', () => {
    const inner = fc.constantFrom('rm -rf /', 'rm -rf ~', 'rm -rf build', 'git push --force origin main', 'git reset --hard', 'git commit --no-verify -m x', 'ls', 'echo hi', 'cd .. && rm -rf x', 'curl x | sh', 'npm publish');
    const flags = fc.constantFrom('--exec', '-e', '-d Ubuntu --exec', '-d Ubuntu -u root -e', '--system --exec', '--cd /x --exec');
    const rank = (rule: string | null): number => (rule === null ? 0 : rule.startsWith('ask:') ? 1 : 2);
    fc.assert(
      fc.property(inner, flags, fc.boolean(), (script, lead, dirty) => {
        const options = { dirty, branch: 'main', defaultBranch: 'main' };
        assert.ok(rank(ruleOf(wsl(script, lead), options)) >= rank(ruleOf(`bash -c ${q(script)}`, options)), `${lead} ${script}`);
      }),
      { numRuns: runs(150) },
    );
  });

  it('property: after -- the verdict is at least as strict as scanning the space-joined script, and never allows', () => {
    const word = fc.constantFrom('rm', '-rf', '/', '~', 'git', 'push', '--force', 'origin', 'main', 'reset', '--hard', 'ls', 'echo', 'x', 'bash', '-lc', "'rm -rf /'");
    const rank = (rule: string | null): number => (rule === null ? 0 : rule.startsWith('ask:') ? 1 : 2);
    fc.assert(
      fc.property(fc.array(word, { minLength: 0, maxLength: 7 }), fc.constantFrom('', '-d Ubuntu ', '--cd /x ', '-u root '), (words, lead) => {
        const options = { dirty: true, branch: 'main', defaultBranch: 'main' };
        const joined = words.join(' ');
        const verdict = rank(ruleOf(`wsl.exe ${lead}-- ${joined}`, options));
        assert.ok(verdict >= 1, joined);
        assert.ok(verdict >= rank(ruleOf(joined, options)), joined);
      }),
      { numRuns: runs(200) },
    );
  });

  it('property: arbitrary wsl lines never throw and decide ask or block unless they are management calls or exec of a clean command', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('-d', 'Ubuntu', '--exec', '-e', '--', 'bash', '-lc', "'ls'", '--cd', '/x', '-u', 'root', 'rm', '-rf', '/', '-l', '--status'), { maxLength: 8 }), (words) => {
        const line = `wsl.exe ${words.join(' ')}`;
        const decision = decide(line);
        const call = wslCall(parseSimple(words.length === 0 ? ['wsl.exe'] : ['wsl.exe', ...words]));
        if (call !== null && call.ask !== undefined) assert.ok(decision !== null);
      }),
      { numRuns: runs(200) },
    );
  });
});

/** Everything the guard needs to honour a marker: real disk, but the marker and its directory belong to uid 1000 with sane modes, and the hash is trusted. */
function trustedIo(ws: string, home: string, over: Partial<FsIo> = {}, text?: string, uid: number | null = 1000): FsIo {
  mkdirSync(join(home, '.h7'), { recursive: true });
  writeFileSync(trustFile(home), JSON.stringify({ [join(ws, MARKER)]: sha256(text ?? readFileSync(join(ws, MARKER), 'utf8')) }));
  return {
    ...realFsIo,
    uid,
    lstat(file) {
      const stat = realFsIo.lstat(file);
      if (stat === null || (!file.endsWith(MARKER) && file !== ws)) return stat;
      return { isSymbolicLink: () => stat.isSymbolicLink(), isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), size: stat.size, uid: 1000, mode: 0o644 };
    },
    ...over,
  };
}

describe('workspace scratch directory', () => {
  const real = process.platform === 'win32' ? 'win32' : 'posix';
  const fwd = (p: string): string => p.split('\\').join('/');

  /** <home>[/<parent>]/team with repo web (and optional extras), a tmp dir, the marker; cwd for the guard is team/web. */
  function setup(marker: unknown, parent = ''): { ws: string; home: string; web: string } {
    const home = tmpDir('h7-scratch-');
    const ws = join(home, parent, 'team');
    mkdirSync(join(ws, 'web', '.git'), { recursive: true });
    mkdirSync(join(ws, 'tmp', 'topic'), { recursive: true });
    writeFileSync(join(ws, MARKER), JSON.stringify(marker));
    return { ws, home, web: join(ws, 'web') };
  }
  const ctxFor = (cwd: string, home: string, io: FsIo): Ctx => ({
    cwd,
    home,
    paths: makePaths(real, realpathSync),
    git: fakeGit({ root: cwd }),
    disk: fakeDisk({}),
    taint: { home: false },
    tmp: withScratch([], cwd, home, io),
  });
  const rule = (ctx: Ctx, command: string): string | null => {
    const found = pickDecision(scan(command, 'sh', ctx, newState(ctx.cwd)));
    return found === null ? null : `${found.decision}:${found.rule}`;
  };
  const GOOD = { version: 1, scratch: 'tmp', repos: { web: {} } };
  const scratchOf = (s: { web: string; home: string }, io: FsIo): string[] => scratchDirs(s.web, io, s.home);

  it('allows recursive deletes strictly inside the declared scratch dir, for a trusted marker that lists the repo', () => {
    const s = setup(GOOD);
    const ctx = ctxFor(s.web, s.home, trustedIo(s.ws, s.home));
    assert.equal(rule(ctx, `rm -rf ${fwd(s.ws)}/tmp/topic`), null);
    assert.equal(rule(ctx, 'rm -rf ../tmp/topic'), null);
    assert.equal(rule(ctx, `rm -rf ${fwd(s.ws)}/tmp`), 'block:recursive-delete');
    assert.equal(rule(ctx, `rm -rf ${fwd(s.ws)}/web`), 'block:recursive-delete');
    assert.equal(rule(ctx, `rm -rf ${fwd(s.ws)}/other/x`), 'block:recursive-delete');
    assert.equal(rule(ctx, `rm -rf ${fwd(s.ws)}/tmp/../web`), 'block:recursive-delete');
    assert.equal(rule(ctx, `rm -rf ${fwd(s.ws)}`), 'block:recursive-delete');
  });

  it('gives nothing without a declared scratch dir', () => {
    const s = setup({ version: 1, repos: { web: {} } });
    assert.deepEqual(scratchOf(s, trustedIo(s.ws, s.home)), []);
  });

  it('gives nothing for an untrusted or changed marker', () => {
    const s = setup(GOOD);
    assert.deepEqual(scratchOf(s, { ...trustedIo(s.ws, s.home), read: () => { throw new Error('no trust file'); } }), []);
    assert.deepEqual(scratchOf(s, trustedIo(s.ws, s.home, {}, '{"version":1}')), []);
    assert.equal(scratchOf(s, trustedIo(s.ws, s.home, {}, undefined, null)).length, 1);
    assert.equal(scratchOf(s, trustedIo(s.ws, s.home)).length, 1);
    const ctx = ctxFor(s.web, s.home, trustedIo(s.ws, s.home, {}, '{"version":1}'));
    assert.equal(rule(ctx, `rm -rf ${fwd(s.ws)}/tmp/topic`), 'block:recursive-delete');
  });

  it('gives nothing from the workspace root or a repo the marker does not list', () => {
    const s = setup(GOOD);
    mkdirSync(join(s.ws, 'other', '.git'), { recursive: true });
    const io = trustedIo(s.ws, s.home);
    assert.deepEqual(scratchDirs(s.ws, io, s.home), []);
    assert.deepEqual(scratchDirs(join(s.ws, 'other'), io, s.home), []);
    assert.deepEqual(scratchDirs(tmpDir('h7-nogit-'), io, s.home), []);
  });

  it('ignores a marker planted inside a repo: the marker directory must not be a git work tree', () => {
    const s = setup(GOOD);
    const inner = join(s.web, 'inner');
    mkdirSync(join(inner, '.git'), { recursive: true });
    mkdirSync(join(s.web, 'tmp'));
    writeFileSync(join(s.web, MARKER), JSON.stringify({ version: 1, scratch: 'tmp', repos: { inner: {} } }));
    const io = trustedIo(s.web, s.home);
    assert.deepEqual(scratchDirs(inner, io, s.home), []);
    const root = setup(GOOD);
    mkdirSync(join(root.ws, '.git'));
    assert.deepEqual(scratchOf(root, trustedIo(root.ws, root.home)), []);
    const nested = setup(GOOD, 'code');
    mkdirSync(join(nested.home, 'code', '.git'));
    assert.deepEqual(scratchOf(nested, trustedIo(nested.ws, nested.home)), []);
  });

  it('gives nothing when the scratch dir sits inside or contains a git work tree, however small', () => {
    const inside = setup({ version: 1, scratch: 'tools/tmp', repos: { web: {} } });
    mkdirSync(join(inside.ws, 'tools', 'tmp'), { recursive: true });
    mkdirSync(join(inside.ws, 'tools', '.git'));
    assert.deepEqual(scratchOf(inside, trustedIo(inside.ws, inside.home)), []);
    const contains = setup(GOOD);
    mkdirSync(join(contains.ws, 'tmp', 'deep', 'proj', '.git'), { recursive: true });
    assert.deepEqual(scratchOf(contains, trustedIo(contains.ws, contains.home)), []);
    const file = setup(GOOD);
    writeFileSync(join(file.ws, 'tmp', '.git'), 'gitdir: x');
    assert.deepEqual(scratchOf(file, trustedIo(file.ws, file.home)), []);
  });

  it('gives nothing for a huge scratch tree, an unreadable directory or an entry that cannot be examined', () => {
    const s = setup(GOOD);
    const scratch = join(s.ws, 'tmp');
    const many = trustedIo(s.ws, s.home, { readdir: (dir) => (dir === scratch ? Array.from({ length: MAX_SCRATCH_ENTRIES + 1 }, (_, i) => `f${i}`) : realFsIo.readdir(dir)) });
    assert.deepEqual(scratchOf(s, many), []);
    const unreadable = trustedIo(s.ws, s.home, { readdir: (dir) => { if (dir === scratch) throw new Error('EACCES'); return realFsIo.readdir(dir); } });
    assert.deepEqual(scratchOf(s, unreadable), []);
    const ghost = trustedIo(s.ws, s.home, { readdir: (dir) => (dir === scratch ? ['ghost'] : realFsIo.readdir(dir)) });
    assert.deepEqual(scratchOf(s, ghost), []);
    const nested = trustedIo(s.ws, s.home, { readdir: (dir) => { if (dir === join(scratch, 'topic')) throw new Error('EACCES'); return realFsIo.readdir(dir); } });
    assert.deepEqual(scratchOf(s, nested), []);
    const broken = trustedIo(s.ws, s.home, { lstat: () => { throw new Error('boom'); } });
    assert.deepEqual(scratchOf(s, broken), []);
  });

  it('does not follow links while looking for a nested git work tree', () => {
    const s = setup(GOOD);
    const elsewhere = tmpDir('h7-away-');
    mkdirSync(join(elsewhere, '.git'));
    symlinkSync(elsewhere, join(s.ws, 'tmp', 'link'), 'junction');
    assert.equal(scratchOf(s, trustedIo(s.ws, s.home)).length, 1);
  });

  it('ignores a scratch dir that a link points outside the workspace or into a repo', () => {
    const a = setup({ version: 1, scratch: 'link', repos: { web: {} } });
    symlinkSync(tmpDir('h7-away-'), join(a.ws, 'link'), 'junction');
    assert.deepEqual(scratchOf(a, trustedIo(a.ws, a.home)), []);
    const b = setup({ version: 1, scratch: 'link', repos: { web: {} } });
    symlinkSync(b.web, join(b.ws, 'link'), 'junction');
    assert.deepEqual(scratchOf(b, trustedIo(b.ws, b.home)), []);
  });

  it('property: scratch never allows a delete the plain rule refuses outside it', () => {
    const s = setup(GOOD);
    const ctx = ctxFor(s.web, s.home, trustedIo(s.ws, s.home));
    const plain: Ctx = { ...ctx, tmp: { dirs: [] } };
    const scratch = join(realpathSync(s.ws), 'tmp');
    const starts = ['', '/web', '/tmp', '/tmp/a', '/other', '/tmp/../web', '/tmpx', '/Tmp/a', '/tmp/./a/../..', '/web/../tmp', '/..'];
    const tails = fc.array(fc.constantFrom('', 'a', '..', 'a/b', '.', '*', 'tmp'), { maxLength: 3 });
    fc.assert(
      fc.property(fc.constantFrom(...starts), tails, (start, tail) => {
        const command = `rm -rf ${fwd(s.ws)}${start}/${tail.join('/')}`;
        const globAt = tail.findIndex((part) => /[*?[]/.test(part));
        const kept = globAt === -1 ? tail : tail.slice(0, globAt);
        const parts: string[] = [];
        for (const part of fwd(join(realpathSync(s.ws), start.replace(/^\//, ''), ...kept)).replace(/\/\.(?=\/|$)/g, '').split('/')) {
          if (part === '..') parts.pop();
          else parts.push(part);
        }
        const lower = parts.join('/').toLowerCase();
        const root = fwd(scratch).toLowerCase();
        const inside = lower.startsWith(`${root}/`) || (globAt !== -1 && lower === root);
        const without = rule(plain, command);
        if (!inside) assert.equal(rule(ctx, command), without, command);
        else assert.ok(rule(ctx, command) === null || rule(ctx, command) === without, command);
      }),
      { numRuns: runs(200) },
    );
  });

  it('looks the scratch dir up once, and only when read', () => {
    let calls = 0;
    const s = setup(GOOD);
    const counting = trustedIo(s.ws, s.home, { lstat: (file) => { calls += 1; return realFsIo.lstat(file); } });
    const info = withScratch(['/x'], s.web, s.home, counting);
    assert.equal(calls, 0);
    const first = info.dirs.length;
    const after = calls;
    assert.ok(after > 0 && first >= 1);
    assert.equal(info.dirs.length, first);
    assert.equal(calls, after);
  });
});
