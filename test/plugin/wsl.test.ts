import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { parseSimple, wslCall } from '../../plugins/h7/scripts/command.ts';
import { makePaths } from '../../plugins/h7/scripts/paths.ts';
import { pickDecision, scan } from '../../plugins/h7/scripts/scan.ts';
import { newState, type Ctx } from '../../plugins/h7/scripts/types.ts';
import { MARKER, realFsIo, scratchDirs, withScratch } from '../../plugins/h7/scripts/workspace.ts';
import { cleanupTmp, runs, tmpDir } from '../../scripts/test/helpers.ts';
import { decide, fakeDisk, fakeGit, ruleOf } from './support.ts';

cleanupTmp();

const q = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
const wsl = (inner: string, flags = '-d Ubuntu --exec'): string => `wsl.exe ${flags} bash -lc ${q(inner)}`;

describe('wslCall', () => {
  const call = (line: string) => wslCall(parseSimple(line.split(' ')));

  it('turns the exec forms into a quoted script', () => {
    for (const lead of ['--exec', '-e', '--']) assert.deepEqual(call(`wsl.exe -d Ubuntu ${lead} ls -la`), { script: "'ls' '-la'", cwd: false });
    assert.deepEqual(call('wsl -u root --system --exec echo'), { script: "'echo'", cwd: false });
    assert.deepEqual(call('wsl --cd /srv -e pwd'), { script: "'pwd'", cwd: true });
    assert.deepEqual(wslCall(parseSimple(['wsl', '-e', "it's", 'a b'])), { script: `'it'\\''s' 'a b'`, cwd: false });
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
      assert.equal(ruleOf(wsl(inner, '-d Ubuntu --'), { dirty: true }), plain, inner);
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
    const flags = fc.constantFrom('--exec', '-e', '--', '-d Ubuntu --exec', '-d Ubuntu -u root -e', '--system --exec', '--cd /x --exec');
    const rank = (rule: string | null): number => (rule === null ? 0 : rule.startsWith('ask:') ? 1 : 2);
    fc.assert(
      fc.property(inner, flags, fc.boolean(), (script, lead, dirty) => {
        const options = { dirty, branch: 'main', defaultBranch: 'main' };
        assert.ok(rank(ruleOf(wsl(script, lead), options)) >= rank(ruleOf(`bash -c ${q(script)}`, options)), `${lead} ${script}`);
      }),
      { numRuns: runs(150) },
    );
  });

  it('property: arbitrary wsl lines never throw and decide ask or block unless they are management calls or exec of a clean command', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('-d', 'Ubuntu', '--exec', '-e', '--', 'bash', '-lc', "'ls'", '--cd', '/x', '-u', 'root', 'rm', '-rf', '/', '-l', '--status'), { maxLength: 8 }), (words) => {
        const line = `wsl.exe ${words.join(' ')}`;
        const decision = decide(line);
        const call = wslCall(parseSimple(words.length === 0 ? ['wsl.exe'] : ['wsl.exe', ...words]));
        if (call !== null && 'ask' in call) assert.equal(decision?.rule, 'wsl-exec');
      }),
      { numRuns: runs(200) },
    );
  });
});

