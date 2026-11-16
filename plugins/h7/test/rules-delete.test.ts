import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { isDeleter } from '../scripts/rules-delete.ts';
import { decide, ruleOf, type Options } from './support.ts';

const BLOCK = 'block:recursive-delete';
const ASK = 'ask:recursive-delete-unresolved';
const BROAD = 'ask:recursive-delete-broad';

function table(options: Options, rows: [string, string | null][]): void {
  for (const [command, expected] of rows) {
    assert.equal(ruleOf(command, options), expected, command);
  }
}

describe('recursive force delete on posix', () => {
  it('allows deletes inside the repository', () => {
    table({}, [
      ['rm -rf node_modules', null],
      ['rm -rf node_modules dist coverage', null],
      ['rm -rf ./dist', null],
      ['rm -rf /repo/dist', null],
      ['rm -rf a/b/../c', null],
      ['rm -fr build', null],
      ['rm -r -f build', null],
      ['rm --recursive --force build', null],
      ['rm -Rf build', null],
      ['rm -rfv build', null],
      ['rm -rf dist/*', null],
      ['rm -rf src/**/*.tmp', null],
      ['rm -rf *.log', null],
      ['rm -rf -- dist', null],
    ]);
  });

  it('blocks targets outside the repository', () => {
    table({}, [
      ['rm -rf /tmp/x', BLOCK],
      ['rm -rf ../other', BLOCK],
      ['rm -rf /repo/..', BLOCK],
      ['rm -rf /repo2', BLOCK],
      ['rm -rf dist /etc', BLOCK],
      ['rm -rf /home/me/project', BLOCK],
      ['rm -fr ../', BLOCK],
      ['rm -r -f /var', BLOCK],
      ['rm --recursive --force /var', BLOCK],
      ['rm -rf -- /var', BLOCK],
    ]);
  });

  it('blocks the repo root, home, filesystem root and their globs', () => {
    table({}, [
      ['rm -rf .', BLOCK],
      ['rm -rf ./', BLOCK],
      ['rm -rf /repo', BLOCK],
      ['rm -rf /repo/', BLOCK],
      ['rm -rf ~', BLOCK],
      ['rm -rf ~/', BLOCK],
      ['rm -rf $HOME', ASK],
      ['rm -rf "${HOME}"', ASK],
      ['rm -rf /', BLOCK],
      ['rm -rf //', BLOCK],
      ['rm -rf /*', BLOCK],
      ['rm -rf ~/*', BLOCK],
      ['rm -rf $HOME/*', ASK],
      ['rm -rf ~/.config/*', BLOCK],
      ['rm -rf *', BROAD],
      ['rm -rf ./*', BROAD],
      ['rm -rf .*', BROAD],
      ['rm -rf **', BROAD],
      ['rm -rf *.*', BROAD],
      ['rm -rf /etc/*', BLOCK],
      ['rm -rf ../*', BLOCK],
      ['rm -rf /repo/*', BROAD],
      ['rm -rf ?', null],
      ['rm -rf [ab]', null],
      ['rm -rf /tmp/a?b', BLOCK],
    ]);
  });

  it('describes why a target was refused', () => {
    assert.match(decide('rm -rf /')?.reason ?? '', /the filesystem root/);
    assert.match(decide('rm -rf ~')?.reason ?? '', /the home directory/);
    assert.match(decide('rm -rf .')?.reason ?? '', /the repository root/);
    assert.match(decide('rm -rf /tmp')?.reason ?? '', /outside the repository/);
    assert.match(decide('rm -rf *')?.reason ?? '', /everything in the repository root/);
    assert.match(decide('rm -rf ~/*')?.reason ?? '', /glob is in the home directory/);
    assert.match(decide('rm -rf /*')?.reason ?? '', /glob is in the filesystem root/);
    assert.match(decide('rm -rf /tmp/*')?.reason ?? '', /glob is in a path outside the repository/);
    assert.match(decide('rm -rf /tmp')?.reason ?? '', /rm -rf node_modules dist/);
  });

  it('asks for unresolvable variable targets instead of guessing', () => {
    table({}, [
      ['rm -rf $DIR', ASK],
      ['rm -rf "$DIR/"', ASK],
      ['rm -rf $(mktemp -d)', ASK],
      ['rm -rf `mktemp -d`', ASK],
      ['rm -rf ~other', ASK],
    ]);
  });

  it('treats rm -r as a recursive delete, but plain rm and rm -f as safe', () => {
    table({}, [
      ['rm -r /tmp/x', BLOCK],
      ['rm -f /tmp/x', null],
      ['rm /tmp/x', null],
      ['rm -rf', ASK],
      ['rm -i /tmp/x', null],
      ['rm - /tmp/x', null],
      ['rm --verbose -f /tmp/x', null],
    ]);
  });

  it('follows cd and checks every target', () => {
    table({}, [
      ['cd /tmp && rm -rf x', BLOCK],
      ['cd /repo/sub && rm -rf x', null],
      ['cd /repo/sub && rm -rf ../..', BLOCK],
      ['cd /repo/sub && rm -rf .', null],
      ['cd .. && rm -rf repo', BLOCK],
      ['cd /repo && rm -rf .', BLOCK],
      ['cd ~ && rm -rf *', BLOCK],
      ['cd && rm -rf *', BLOCK],
      ['cd - && rm -rf dist', null],
      ['cd $UNKNOWN && rm -rf dist', null],
      ['cd -P /tmp && rm -rf x', BLOCK],
      ['cd /tmp; rm -rf x', BLOCK],
      ['pushd /tmp && rm -rf x', BLOCK],
      ['cd "" && rm -rf dist', null],
    ]);
  });

  it('sees through wrappers, subshells and nested shells', () => {
    table({}, [
      ['sudo rm -rf /', BLOCK],
      ['bash -c "rm -rf /"', BLOCK],
      ['sh -c \'cd /tmp && rm -rf x\'', BLOCK],
      ['bash -lc "bash -c \\"rm -rf /\\""', BLOCK],
      ['echo $(rm -rf /)', BLOCK],
      ['echo `rm -rf /`', BLOCK],
      ['(rm -rf /)', BLOCK],
      ['ls && (cd / && rm -rf *)', BLOCK],
      ['for d in a b; do rm -rf /; done', BLOCK],
      ['if true; then rm -rf /; fi', BLOCK],
      ['eval "rm -rf /"', BLOCK],
      ['true || rm -rf /', BLOCK],
      ['cat x | rm -rf /', BLOCK],
      ['rm -rf / 2>&1', BLOCK],
      ['rm -rf /\nls', BLOCK],
      
      ['pwsh -Command "Remove-Item -Recurse -Force /"', BLOCK],
    ]);
  });

  it('does not scan quoted data or heredoc bodies', () => {
    table({}, [
      ['echo "rm -rf /"', null],
      ["echo 'rm -rf /' > notes.txt", null],
      ["git commit -m \"$(cat <<'EOF'\nfix: do not rm -rf /\nEOF\n)\"", null],
      ["cat <<'EOF'\nrm -rf /\nEOF", null],
      ['grep -r "rm -rf" .', null],
    ]);
  });

  it('treats a missing repository as the current directory boundary', () => {
    table({ root: null }, [
      ['rm -rf dist', null],
      ['rm -rf .', BLOCK],
      ['rm -rf ../x', BLOCK],
      ['rm -rf /repo/dist', null],
    ]);
  });

  it('property: rm -rf of paths under the repo is allowed, and escaping with .. is blocked', () => {
    const name = fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/);
    fc.assert(
      fc.property(fc.array(name, { minLength: 1, maxLength: 4 }), (parts) => {
        assert.equal(ruleOf(`rm -rf ${parts.join('/')}`), null);
        assert.equal(ruleOf(`rm -rf ../${parts.join('/')}`), BLOCK);
        assert.equal(ruleOf(`rm -rf /elsewhere/${parts.join('/')}`), BLOCK);
      }),
    );
  });
});

