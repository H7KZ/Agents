import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkManifests, main } from '../check-manifests.ts';
import { cleanupTmp, runNode, tmpDir, writeTree } from './helpers.ts';

cleanupTmp();

const marketplace = (over: object = {}) =>
  JSON.stringify({ name: 'h7kz', owner: { name: 'H7KZ' }, plugins: [{ name: 'h7', source: './plugins/h7' }], ...over });
const manifest = (over: object = {}) => JSON.stringify({ name: 'h7', ...over });
const hooks = (script: string) =>
  JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: [script] }] }] } });

function repo(files: Record<string, string>): string {
  const dir = tmpDir();
  writeTree(dir, files);
  return dir;
}

function problems(dir: string): string[] {
  return checkManifests(dir).map((p) => p.message.replace(/^invalid JSON: .*/, 'invalid JSON'));
}

const base = {
  '.claude-plugin/marketplace.json': marketplace(),
  'plugins/h7/.claude-plugin/plugin.json': manifest(),
};

describe('checkManifests', () => {
  it('accepts a valid layout including hooks and package.json files', () => {
    const dir = repo({
      ...base,
      'plugins/h7/hooks/hooks.json': hooks('${CLAUDE_PLUGIN_ROOT}/scripts/guard.ts'),
      'plugins/h7/scripts/guard.ts': '',
      'package.json': '{}',
      'plugins/h7/package.json': '{}',
    });
    assert.deepEqual(problems(dir), []);
  });

  it('ignores hook args that do not use the plugin root variable and non-string args', () => {
    const dir = repo({ ...base, 'plugins/h7/hooks/hooks.json': JSON.stringify({ hooks: { A: [{ args: ['plain', 3] }] } }) });
    assert.deepEqual(problems(dir), []);
  });

  it('reports invalid marketplace JSON and stops', () => {
    assert.deepEqual(problems(repo({ '.claude-plugin/marketplace.json': '{' })), ['invalid JSON']);
  });

  it('reports a missing marketplace file', () => {
    assert.deepEqual(problems(tmpDir()), ['invalid JSON']);
  });

  it('reports wrong marketplace name and missing plugins array', () => {
    assert.deepEqual(problems(repo({ '.claude-plugin/marketplace.json': JSON.stringify({ name: 'other' }) })), ['marketplace name must be "h7kz"']);
  });

  it('reports bad or missing sources', () => {
    const out = problems(repo({ '.claude-plugin/marketplace.json': marketplace({ plugins: [{ name: 'a', source: 'plugins/a' }, { name: 'b', source: './missing' }, { name: 'c' }] }) }));
    assert.equal(out.length, 3);
    assert.match(out[0] as string, /plugin "a" source does not exist: plugins\/a/);
  });

  it('reports plugin.json problems: name mismatch, version, invalid JSON', () => {
    assert.deepEqual(problems(repo({ ...base, 'plugins/h7/.claude-plugin/plugin.json': manifest({ name: 'x', version: '1.0.0' }) })), [
      'name "x" must equal marketplace entry "h7"',
      'version must be omitted (commit SHA is the version)',
    ]);
    assert.deepEqual(problems(repo({ ...base, 'plugins/h7/.claude-plugin/plugin.json': 'nope' })), ['invalid JSON']);
  });

  it('reports hook scripts that do not exist and invalid hooks or package JSON', () => {
    assert.deepEqual(problems(repo({ ...base, 'plugins/h7/hooks/hooks.json': hooks('${CLAUDE_PLUGIN_ROOT}/scripts/none.ts') })), [
      'hook script does not exist: ${CLAUDE_PLUGIN_ROOT}/scripts/none.ts',
    ]);
    assert.deepEqual(problems(repo({ ...base, 'plugins/h7/hooks/hooks.json': '[' })), ['invalid JSON']);
    assert.deepEqual(problems(repo({ ...base, 'package.json': '[' })), ['invalid JSON']);
  });
});

describe('main and CLI', () => {
  it('prints problems and returns 1, or returns 0', () => {
    const lines: string[] = [];
    assert.equal(main([repo({ '.claude-plugin/marketplace.json': '{' })], (l) => lines.push(l)), 1);
    assert.equal(lines.length, 1);
    assert.equal(main([repo(base)], () => assert.fail('no output expected')), 0);
  });

  it('defaults to the repository root and passes', () => {
    assert.equal(main([], () => {}), 0);
  });

  it('works as a subprocess', () => {
    const script = join(import.meta.dirname, '..', 'check-manifests.ts');
    assert.equal(runNode(script, []).status, 0);
    assert.equal(runNode(script, [tmpDir()]).status, 1);
  });
});
