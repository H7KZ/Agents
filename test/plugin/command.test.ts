import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { assignmentsOf, commandName, nestedScript, parseArgs, parseSimple } from '../../plugins/h7/scripts/command.ts';

const simple = (...words: string[]) => {
  const { raw: _raw, ...rest } = parseSimple(words);
  return rest;
};

describe('commandName', () => {
  it('strips directories and executable extensions and lowercases', () => {
    assert.equal(commandName('/usr/bin/git'), 'git');
    assert.equal(commandName('C:\\Program Files\\Git\\cmd\\GIT.EXE'), 'git');
    assert.equal(commandName('Remove-Item'), 'remove-item');
    assert.equal(commandName('npm.cmd'), 'npm');
    assert.equal(commandName('run.ps1'), 'run');
    assert.equal(commandName('a.sh'), 'a.sh');
  });
});

describe('parseSimple', () => {
  it('returns an empty command for no words and for assignments only', () => {
    assert.deepEqual(simple(), { name: '', argv: [], env: {} });
    assert.deepEqual(simple('A=1', 'B='), { name: '', argv: [], env: { A: '1', B: '' } });
  });

  it('collects env prefixes and the command', () => {
    assert.deepEqual(simple('HUSKY=0', 'git', 'commit'), { name: 'git', argv: ['commit'], env: { HUSKY: '0' } });
    assert.deepEqual(simple('$env:HUSKY=0', 'git'), { name: 'git', argv: [], env: { HUSKY: '0' } });
    assert.deepEqual(simple('$env:SKIP', '=', 'lint', 'git', 'x'), { name: 'git', argv: ['x'], env: { SKIP: 'lint' } });
    assert.deepEqual(simple('$env:SKIP', '='), { name: '', argv: [], env: { SKIP: '' } });
    assert.deepEqual(simple('$env:SKIP', 'git'), { name: '$env:skip', argv: ['git'], env: {} });
  });

  it('keeps the command word as written, even through wrappers', () => {
    assert.equal(parseSimple(['sudo', '$G', 'push']).raw, '$G');
    assert.equal(parseSimple(['/usr/bin/GIT.exe', 'x']).raw, '/usr/bin/GIT.exe');
    assert.equal(parseSimple(['A=1']).raw, '');
  });

  it('skips shell keywords', () => {
    assert.deepEqual(simple('then', 'rm', '-rf', 'x'), { name: 'rm', argv: ['-rf', 'x'], env: {} });
    assert.deepEqual(simple('!', '{', 'do', 'ls'), { name: 'ls', argv: [], env: {} });
  });

  it('unwraps wrappers and their flags', () => {
    assert.equal(simple('sudo', '-u', 'root', '-E', 'git', 'push').name, 'git');
    assert.equal(simple('sudo', '--', 'git').name, 'git');
    assert.equal(simple('doas', 'git').name, 'git');
    assert.equal(simple('command', 'git').name, 'git');
    assert.equal(simple('nohup', 'nice', '-n', '5', 'git', 'x').name, 'git');
    assert.equal(simple('time', 'git').name, 'git');
    assert.equal(simple('exec', 'git').name, 'git');
    assert.equal(simple('builtin', 'git').name, 'git');
    assert.deepEqual(simple('timeout', '-s', 'KILL', '5', 'git', 'x'), { name: 'git', argv: ['x'], env: {} });
    assert.deepEqual(simple('timeout', '5', 'git'), { name: 'git', argv: [], env: {} });
    assert.equal(simple('sudo').name, '');
    assert.equal(simple('sudo', '-').name, '-');
  });

  it('unwraps env with assignments, flags and values', () => {
    assert.deepEqual(simple('env', '-i', '-u', 'X', 'HUSKY=0', 'git', 'commit'), { name: 'git', argv: ['commit'], env: { HUSKY: '0' } });
    assert.deepEqual(simple('env', '--', 'git'), { name: 'git', argv: [], env: {} });
    assert.deepEqual(simple('/usr/bin/env', 'A=1'), { name: '', argv: [], env: { A: '1' } });
  });

  it('does not treat prototype property names as wrappers', () => {
    assert.equal(simple('constructor', 'x').name, 'constructor');
    assert.equal(simple('toString').name, 'tostring');
  });
});

describe('assignmentsOf', () => {
  it('extracts assignments from arguments', () => {
    assert.deepEqual(assignmentsOf({ name: 'export', argv: ['A=1', '-x', 'B=2=3', 'C'], env: {}, raw: 'export' }), { A: '1', B: '2=3' });
  });
});

