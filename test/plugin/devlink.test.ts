import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { devLinkPath, inspectDevLink } from '../../plugins/h7/scripts/devlink.ts';
import { cleanupTmp, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

function link(target: string): string {
  const home = tmpDir();
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(target, devLinkPath(home), 'junction');
  return home;
}

describe('inspectDevLink', () => {
  it('is absent without a link and not-a-link for a real directory or file', () => {
    const home = tmpDir();
    assert.deepEqual(inspectDevLink(home), { path: join(home, '.claude', 'skills', 'h7'), state: 'absent', target: null });
    writeTree(home, { '.claude/skills/h7/x': '' });
    assert.equal(inspectDevLink(home).state, 'not-a-link');
  });

  it('is ok for a link to a directory whose plugin.json names h7, and reports the real target', () => {
    const target = tmpDir();
    writeTree(target, { '.claude-plugin/plugin.json': '{"name":"h7"}' });
    const found = inspectDevLink(link(target));
    assert.equal(found.state, 'ok');
    assert.equal(found.target, realpathSync(target));
  });

  it('is foreign for a link to another plugin or a directory without a manifest, broken when the target is gone', () => {
    const other = tmpDir();
    writeTree(other, { '.claude-plugin/plugin.json': '{"name":"other"}' });
    assert.equal(inspectDevLink(link(other)).state, 'foreign');
    assert.equal(inspectDevLink(link(tmpDir())).state, 'foreign');
    const gone = tmpDir();
    const home = link(gone);
    rmSync(gone, { recursive: true });
    assert.deepEqual([inspectDevLink(home).state, inspectDevLink(home).target], ['broken', null]);
  });
});