describe('recursive force delete on Windows', () => {
  const win: Options = { platform: 'win32' };

  it('allows deletes inside the repository', () => {
    table(win, [
      ['rd /s /q build', null],
      ['rmdir /s /q build\\out', null],
      ['rd /s /q C:\\work\\repo\\build', null],
      ['rd /s /q /c/work/repo/build', null],
      ['rm -rf node_modules', null],
      ['del /s /q build\\*.tmp', null],
      ['del /q file.txt', null],
      ['rd build', null],
      ['rmdir build', null],
    ]);
  });

  it('blocks outside the repository, home and drive roots (case-insensitive)', () => {
    table(win, [
      ['rd /s /q C:\\', BLOCK],
      ['rd /s /q C:\\Users\\me', BLOCK],
      ['rd /s /q c:\\users\\ME\\', BLOCK],
      ['rmdir /s C:\\Windows', BLOCK],
      ['rmdir /S /Q D:\\data', BLOCK],
      ['rd /s /q %USERPROFILE%', ASK],
      ['rd /s /q ..\\other', BLOCK],
      ['rd /s /q C:\\work\\repo', BLOCK],
      ['rd /s /q C:\\work\\REPO\\', BLOCK],
      ['rm -rf /c/Users/me', BLOCK],
      ['rm -rf /', BLOCK],
      ['rm -rf ~', BLOCK],
      ['rm -rf C:\\*', BLOCK],
      ['del /f /s /q C:\\Users\\me\\*', BLOCK],
      ['erase /s /q C:\\Windows', BLOCK],
      ['rd /s /q %UNKNOWN%\\x', ASK],
      ['cmd /c rd /s /q C:\\', BLOCK],
      ['cmd.exe /c "rd /s /q C:\\Users\\me"', BLOCK],
      ['rm -rf C:\\work\\repo\\*.log', null],
    ]);
  });
});

