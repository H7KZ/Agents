import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SLOW, cleanupTmp, runNode, tmpDir } from '../../../scripts/test/helpers.ts';

cleanupTmp();

const script = join(import.meta.dirname, '..', 'scripts', 'guard.ts');

function run(command: string, extra: Record<string, string> = {}, tool = 'Bash') {
  const home = tmpDir('h7-home-');
  const cwd = tmpDir();
  const input = JSON.stringify({ tool_name: tool, tool_input: { command }, cwd });
  return { home, ...runNode(script, [], { input, env: { H7_HOME: home, ...extra } }) };
}

describe('guard.ts entry point', SLOW, () => {
  it('exits 2 with a reason on stderr and logs when blocking', () => {
    const result = run('git push --force origin main');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /force-push-protected/);
    assert.equal(result.stdout, '');
    const line = JSON.parse(readFileSync(join(result.home, '.h7', 'guard.log'), 'utf8').trim());
    assert.equal(line.rule, 'force-push-protected');
    assert.equal(line.cwd.length > 0, true);
  });

  it('prints ask JSON on stdout with exit 0', () => {
    const result = run('npm publish');
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(result.stderr, '');
  });

  it('allows silently, honours the kill switch, and asks on garbage', () => {
    const allowed = run('echo hello');
    assert.deepEqual([allowed.status, allowed.stdout, allowed.stderr], [0, '', '']);
    assert.equal(run('git push -f origin main', { H7_GUARD: 'off' }).status, 0);
    const home = tmpDir('h7-home-');
    const garbage = runNode(script, [], { input: '{', env: { H7_HOME: home } });
    assert.equal(garbage.status, 0);
    assert.equal(JSON.parse(garbage.stdout).hookSpecificOutput.permissionDecision, 'ask');
  });

  it('uses the platform to pick path semantics and reads the real platform', () => {
    const windowsStyle = run('Remove-Item -Recurse -Force C:\\Windows\\x', {}, 'PowerShell');
    assert.equal(windowsStyle.status, process.platform === 'win32' ? 2 : 0);
  });
});
