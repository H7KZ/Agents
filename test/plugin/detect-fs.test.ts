import assert from 'node:assert/strict';
import type { Dirent } from 'node:fs';
import { describe, it } from 'node:test';
import { openRepo, SKIP_DIRS, type ReadDir } from '../../plugins/h7/scripts/detect-fs.ts';

const dirent = (name: string, dir: boolean): Dirent => ({ name, isDirectory: () => dir }) as Dirent;

describe('detect-fs: skipped directories', () => {
  const EXPECTED = [
    '.git', 'node_modules', '.next', '.nuxt', '.output', '.turbo', '.nx', '.venv', 'venv', 'dist', 'build', 'target', 'vendor', 'coverage',
    '__pycache__', '.stryker-tmp', '.h7', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', 'out',
  ];

  it('the skip list is exactly the vendored and generated directories', () => {
    assert.deepEqual([...SKIP_DIRS].sort(), [...EXPECTED].sort());
  });

  for (const name of EXPECTED) {
    it(`never descends into ${name}`, () => {
      const visited: string[] = [];
      const readDir: ReadDir = (dir) => {
        visited.push(dir.split('\\').join('/'));
        return dir.endsWith('/r') || dir.endsWith('\\r') ? [dirent(name, true), dirent('src', true)] : [dirent('f.txt', false)];
      };
      const repo = openRepo('/r', undefined, readDir);
      assert.deepEqual(repo.files, ['src/f.txt']);
      assert.ok(!visited.some((v) => v.endsWith(`/${name}`)), `${name} was read`);
    });
  }

  it('a plain file with a skipped name is still listed', () => {
    const readDir: ReadDir = () => [dirent('.git', false), dirent('dist', false)];
    assert.deepEqual(openRepo('/r', undefined, readDir).files, ['.git', 'dist']);
  });
});

describe('detect-fs: ordering', () => {
  it('sorts each directory by name, directories and files interleaved, deterministic', () => {
    const tree: Record<string, Dirent[]> = {
      '': [dirent('b.txt', false), dirent('z', true), dirent('a', true), dirent('B.txt', false), dirent('a.txt', false), dirent('c.txt', false)],
      z: [dirent('2', false), dirent('1', false)],
      a: [dirent('y', false), dirent('x', false)],
    };
    const readDir: ReadDir = (dir) => tree[dir.replace(/^[\\/]r[\\/]?/, '').split('\\').join('/')] ?? [];
    const repo = openRepo('/r', undefined, readDir);
    assert.deepEqual(repo.files, ['B.txt', 'a/x', 'a/y', 'a.txt', 'b.txt', 'c.txt', 'z/1', 'z/2']);
    assert.equal(repo.has('a/x'), true);
    assert.equal(repo.has('a'), false);
  });

  it('does not misorder two names sharing a prefix', () => {
    const readDir: ReadDir = () => [dirent('ab', false), dirent('a', false), dirent('abc', false), dirent('aa', false)];
    assert.deepEqual(openRepo('/r', undefined, readDir).files, ['a', 'aa', 'ab', 'abc']);
  });
});
