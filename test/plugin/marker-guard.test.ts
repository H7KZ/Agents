import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { run, type GuardIo } from '../../plugins/h7/scripts/guard-core.ts';
import type { Runner } from '../../plugins/h7/scripts/git.ts';
import { cleanupTmp, runs, tmpDir } from '../../scripts/test/helpers.ts';
import { repoDisk } from './support.ts';

cleanupTmp();

const runner: Runner = (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: '/repo\n' } : { status: 128, stdout: '' });

function guard(input: object, platform: 'posix' | 'win32' = 'posix', home: string = tmpDir('h7-marker-guard-')): { code: number; stderr: string; home: string } {
  const stdin = JSON.stringify({ cwd: '/repo', ...input });
  const io: GuardIo = {
    stdin,
    env: { H7_HOME: home },
    platform,
    runner,
    realpath: (p) => p,
    disk: repoDisk,
    homedir: home,
    tmpdir: '/nonexistent-tmp',
    fallbackCwd: '/fallback',
    now: () => new Date('2026-02-03T04:05:06.000Z'),
  };
  const result = run(stdin, io.env, io);
  return { code: result.code, stderr: result.stderr, home };
}

const file = (tool: string, target: string, platform: 'posix' | 'win32' = 'posix') => guard({ tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: target } : { file_path: target } }, platform);
const shell = (command: string, tool = 'Bash') => guard({ tool_name: tool, tool_input: { command } });

const blocked = (r: { code: number; stderr: string }, label: string): void => {
  assert.equal(r.code, 2, label);
  assert.match(r.stderr, /^h7 guard blocked \[workspace-marker\]: .*Ask the user to edit it\.\n$/, label);
};

describe('the trust command is for the person to run', () => {
  it('blocks any command naming workspace.ts together with trust, however it is quoted or spaced', () => {
    for (const command of [
      'node workspace.ts trust',
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.ts" trust',
      'node scripts/WORKSPACE.TS TRUST',
      "node scripts/work'space'.ts 'tr'ust",
      'node scripts/workspace.ts   "t"r"u"st /x',
      'node scripts/workspace.ts tr\\ust',
      'cd x && node ./workspace.ts trust',
      'echo yes | node workspace.ts trust',
      'node workspace.ts trust',
    ]) {
      const r = shell(command);
      assert.equal(r.code, 2, command);
      assert.match(r.stderr, /^h7 guard blocked \[workspace-trust\]: .*your own terminal/, command);
    }
    const ps = shell('node .\scripts\workspace.ts trust', 'PowerShell');
    assert.match(ps.stderr, /workspace-trust/);
  });

  it('leaves other uses of workspace.ts, and the word trust elsewhere, alone', () => {
    for (const command of ['node workspace.ts show', 'node workspace.ts status', 'echo trust', 'git log --grep trust']) {
      const r = shell(command);
      assert.deepEqual([r.code, r.stderr], [0, ''], command);
    }
  });
});

describe('a mention of the marker or the journal is refused unless every command only reads', () => {
  const NAME = ['.h7', 'workspace.json'].join('-');
  it('blocks every spelling of a write the old denylist could miss', () => {
    for (const command of [`python3 -c "open('${NAME}','w')"`, `dd of=${NAME}`, `ruby -e 1 ${NAME}`, `curl -o ${NAME} x`, `git checkout -- ${NAME}`, `cat x | cat > ${NAME}`, `awk 1 ${NAME} > o`, `xargs rm < ${NAME}`, `ls $(rm ${NAME})`, `cat $X ${NAME}`]) {
      blocked(shell(command), command);
    }
    blocked(shell(`Move-Item ${NAME} x`, 'PowerShell'), 'ps');
  });

  it('lets readers through', () => {
    for (const command of [`cat ${NAME}`, `grep scratch ${NAME} | head`, `git diff -- ${NAME}`, `ls -la ${NAME}`]) {
      const r = shell(command);
      assert.deepEqual([r.code, r.stderr], [0, ''], command);
    }
  });
});