describe('PowerShell Remove-Item', () => {
  const ps: Options = { platform: 'win32', dialect: 'ps' };

  it('blocks -Recurse -Force outside the repository in any spelling', () => {
    table(ps, [
      ['Remove-Item -Recurse -Force C:\\Users\\me', BLOCK],
      ['Remove-Item -Force -Recurse C:\\Windows', BLOCK],
      ['Remove-Item C:\\Windows -Recurse -Force', BLOCK],
      ['remove-item -recurse -force c:\\temp\\x', BLOCK],
      ['ri -r -fo C:\\x', BLOCK],
      ['rm -Recurse -Force C:\\x', BLOCK],
      ['rm -r -Force C:\\x', BLOCK],
      ['del -Recurse -Force C:\\x', BLOCK],
      ['Remove-Item -Path C:\\x -Recurse -Force', BLOCK],
      ['Remove-Item -LiteralPath C:\\x -Recurse -Force', BLOCK],
      ['Remove-Item -pa C:\\x -Recurse -Force', BLOCK],
      ['Remove-Item -Path:C:\\x -Recurse -Force', BLOCK],
      ['Remove-Item -Recurse -Force -Path C:\\x, ..\\y', BLOCK],
      ['Remove-Item -Recurse -Force $env:USERPROFILE', ASK],
      ['Remove-Item -Recurse -Force ~', BLOCK],
      ['Remove-Item -Recurse -Force C:\\Users\\me\\*', BLOCK],
      ['rd -Recurse -Force C:\\x', BLOCK],
      ['Remove-Item -Recurse -Force $x', ASK],
      ['Remove-Item -Recurse -Force $(Get-Location)', ASK],
    ]);
  });

  it('allows deletes inside the repository and non-recursive deletes', () => {
    table(ps, [
      ['Remove-Item -Recurse -Force node_modules', null],
      ['Remove-Item -Recurse -Force .\\dist', null],
      ['Remove-Item -Recurse -Force -Path .\\dist', null],
      ['Remove-Item -Recurse -Force -Include *.log .\\logs', null],
      ['Remove-Item -Recurse -Force -Exclude keep .\\logs', null],
      ['Remove-Item -Recurse -Force -Filter *.tmp -Path .\\tmp', null],
      ['Remove-Item -Recurse -Force -Include:*.log .\\logs', null],
      ['Remove-Item -Recurse C:\\x', null],
      ['Remove-Item -Force C:\\x', null],
      ['Remove-Item C:\\x', null],
      ['Remove-Item -Path', null],
      ['Remove-Item -Path:', null],
      ['Remove-Item -:x -Recurse -Force', ASK],
    ]);
  });

  it('is found through call operators, pipelines, script blocks and pwsh -Command', () => {
    table(ps, [
      ['& Remove-Item -Recurse -Force C:\\x', BLOCK],
      ['Get-ChildItem C:\\x | ForEach-Object { Remove-Item -Recurse -Force C:\\x }', BLOCK],
      ['if ($true) { Remove-Item -Recurse -Force C:\\x }', BLOCK],
      ['Write-Host "Remove-Item -Recurse -Force C:\\x"', null],
    ]);
    assert.equal(ruleOf('pwsh -NoProfile -Command "Remove-Item -Recurse -Force C:\\x"', { platform: 'win32' }), BLOCK);
    assert.equal(ruleOf('powershell -Command Remove-Item -Recurse -Force C:\\x', { platform: 'win32' }), BLOCK);
    const encoded = Buffer.from('Remove-Item -Recurse -Force C:\\x', 'utf16le').toString('base64');
    assert.equal(ruleOf(`powershell -EncodedCommand ${encoded}`, { platform: 'win32' }), BLOCK);
  });
});

describe('isDeleter', () => {
  it('recognises deleter commands only', () => {
    for (const name of ['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']) assert.ok(isDeleter(name), name);
    for (const name of ['ls', 'git', 'rmx']) assert.ok(!isDeleter(name), name);
  });
});
