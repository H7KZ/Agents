import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { cleanupTmp, tmpDir, writeTree } from '../../scripts/test/helpers.ts';
import { findExternalReviewers, loadModels, main, modelsFile, parseModels, pickReviewer, realRead, type Env } from '../../plugins/h7/scripts/models.ts';

cleanupTmp();

const script = join(import.meta.dirname, '../../plugins/h7/scripts/models.ts');

function env(files: Record<string, string> = {}, onPath: string[] = [], platform = 'linux', pathVar = '/a:/b'): Env {
  return { home: '/home/me', platform, pathVar, read: (file) => files[file] ?? null, exists: (file) => onPath.includes(file) };
}

describe('parseModels', () => {
  it('keeps known roles with trimmed non-blank strings', () => {
    assert.deepEqual(parseModels('{"author":" opus ","reviewer":"sonnet","verifier":"","cheap":3,"extra":"x"}'), { author: 'opus', reviewer: 'sonnet' });
  });

  it('is null for anything that is not an object', () => {
    for (const text of ['', '{', 'null', '[]', '"x"', '3']) assert.equal(parseModels(text), null, text);
  });

  it('never throws on any text', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const models = parseModels(text);
        assert.ok(models === null || typeof models === 'object');
      }),
    );
  });
});

describe('loadModels', () => {
  it('reads home/.h7/models.json and reports missing and corrupt files without throwing', () => {
    const file = modelsFile('/home/me');
    assert.ok(file.replaceAll('\\', '/').endsWith('/home/me/.h7/models.json'));
    assert.deepEqual(loadModels('/home/me', () => null), { file, status: 'missing', models: {} });
    assert.deepEqual(loadModels('/home/me', () => '{nope'), { file, status: 'corrupt', models: {} });
    assert.deepEqual(loadModels('/home/me', () => '{"reviewer":"sonnet"}'), { file, status: 'ok', models: { reviewer: 'sonnet' } });
  });

  it('realRead returns null for a missing file and the text for a present one', () => {
    const dir = tmpDir();
    writeTree(dir, { 'a.json': '{}' });
    assert.equal(realRead(join(dir, 'a.json')), '{}');
    assert.equal(realRead(join(dir, 'nope.json')), null);
  });
});

describe('pickReviewer', () => {
  it('uses the reviewer when it differs from the author, ignoring case and spaces', () => {
    assert.equal(pickReviewer({ reviewer: 'sonnet', author: 'opus' }).model, 'sonnet');
    assert.deepEqual(pickReviewer({ reviewer: 'sonnet' }, 'opus'), { model: 'sonnet', status: 'ok', author: 'opus', note: 'reviewer model differs from the author model' });
  });

  it('refuses a reviewer equal to the author', () => {
    const r = pickReviewer({ reviewer: 'Opus', author: 'sonnet' }, ' opus ');
    assert.equal(r.model, null);
    assert.equal(r.status, 'same-as-author');
    assert.equal(r.author, 'opus');
    assert.equal(pickReviewer({ reviewer: 'opus', author: 'OPUS' }).status, 'same-as-author');
  });

  it('prefers the explicit author over the configured one and ignores a blank one', () => {
    assert.equal(pickReviewer({ reviewer: 'opus', author: 'opus' }, 'sonnet').status, 'ok');
    assert.equal(pickReviewer({ reviewer: 'opus', author: 'opus' }, '  ').status, 'same-as-author');
  });

  it('reports unconfigured when there is no reviewer, and an unknown author as null', () => {
    const r = pickReviewer({});
    assert.deepEqual([r.model, r.status, r.author], [null, 'unconfigured', null]);
    assert.equal(pickReviewer({ reviewer: 'sonnet' }).author, null);
  });

  it('property: the chosen model never equals the author', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (reviewer, author) => {
        const r = pickReviewer({ reviewer: reviewer.trim() === '' ? 'x' : reviewer }, author);
        if (r.model !== null) assert.notEqual(r.model.trim().toLowerCase(), author.trim().toLowerCase());
      }),
    );
  });
});