describe('the trust file stays protected', () => {
  it('blocks file tools and shell writes that name the trust file under the h7 home', () => {
    const home = tmpDir('h7-trust-guard-');
    const target = join(home, '.h7', 'workspaces.json');
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const r = guard({ tool_name: tool, tool_input: { file_path: target } }, process.platform === 'win32' ? 'win32' : 'posix', home);
      assert.equal(r.code, 2, tool);
      assert.match(r.stderr, /\[guard-config\]/);
    }
    for (const command of [`echo '{}' > ${target}`, 'cp x ~/.h7/workspaces.json', 'tee $HOME/.h7/workspaces.json']) {
      const r = guard({ tool_name: 'Bash', tool_input: { command } }, process.platform === 'win32' ? 'win32' : 'posix', home);
      assert.equal(r.code, 2, command);
      assert.match(r.stderr, /\[guard-config\]/);
    }
  });
});

describe('the workspace marker is guard policy', () => {
  it('blocks file tools aimed at it in every path form', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      for (const target of ['/ws/.h7-workspace.json', '.h7-workspace.json', '../ws/.H7-WORKSPACE.JSON', '/ws/sub/../.h7-workspace.json', '/ws/.h7-workspace.json.', '/ws/.h7-workspace.json ', 'H7-WOR~1.JSO', '/ws/h7-wor~2.json']) {
        blocked(file(tool, target), `${tool} ${target}`);
      }
    }
  });

  it('blocks the Windows forms: drive, UNC, device prefix, streams, trailing dot', () => {
    for (const target of ['C:\\ws\\.h7-workspace.json', 'c:\\WS\\.H7-Workspace.JSON', '\\\\?\\C:\\ws\\.h7-workspace.json', '\\\\server\\share\\.h7-workspace.json', 'C:\\ws\\.h7-workspace.json::$DATA', 'C:\\ws\\.h7-workspace.json:evil', 'C:\\ws\\.h7-workspace.json.', 'C:/ws/.h7-workspace.json']) {
      blocked(file('Write', target, 'win32'), target);
    }
  });

  it('logs the block and lets other files through', () => {
    const r = file('Edit', '/ws/.h7-workspace.json');
    const [entry] = readFileSync(join(r.home, '.h7', 'guard.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entry.rule, 'workspace-marker');
    for (const target of ['/ws/notes.json', '/ws/h7-notes.md', '/ws/.h7/runs/x', '/ws/workspace.json']) {
      const ok = file('Write', target);
      assert.deepEqual([ok.code, ok.stderr], [0, ''], target);
    }
  });

  it('blocks shell commands that mention it with a write word or redirect', () => {
    for (const command of [
      "echo '{}' > .h7-workspace.json",
      'cp x .h7-workspace.json',
      'mv .h7-workspace.json old',
      'sed -i s/a/b/ .h7-workspace.json',
      'printf x | tee ../.H7-WORKSPACE.JSON',
      'echo x > .h7-"work"space.json',
      "echo x > .h7-'w'orkspace.json",
      'rm .h7-work*',
      'rm -f .h7-*.json',
      'truncate -s 0 /home/me/team/.h7-workspace.json',
      'node -e "fs.writeFileSync(\'.h7-workspace.json\', 1)"',
      'echo x >> C:\\ws\\.h7-workspace.json',
    ]) {
      blocked(shell(command), command);
    }
    for (const command of ['Set-Content .h7-workspace.json x', 'Remove-Item .h7-workspace.json', '"x" | Out-File .\\.h7-workspace.json']) blocked(shell(command, 'PowerShell'), command);
  });

  it('still lets the marker be read', () => {
    for (const command of ['cat .h7-workspace.json', 'ls -la .h7-workspace.json', 'Get-Content .h7-workspace.json', 'grep scratch .h7-workspace.json']) {
      const r = shell(command, command.startsWith('Get-') ? 'PowerShell' : 'Bash');
      assert.deepEqual([r.code, r.stderr], [0, ''], command);
    }
  });

  it('property: any command with the name and a redirect is blocked, one without the name is untouched by this rule', () => {
    const noise = fc.stringMatching(/^[a-z0-9 ./_-]{0,20}$/);
    fc.assert(
      fc.property(noise, noise, (before, after) => {
        blocked(shell(`echo ${before} > ${after}/.h7-workspace.json`), before);
        const r = shell(`echo ${before.replace(/h7-w/gi, 'x')} > /tmp/notes.txt`);
        assert.ok(!r.stderr.includes('workspace-marker'));
      }),
      { numRuns: runs(40) },
    );
  });
});
