import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { BEGIN, END, ensureExclude, ensureImport, main, pathProblem, upsertBlock, writeAtomic } from '../../plugins/h7/scripts/setup-files.ts';
import { cleanupTmp, runNode, SLOW, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const block = (body: string, nl = '\n'): string => [BEGIN, body, END].join(nl);

describe('upsertBlock', () => {
  it('creates a file when none exists', () => {
    assert.deepEqual(upsertBlock(null, 'x\n'), { status: 'created', text: `${block('x')}\n` });
  });
  it('appends after existing content with a blank line, adding the newline if missing', () => {
    assert.equal(upsertBlock('# Mine\nrule', 'x').text, `# Mine\nrule\n\n${block('x')}\n`);
    assert.equal(upsertBlock('# Mine\n', 'x').text, `# Mine\n\n${block('x')}\n`);
    assert.equal(upsertBlock('', 'x').text, `${block('x')}\n`);
    assert.equal(upsertBlock('a\r\n', 'x').text, `a\r\n\r\n${block('x', '\r\n')}\r\n`);
    assert.equal(upsertBlock('a', 'x').status, 'appended');
  });
  it('is idempotent and tolerant of whitespace and CRLF', () => {
    const once = upsertBlock('# Mine\n', 'one\ntwo').text;
    assert.deepEqual(upsertBlock(once, 'one\ntwo'), { status: 'unchanged', text: once });
    assert.equal(upsertBlock(once, '\none\r\ntwo\n\n').status, 'unchanged');
  });
  it('reports a differing block without touching it, replaces on request', () => {
    const doc = `before\n${block('old')}\nafter\n`;
    const plan = upsertBlock(doc, 'new');
    assert.deepEqual(plan, { status: 'differs', text: doc, existing: 'old' });
    const done = upsertBlock(doc, 'new', true);
    assert.deepEqual(done, { status: 'updated', text: `before\n${block('new')}\nafter\n` });
    assert.equal(upsertBlock(`a\r\n${block('old', '\r\n')}\r\nz`, 'new', true).text, `a\r\n${block('new', '\r\n')}\r\nz`);
  });
  it('a lone begin marker is treated as no block', () => {
    assert.equal(upsertBlock(`${BEGIN}\nx\n`, 'y').status, 'appended');
    assert.equal(upsertBlock(`${END} ${BEGIN}\n`, 'y').status, 'appended');
  });
  it('refuses to grow a file past 150 lines', () => {
    const big = `${'l\n'.repeat(148)}`;
    assert.equal(upsertBlock(big, 'x').status, 'oversize');
    assert.equal(upsertBlock(big, 'x').text, big);
    assert.equal(upsertBlock('l\n'.repeat(140), 'x').status, 'appended');
    const longer = `${block(Array(160).fill('l').join('\n'))}\n`;
    assert.equal(upsertBlock(longer, 'short', true).status, 'updated');
    const existing = `${block('a')}\n${'l\n'.repeat(146)}`;
    assert.equal(upsertBlock(existing, Array(10).fill('m').join('\n'), true).status, 'oversize');
    const exact = `${'l\n'.repeat(146)}`;
    assert.equal(upsertBlock(exact, 'x').status, 'appended');
    assert.equal(upsertBlock(exact, 'x').text.split('\n').length - 1, 150);
  });
  it('property: content outside the markers survives, and a second run changes nothing', () => {
    const line = fc.stringMatching(/^[a-zA-Z0-9 #.-]{0,20}$/);
    fc.assert(
      fc.property(fc.array(line, { maxLength: 10 }), fc.array(line, { maxLength: 10 }), fc.array(line, { minLength: 1, maxLength: 5 }), (before, after, body) => {
        const text = body.join('\n');
        const doc = [...before, block('old'), ...after].join('\n');
        const r = upsertBlock(doc, text, true);
        if (r.status === 'oversize') return true;
        const start = r.text.indexOf(BEGIN);
        const end = r.text.indexOf(END) + END.length;
        const outside = r.text.slice(0, start) + r.text.slice(end);
        const again = upsertBlock(r.text, text, true);
        return outside === doc.slice(0, doc.indexOf(BEGIN)) + doc.slice(doc.indexOf(END) + END.length) && again.status === 'unchanged';
      }),
    );
  });
});

describe('pathProblem', () => {
  it('refuses symlinks via lstat and passes regular files and missing paths', () => {
    const root = tmpDir();
    assert.match(pathProblem('AGENTS.md', root, () => ({ isSymbolicLink: () => true })) as string, /symlink/);
    assert.equal(pathProblem('AGENTS.md', root, () => ({ isSymbolicLink: () => false })), null);
    assert.equal(pathProblem('AGENTS.md', root, () => null), null);
    assert.equal(pathProblem('a/b/c', root), null);
    assert.match(pathProblem('..', root) as string, /outside/);
  });
});

describe('writeAtomic', () => {
  it('writes through a random exclusive temp file and leaves none behind', () => {
    const root = tmpDir();
    writeAtomic(join(root, 'sub', 'f'), 'hi', root);
    assert.equal(readFileSync(join(root, 'sub', 'f'), 'utf8'), 'hi');
    assert.deepEqual(readdirSync(join(root, 'sub')), ['f']);
    writeAtomic(join(root, 'sub', 'f'), 'again', root);
    assert.equal(readFileSync(join(root, 'sub', 'f'), 'utf8'), 'again');
  });
  it('refuses when the temp path already exists (file or planted junction) and writes nothing', () => {
    const root = tmpDir();
    const other = tmpDir();
    writeFileSync(join(root, 'f.fixed.h7tmp'), 'planted');
    assert.throws(() => writeAtomic(join(root, 'f'), 'x', root, () => 'fixed'), /EEXIST/);
    assert.equal(readFileSync(join(root, 'f.fixed.h7tmp'), 'utf8'), 'planted');
    symlinkSync(other, join(root, 'g.fixed.h7tmp'), 'junction');
    assert.throws(() => writeAtomic(join(root, 'g'), 'x', root, () => 'fixed'), /EEXIST/);
    assert.deepEqual(readdirSync(other), []);
    assert.equal(existsSync(join(root, 'f')), false);
  });
  it('re-checks containment before the rename and removes the temp file', () => {
    const root = tmpDir();
    let calls = 0;
    const lstat = () => ({ isSymbolicLink: () => ++calls > 0 });
    assert.throws(() => writeAtomic(join(root, 'f'), 'x', root, () => 'u', lstat), /symlink/);
    assert.deepEqual(readdirSync(root), []);
  });
  it('main reports a write failure instead of throwing', () => {
    const cwd = tmpDir();
    mkdirSync(join(cwd, 'e'));
    let err = '';
    assert.equal(main(['exclude', 'e', '--write'], () => {}, (t) => (err += t), cwd), 2);
    assert.notEqual(err, '');
    assert.deepEqual(readdirSync(cwd), ['e']);
  });
});

describe('ensureImport and ensureExclude', () => {
  it('claude: creates, appends, keeps content, is idempotent', () => {
    assert.deepEqual(ensureImport(null), { status: 'created', text: '@AGENTS.md\n' });
    assert.equal(ensureImport('# Hi').text, '# Hi\n@AGENTS.md\n');
    assert.equal(ensureImport('# Hi\n').text, '# Hi\n@AGENTS.md\n');
    assert.equal(ensureImport('').text, '@AGENTS.md\n');
    assert.equal(ensureImport('a\r\n').text, 'a\r\n@AGENTS.md\r\n');
    assert.deepEqual(ensureImport('x\n@AGENTS.md  \ny'), { status: 'unchanged', text: 'x\n@AGENTS.md  \ny' });
    assert.equal(ensureImport('see @AGENTS.md here').status, 'appended');
  });
  it('exclude: creates, appends, recognises existing forms', () => {
    assert.deepEqual(ensureExclude(null), { status: 'created', text: '.h7/\n' });
    assert.equal(ensureExclude('# c').text, '# c\n.h7/\n');
    assert.equal(ensureExclude('# c\n').text, '# c\n.h7/\n');
    assert.equal(ensureExclude('').text, '.h7/\n');
    assert.equal(ensureExclude('a\r\n').text, 'a\r\n.h7/\r\n');
    for (const form of ['.h7', '.h7/', '/.h7/', 'x\n.h7/\ny']) assert.equal(ensureExclude(form).status, 'unchanged');
    assert.equal(ensureExclude('.h7x\n').status, 'appended');
  });
});

describe('main', () => {
  let cwd = tmpDir();
  const run = (argv: string[], at: string = cwd) => {
    let out = '';
    let err = '';
    const code = main(argv, (t) => (out += t), (t) => (err += t), at);
    return { code, out, err };
  };
  it('plans without writing, then writes', () => {
    const dir = (cwd = tmpDir());
    writeTree(dir, { 'body.md': 'rules', 'AGENTS.md': '# Mine\n' });
    const file = join(dir, 'AGENTS.md');
    const plan = run(['agents', file, join(dir, 'body.md')]);
    assert.deepEqual(JSON.parse(plan.out), { file, status: 'appended', written: false, lines: 5 });
    assert.equal(readFileSync(file, 'utf8'), '# Mine\n');
    assert.equal(JSON.parse(run(['agents', file, join(dir, 'body.md'), '--write']).out).written, true);
    assert.match(readFileSync(file, 'utf8'), /rules/);
    writeFileSync(join(dir, 'body.md'), 'changed');
    const differs = JSON.parse(run(['agents', file, join(dir, 'body.md'), '--write']).out);
    assert.deepEqual(differs, { file, status: 'differs', written: false, lines: 5, existing: 'rules' });
    assert.equal(JSON.parse(run(['agents', file, join(dir, 'body.md'), '--replace', '--write']).out).status, 'updated');
  });
  it('creates parent dirs for new files; claude and exclude subcommands', () => {
    const dir = (cwd = tmpDir());
    const claude = join(dir, 'CLAUDE.md');
    assert.equal(JSON.parse(run(['claude', claude, '--write']).out).status, 'created');
    assert.equal(readFileSync(claude, 'utf8'), '@AGENTS.md\n');
    const exclude = join(dir, '.git', 'info', 'exclude');
    assert.equal(JSON.parse(run(['exclude', exclude, '--write']).out).written, true);
    assert.ok(existsSync(exclude));
    assert.equal(JSON.parse(run(['exclude', exclude, '--write']).out).status, 'unchanged');
  });
  it('refuses relative paths that escape the repo and leaves no temp files', () => {
    cwd = tmpDir();
    const other = tmpDir();
    const r = run(['exclude', join(other, 'x')]);
    assert.equal(r.code, 2);
    assert.match(r.err, /outside the repo/);
    assert.equal(existsSync(join(other, 'x')), false);
    assert.equal(run(['exclude', '../escape']).code, 2);
    assert.equal(run(['agents', 'AGENTS.md', join(other, 'body.md')]).code, 2);
    run(['exclude', 'e', '--write']);
    assert.deepEqual(readFileSync(join(cwd, 'e'), 'utf8'), '.h7/' + String.fromCharCode(10));
  });
  it('refuses a directory junction that points outside the repo', () => {
    cwd = tmpDir();
    const other = tmpDir();
    symlinkSync(other, join(cwd, 'link'), 'junction');
    const r = run(['exclude', 'link/exclude', '--write']);
    assert.equal(r.code, 2);
    assert.equal(existsSync(join(other, 'exclude')), false);
    mkdirSync(join(cwd, 'sub'));
    assert.equal(run(['exclude', 'sub/new/deep', '--write']).code, 0);
  });
  it('rejects bad usage and unreadable body', () => {
    assert.equal(run([]).code, 2);
    assert.equal(run(['agents', 'x']).code, 2);
    assert.equal(run(['nope', 'x']).code, 2);
    assert.match(run(['agents', 'x']).err, /usage/);
    cwd = tmpDir();
    const r = run(['agents', join(cwd, 'a.md'), join(cwd, 'missing.md')]);
    assert.equal(r.code, 2);
    assert.match(r.err, /cannot read/);
  });
  it('runs as a script', { ...SLOW }, () => {
    const dir = tmpDir();
    const script = join(import.meta.dirname, '../../plugins/h7/scripts/setup-files.ts');
    const ok = runNode(script, ['exclude', 'e'], { cwd: dir });
    assert.equal(ok.status, 0);
    assert.equal(JSON.parse(ok.stdout).status, 'created');
    const bad = runNode(script, [], { cwd: dir });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /usage/);
  });
});
