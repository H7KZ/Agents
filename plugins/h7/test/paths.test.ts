import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { makePaths } from '../scripts/paths.ts';

const posix = makePaths('posix', (p) => p);
const win = makePaths('win32', (p) => p);

describe('paths.resolve', () => {
  it('resolves relative and absolute paths per platform', () => {
    assert.equal(posix.resolve('/repo/sub', '../x'), '/repo/x');
    assert.equal(posix.resolve('/repo', '/etc'), '/etc');
    assert.equal(win.resolve('C:\\repo', 'sub\\x'), 'C:\\repo\\sub\\x');
    assert.equal(win.resolve('C:\\repo', 'D:\\other'), 'D:\\other');
  });

  it('maps git-bash style drive paths on Windows only', () => {
    assert.equal(win.resolve('C:\\repo', '/c/Users/me'), 'c:\\Users\\me');
    assert.equal(win.resolve('C:\\repo', '/d'), 'd:\\');
    assert.equal(win.resolve('/c/work', 'x'), 'c:\\work\\x');
    assert.equal(win.resolve('C:\\repo', '/'), 'C:\\');
    assert.equal(posix.resolve('/repo', '/c/Users'), '/c/Users');
  });

  it('canonicalises through the deepest existing ancestor', () => {
    const real = makePaths('posix', (p) => {
      if (p === '/link') return '/real';
      if (p === '/link/new') throw new Error('ENOENT');
      if (p === '/link/new/deep') throw new Error('ENOENT');
      throw new Error('ENOENT');
    });
    assert.equal(real.resolve('/', 'link'), '/real');
    assert.equal(real.resolve('/', 'link/new/deep'), '/real/new/deep');
    assert.equal(real.resolve('/', 'nowhere/x'), '/nowhere/x');
  });
});

describe('paths.isInside / same / isFsRoot', () => {
  it('detects containment including the root itself', () => {
    assert.ok(posix.isInside('/repo', '/repo'));
    assert.ok(posix.isInside('/repo', '/repo/a/b'));
    assert.ok(!posix.isInside('/repo', '/repo2'));
    assert.ok(!posix.isInside('/repo', '/'));
    assert.ok(!posix.isInside('/repo', '/other'));
    assert.ok(posix.isInside('/repo', '/repo/..x'));
    assert.ok(!posix.isInside('/repo/a', '/repo/b'));
  });

  it('is case-insensitive and drive aware on Windows', () => {
    assert.ok(win.isInside('C:\\Repo', 'c:\\repo\\SRC'));
    assert.ok(!win.isInside('C:\\repo', 'D:\\repo'));
    assert.ok(win.same('C:\\Repo\\', 'c:\\repo'));
    assert.ok(!posix.same('/Repo', '/repo'));
  });

  it('knows filesystem and drive roots', () => {
    assert.ok(posix.isFsRoot('/'));
    assert.ok(!posix.isFsRoot('/usr'));
    assert.ok(win.isFsRoot('C:\\'));
    assert.ok(win.isFsRoot('d:/'));
    assert.ok(!win.isFsRoot('C:\\Users'));
  });
});

describe('paths.expand', () => {
  const home = '/home/me';

  it('expands tilde and home variables', () => {
    assert.equal(posix.expand('~', home), '/home/me');
    assert.equal(posix.expand('~/x', home), '/home/me/x');
    assert.equal(posix.expand('~\\x', home), '/home/me\\x');
    for (const word of ['$HOME/x', '${HOME}/x', '$env:USERPROFILE\\x', '${env:HOME}']) assert.equal(posix.expand(word, home), null, word);
    assert.equal(win.expand('%USERPROFILE%\\x', 'C:\\Users\\me'), null);
  });

  it('returns null for unresolvable variables, substitutions and other users', () => {
    assert.equal(posix.expand('$FOO/x', home), null);
    assert.equal(posix.expand('$HOMEDIR', home), null);
    assert.equal(posix.expand('$(pwd)', home), null);
    assert.equal(posix.expand('`pwd`', home), null);
    assert.equal(posix.expand('~root/x', home), null);
    assert.equal(win.expand('%APPDATA%\\x', 'C:\\Users\\me'), null);
    assert.equal(posix.expand('100%done%', home), '100%done%');
  });

  it('leaves ordinary words alone', () => {
    assert.equal(posix.expand('dist/a b', home), 'dist/a b');
    assert.equal(posix.expand('a~b', home), 'a~b');
    assert.equal(posix.expand('', home), '');
  });

  it('property: words without special characters are returned unchanged', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_./\\ -]{0,30}$/), (word) => {
        assert.equal(posix.expand(word, home), word);
      }),
    );
  });

  it('property: resolved paths are absolute and inside the fs root', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9./]{0,20}$/), (rel) => {
        const resolved = posix.resolve('/repo', rel);
        assert.ok(resolved.startsWith('/'));
        assert.ok(posix.isInside('/', resolved));
      }),
    );
  });
});