describe('workspace scratch directory', () => {
  const real = process.platform === 'win32' ? 'win32' : 'posix';
  const fwd = (p: string): string => p.split('\\').join('/');

  function setup(marker: unknown): { ws: string; home: string; ctx: Ctx } {
    const home = tmpDir('h7-scratch-');
    const ws = join(home, 'team');
    mkdirSync(join(ws, 'web', '.git'), { recursive: true });
    mkdirSync(join(ws, 'tmp', 'topic'), { recursive: true });
    writeFileSync(join(ws, MARKER), JSON.stringify(marker));
    const ctx: Ctx = {
      cwd: join(ws, 'web'),
      home,
      paths: makePaths(real, realpathSync),
      git: fakeGit({ root: join(ws, 'web') }),
      disk: fakeDisk({}),
      taint: { home: false },
      tmp: withScratch([], join(ws, 'web'), home),
    };
    return { ws, home, ctx };
  }
  const rule = (ctx: Ctx, command: string): string | null => {
    const found = pickDecision(scan(command, 'sh', ctx, newState(ctx.cwd)));
    return found === null ? null : `${found.decision}:${found.rule}`;
  };

  it('allows recursive deletes strictly inside the declared scratch dir, from the workspace root', () => {
    const { ws, ctx } = setup({ version: 1, scratch: 'tmp', repos: { web: {} } });
    assert.equal(rule(ctx, `rm -rf ${fwd(ws)}/tmp/topic`), null);
    assert.equal(rule(ctx, 'rm -rf ../tmp/topic'), null);
    assert.equal(rule(ctx, `rm -rf ${fwd(ws)}/tmp`), 'block:recursive-delete');
    assert.equal(rule(ctx, `rm -rf ${fwd(ws)}/web`), 'block:recursive-delete');
    assert.equal(rule(ctx, `rm -rf ${fwd(ws)}/other/x`), 'block:recursive-delete');
    assert.equal(rule(ctx, `rm -rf ${fwd(ws)}/tmp/../web`), 'block:recursive-delete');
    assert.equal(rule(ctx, `rm -rf ${fwd(ws)}`), 'block:recursive-delete');
  });

  it('does nothing without a declared scratch dir, without a marker, or with an untrusted marker', () => {
    const none = setup({ version: 1, repos: { web: {} } });
    assert.equal(rule(none.ctx, 'rm -rf ../tmp/topic'), 'block:recursive-delete');
    const bad = setup({ version: 1, scratch: 'tmp', repos: { web: {} } });
    writeFileSync(join(bad.ws, MARKER), '{nope');
    assert.equal(rule(bad.ctx, 'rm -rf ../tmp/topic'), 'block:recursive-delete');
    const outside = tmpDir('h7-nomarker-');
    assert.deepEqual(scratchDirs(outside, realFsIo, outside), []);
  });

  it('ignores a scratch dir that a link points outside the workspace or into a repo', () => {
    const a = setup({ version: 1, scratch: 'link', repos: { web: {} } });
    symlinkSync(tmpDir('h7-away-'), join(a.ws, 'link'), 'junction');
    assert.deepEqual(scratchDirs(a.ws, realFsIo, a.home), []);
    const b = setup({ version: 1, scratch: 'link', repos: { web: {} } });
    symlinkSync(join(b.ws, 'web'), join(b.ws, 'link'), 'junction');
    assert.deepEqual(scratchDirs(b.ws, realFsIo, b.home), []);
    const c = setup({ version: 1, scratch: 'tmp', repos: { web: {} } });
    assert.deepEqual(scratchDirs(c.ws, realFsIo, c.home), [join(realpathSync(c.ws), 'tmp')]);
  });

  it('property: scratch never allows a delete the plain rule refuses outside it', () => {
    const { ws, home, ctx } = setup({ version: 1, scratch: 'tmp', repos: { web: {} } });
    const plain: Ctx = { ...ctx, tmp: { dirs: [] } };
    const scratch = join(realpathSync(ws), 'tmp');
    const starts = ['', '/web', '/tmp', '/tmp/a', '/other', '/tmp/../web', '/tmpx', '/Tmp/a', '/tmp/./a/../..', '/web/../tmp', '/..'];
    const tails = fc.array(fc.constantFrom('', 'a', '..', 'a/b', '.', '*', 'tmp'), { maxLength: 3 });
    fc.assert(
      fc.property(fc.constantFrom(...starts), tails, (start, tail) => {
        const target = `${fwd(ws)}${start}/${tail.join('/')}`;
        const command = `rm -rf ${target}`;
        const inside = (() => {
          const globAt = tail.findIndex((part) => /[*?[]/.test(part));
          const kept = globAt === -1 ? tail : tail.slice(0, globAt);
          const rel = join(realpathSync(ws), start.replace(/^\//, ''), ...kept).split('\\').join('/');
          const norm = rel.replace(/\/\.(?=\/|$)/g, '');
          const parts: string[] = [];
          for (const part of norm.split('/')) {
            if (part === '..') parts.pop();
            else parts.push(part);
          }
          const resolved = parts.join('/');
          const root = scratch.split('\\').join('/');
          const lower = resolved.toLowerCase();
          return lower.startsWith(`${root.toLowerCase()}/`) || (globAt !== -1 && lower === root.toLowerCase());
        })();
        const without = rule(plain, command);
        if (!inside) assert.equal(rule(ctx, command), without, command);
        else assert.ok(rule(ctx, command) === null || rule(ctx, command) === without, command);
      }),
      { numRuns: runs(200) },
    );
    assert.ok(home.length > 0);
  });

  it('looks the scratch dir up once, and only when read', () => {
    let calls = 0;
    const counting = { ...realFsIo, lstat: (file: string) => { calls += 1; return realFsIo.lstat(file); } };
    const { ws, home } = setup({ version: 1, scratch: 'tmp', repos: { web: {} } });
    const info = withScratch(['/x'], ws, home, counting);
    assert.equal(calls, 0);
    assert.equal(info.dirs.length, 2);
    const first = calls;
    assert.equal(info.dirs.length, 2);
    assert.equal(calls, first);
  });
});
