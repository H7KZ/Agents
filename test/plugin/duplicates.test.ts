import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { duplicateSkillLinks, installedPlugins, knownMarketplaces, lockPath, mattpocockSkillNames, readJson, removeMattpocockLockEntries } from '../../plugins/h7/scripts/duplicates.ts';
import { cleanupTmp, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

function lock(skills: Record<string, string>): string {
  return JSON.stringify({ version: 3, skills: Object.fromEntries(Object.entries(skills).map(([k, source]) => [k, { source }])) });
}

function machine(skills: Record<string, string>, linked: string[], unrelated: string[] = []): string {
  const home = tmpDir();
  writeTree(home, { '.agents/.skill-lock.json': lock(skills) });
  for (const name of [...linked, ...unrelated]) mkdirSync(join(home, '.agents', 'skills', name), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  for (const name of linked) symlinkSync(join(home, '.agents', 'skills', name), join(home, '.claude', 'skills', name), 'junction');
  return home;
}

describe('readJson', () => {
  it('returns objects and null for everything else', () => {
    const dir = tmpDir();
    writeTree(dir, { 'obj.json': '{"a":1}', 'arr.json': '[]', 'str.json': '"x"', 'null.json': 'null', 'bad.json': '{' });
    assert.deepEqual(readJson(join(dir, 'obj.json')), { a: 1 });
    for (const name of ['arr.json', 'str.json', 'null.json', 'bad.json', 'missing.json']) assert.equal(readJson(join(dir, name)), null, name);
  });
});

describe('installedPlugins', () => {
  it('lists plugin ids and tolerates absent or malformed files', () => {
    const home = tmpDir();
    assert.deepEqual(installedPlugins(home), []);
    writeTree(home, { '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'a@m': [], 'b@n': [] } }) });
    assert.deepEqual(installedPlugins(home), ['a@m', 'b@n']);
    writeTree(home, { '.claude/plugins/installed_plugins.json': '{"plugins":null}' });
    assert.deepEqual(installedPlugins(home), []);
    writeTree(home, { '.claude/plugins/installed_plugins.json': '{}' });
    assert.deepEqual(installedPlugins(home), []);
  });
});

describe('duplicateSkillLinks', () => {
  it('finds only symlinks into ~/.agents/skills for mattpocock/skills entries', () => {
    const home = machine({ tdd: 'mattpocock/skills', 'code-review': 'mattpocock/skills', 'find-skills': 'vercel-labs/skills' }, ['tdd', 'code-review', 'find-skills']);
    assert.deepEqual(
      duplicateSkillLinks(home).map((p) => p.split(/[\\/]/).pop()),
      ['code-review', 'tdd'],
    );
  });

  it('ignores real directories, files and links elsewhere', () => {
    const home = machine({ tdd: 'mattpocock/skills', real: 'mattpocock/skills', other: 'mattpocock/skills', file: 'mattpocock/skills' }, [], ['real']);
    mkdirSync(join(home, '.claude', 'skills', 'real'));
    writeFileSync(join(home, '.claude', 'skills', 'file'), 'x');
    const elsewhere = tmpDir();
    symlinkSync(elsewhere, join(home, '.claude', 'skills', 'other'), 'junction');
    assert.deepEqual(duplicateSkillLinks(home), []);
  });

  it('returns nothing without a lock file, skills dir or valid lock', () => {
    assert.deepEqual(duplicateSkillLinks(tmpDir()), []);
    const home = tmpDir();
    writeTree(home, { '.agents/.skill-lock.json': '{"skills":null}' });
    assert.deepEqual(duplicateSkillLinks(home), []);
    writeTree(home, { '.agents/.skill-lock.json': '{"skills":{"a":null,"b":5}}', '.claude/skills/b/x': '' });
    assert.deepEqual(duplicateSkillLinks(home), []);
  });
});

describe('removeMattpocockLockEntries', () => {
  const capture = () => {
    const writes: { file: string; text: string }[] = [];
    return { writes, write: (file: string, text: string) => void writes.push({ file, text }) };
  };

  it('removes only mattpocock/skills entries and keeps other keys, indentation, CRLF, BOM and the trailing newline', () => {
    const home = tmpDir();
    const original = '﻿{\r\n\t"version": 3,\r\n\t"skills": {\r\n\t\t"a": {"source": "mattpocock/skills"},\r\n\t\t"b": {"source": "me/skills"},\r\n\t\t"c": {"source": "mattpocock/skills"}\r\n\t}\r\n}\r\n';
    writeTree(home, { '.agents/.skill-lock.json': original });
    const out = capture();
    assert.equal(removeMattpocockLockEntries(home, out.write), 2);
    assert.equal(out.writes.length, 1);
    const text = out.writes[0]?.text as string;
    assert.equal(out.writes[0]?.file, lockPath(home));
    assert.ok(text.startsWith('﻿{\r\n\t"version": 3'));
    assert.ok(text.endsWith('}\r\n'));
    assert.ok(!/[^\r]\n/.test(text));
    assert.deepEqual(JSON.parse(text.slice(1)), { version: 3, skills: { b: { source: 'me/skills' } } });
  });

  it('defaults to two-space indentation without a trailing newline and writes nothing when there is nothing to remove', () => {
    const home = tmpDir();
    writeTree(home, { '.agents/.skill-lock.json': '{"skills":{"a":{"source":"mattpocock/skills"}}}' });
    const out = capture();
    assert.equal(removeMattpocockLockEntries(home, out.write), 1);
    assert.equal(out.writes[0]?.text, '{\n  "skills": {}\n}');
    const none = tmpDir();
    assert.equal(removeMattpocockLockEntries(none, out.write), 0);
    writeTree(none, { '.agents/.skill-lock.json': lock({ x: 'me/skills' }) });
    assert.equal(removeMattpocockLockEntries(none, out.write), 0);
    assert.equal(out.writes.length, 1);
  });

  it('mattpocockSkillNames and knownMarketplaces read the same files', () => {
    const home = tmpDir();
    writeTree(home, { '.agents/.skill-lock.json': lock({ a: 'mattpocock/skills', b: 'x/y' }), '.claude/plugins/known_marketplaces.json': '{"h7kz":{}}' });
    assert.deepEqual([...mattpocockSkillNames(home)], ['a']);
    assert.deepEqual(knownMarketplaces(home), { h7kz: {} });
    assert.equal(knownMarketplaces(tmpDir()), null);
  });
});