describe('nestedScript', () => {
  const nest = (name: string, ...argv: string[]) => nestedScript({ name, argv, env: {}, raw: name });

  it('finds bash -c style scripts in any flag position', () => {
    assert.deepEqual(nest('bash', '-c', 'git push -f'), { script: 'git push -f', dialect: 'sh' });
    assert.deepEqual(nest('sh', '-lc', 'x y'), { script: 'x y', dialect: 'sh' });
    assert.deepEqual(nest('zsh', '--norc', '-ec', 'x'), { script: 'x', dialect: 'sh' });
    assert.equal(nest('bash', '-c'), null);
    assert.equal(nest('bash', 'script.sh'), null);
    assert.equal(nest('bash', '--rcfile', 'x'), null);
  });

  it('finds PowerShell -Command in any abbreviation, joining the remaining arguments', () => {
    assert.deepEqual(nest('pwsh', '-NoProfile', '-Command', 'git', 'push', '-f'), { script: 'git push -f', dialect: 'ps' });
    assert.deepEqual(nest('powershell', '-c', 'x'), { script: 'x', dialect: 'ps' });
    assert.deepEqual(nest('powershell', '-Com', 'x'), { script: 'x', dialect: 'ps' });
    assert.deepEqual(nest('pwsh', '/Command', 'x'), { script: 'x', dialect: 'ps' });
    assert.equal(nest('pwsh', '-File', 'x.ps1'), null);
    assert.equal(nest('pwsh', '-', 'x'), null);
    assert.equal(nest('pwsh', '-ExecutionPolicy', 'Bypass'), null);
    assert.equal(nest('pwsh', 'plain'), null);
  });

  it('decodes -EncodedCommand as UTF-16LE base64', () => {
    const encoded = Buffer.from('git push --force', 'utf16le').toString('base64');
    assert.deepEqual(nest('powershell', '-ec', encoded), { script: 'git push --force', dialect: 'ps' });
    assert.deepEqual(nest('powershell', '-EncodedCommand'), { script: '', dialect: 'ps' });
  });

  it('finds cmd /c and eval', () => {
    assert.deepEqual(nest('cmd', '/c', 'rd', '/s', '/q', 'C:\\'), { script: 'rd /s /q C:\\', dialect: 'sh' });
    assert.deepEqual(nest('cmd', '/K', 'x'), { script: 'x', dialect: 'sh' });
    assert.equal(nest('cmd', '/d'), null);
    assert.deepEqual(nest('eval', 'git', 'push', '-f'), { script: 'git push -f', dialect: 'sh' });
    assert.equal(nest('git', '-c', 'x'), null);
  });
});

describe('parseArgs', () => {
  const spec = { valueShort: 'mo', attachedShort: 'S', valueLong: ['--message'] };

  it('splits flags, option values, positionals and the rest after --', () => {
    const p = parseArgs(['-m', 'msg -n', '--message', 'x', '--author=me', 'pos', '-a', '--', '-n', 'file'], spec);
    assert.deepEqual(p.flags, ['-m', '--message', '--author', '-a']);
    assert.deepEqual([...p.options], [['-m', 'msg -n'], ['--message', 'x'], ['--author', 'me']]);
    assert.deepEqual(p.positionals, ['pos']);
    assert.deepEqual(p.rest, ['-n', 'file']);
  });

  it('expands short clusters and stops at value or attached options', () => {
    assert.deepEqual(parseArgs(['-anm', 'text'], spec).flags, ['-a', '-n', '-m']);
    assert.deepEqual(parseArgs(['-amtext', '-n'], spec).options.get('-m'), 'text');
    assert.deepEqual(parseArgs(['-amtext', '-n'], spec).flags, ['-a', '-m', '-n']);
    assert.deepEqual(parseArgs(['-SKEY', '-n'], spec).options.get('-S'), 'KEY');
    assert.deepEqual(parseArgs(['-m'], spec).options.get('-m'), '');
    assert.deepEqual(parseArgs(['--message'], spec).options.get('--message'), '');
  });

  it('treats a lone dash as positional and works without a spec', () => {
    const p = parseArgs(['-', 'x', '-vq']);
    assert.deepEqual(p.positionals, ['-', 'x']);
    assert.deepEqual(p.flags, ['-v', '-q']);
  });

  it('never throws and positionals never start with a dash unless after --', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 8 }), { maxLength: 8 }), (args) => {
        const p = parseArgs(args, spec);
        assert.ok(p.positionals.every((a) => a === '-' || !a.startsWith('-')));
      }),
    );
  });
});