describe('findExternalReviewers', () => {
  it('finds bare names on posix PATH in order', () => {
    const found = findExternalReviewers('linux', '/x::/a:/b', (f) => ['/b/codex', '/a/codex', '/b/gemini'].includes(f));
    assert.deepEqual(found, [
      { name: 'codex', path: '/a/codex' },
      { name: 'gemini', path: '/b/gemini' },
    ]);
  });

  it('tries Windows extensions and the Windows delimiter', () => {
    const exe = path.win32.join('C:\\bin', 'gemini.cmd');
    assert.deepEqual(findExternalReviewers('win32', ';C:\\bin;D:\\tools', (f) => f === exe), [{ name: 'gemini', path: exe }]);
    assert.deepEqual(findExternalReviewers('win32', 'C:\\bin', (f) => f.endsWith('codex')), []);
  });

  it('finds nothing on an empty PATH', () => {
    assert.deepEqual(findExternalReviewers('linux', '', () => true), []);
  });
});

describe('main', () => {
  const run = (argv: string[], e: Env): { code: number; out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, (t) => out.push(t), (t) => err.push(t), e);
    return { code, out, err };
  };

  it('show prints the loaded models', () => {
    const file = modelsFile('/home/me');
    const r = run(['show'], env({ [file]: '{"author":"opus"}' }));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out[0] as string), { file, status: 'ok', models: { author: 'opus' } });
  });

  it('reviewer picks a model, with and without --author, and survives a corrupt file', () => {
    const file = modelsFile('/home/me');
    const files = { [file]: '{"reviewer":"sonnet","author":"opus"}' };
    assert.equal(JSON.parse(run(['reviewer'], env(files)).out[0] as string).model, 'sonnet');
    assert.equal(JSON.parse(run(['reviewer', '--author', 'sonnet'], env(files)).out[0] as string).status, 'same-as-author');
    const bad = JSON.parse(run(['reviewer'], env({ [file]: '{' })).out[0] as string);
    assert.deepEqual([bad.model, bad.status, bad.config], [null, 'unconfigured', 'corrupt']);
    assert.equal(JSON.parse(run(['reviewer'], env()).out[0] as string).config, 'missing');
  });

  it('cli lists the external reviewers on PATH', () => {
    const r = run(['cli'], env({}, ['/a/codex']));
    assert.deepEqual(JSON.parse(r.out[0] as string), { reviewers: [{ name: 'codex', path: '/a/codex' }] });
  });

  it('rejects unknown or malformed usage with code 2', () => {
    for (const argv of [[], ['nope'], ['show', 'x'], ['cli', 'x'], ['reviewer', 'x'], ['reviewer', '--author'], ['reviewer', '--author', '-x'], ['reviewer', '--author', 'a', 'b'], ['reviewer', '--model', 'a']]) {
      const r = run(argv, env());
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err[0] as string, /usage: models\.ts/);
    }
  });
});

describe('models.ts as a script', () => {
  const spawn = (argv: string[], vars: Record<string, string>) =>
    spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', env: { ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }), ...vars } });

  it('reads models.json under H7_HOME and never writes there', () => {
    const home = tmpDir();
    writeTree(home, { '.h7/models.json': '{"reviewer":"sonnet"}' });
    const r = spawn(['reviewer', '--author', 'opus'], { H7_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).model, 'sonnet');
    const empty = tmpDir();
    assert.equal(JSON.parse(spawn(['reviewer'], { H7_HOME: empty }).stdout).config, 'missing');
    assert.ok(!existsSync(join(empty, '.h7')));
  });

  it('falls back to the home directory when H7_HOME is unset', () => {
    const home = tmpDir();
    writeTree(home, { '.h7/models.json': '{"reviewer":"haiku"}' });
    assert.equal(JSON.parse(spawn(['reviewer'], { HOME: home, USERPROFILE: home }).stdout).model, 'haiku');
  });

  it('prints usage and exits 2 on bad arguments', () => {
    const r = spawn(['nope'], { H7_HOME: tmpDir() });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: models.ts/);
  });

  it('detects codex on PATH, skipping directories', () => {
    const bin = tmpDir();
    for (const name of ['codex', 'codex.exe']) {
      writeFileSync(join(bin, name), '');
      chmodSync(join(bin, name), 0o755);
    }
    mkdirSync(join(bin, 'gemini'));
    const home = tmpDir();
    const found = JSON.parse(spawn(['cli'], { H7_HOME: home, PATH: bin }).stdout) as { reviewers: Array<{ name: string }> };
    assert.deepEqual(found.reviewers.map((r) => r.name), ['codex']);
  });
});
