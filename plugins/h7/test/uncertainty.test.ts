import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ruleOf, type Options } from './support.ts';

const DIRTY = 'block:destructive-git-dirty';
const HOOKS = 'block:skip-git-hooks';
const HOOKS_ASK = 'ask:skip-git-hooks';
const INDIRECT = 'ask:indirect-exec';
const RM = 'block:recursive-delete';
const RM_ASK = 'ask:recursive-delete-unresolved';
const DEPLOY = 'ask:deploy-publish';
const FIND = 'ask:find-delete';

function table(options: Options, rows: [string, string | null][]): void {
  for (const [command, expected] of rows) {
    assert.equal(ruleOf(command, options), expected, command);
  }
}

describe('parser uncertainty resolves to ask', () => {
  it('core.hooksPath inside the repository is only accepted for known hook directories', () => {
    table({}, [
      ['git -c core.hooksPath=.husky commit -m x', null],
      ['git -c core.hooksPath=.husky/_ commit -m x', null],
      ['git -c core.hooksPath=./.githooks commit -m x', null],
      ['git config core.hooksPath .git/hooks', null],
      ['git -c core.hooksPath=/repo/.husky commit -m x', null],
      ['git -c core.hooksPath=scripts/hooks commit -m x', HOOKS_ASK],
      ['git -c core.hooksPath=.husky/../evil commit -m x', HOOKS_ASK],
      ['git -c core.hooksPath=. commit -m x', HOOKS_ASK],
      ['git config core.hooksPath tools', HOOKS_ASK],
      ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=custom git commit -m x', HOOKS_ASK],
      ['git -c core.hooksPath=../hooks commit -m x', HOOKS],
      ['git -c core.hooksPath=/dev/null commit -m x', HOOKS],
    ]);
  });

  it('only a bare -WhatIf or -WhatIf:$true is a dry run', () => {
    table({ dialect: 'ps' }, [
      ['Remove-Item -Recurse -Force /etc -WhatIf', null],
      ['Remove-Item -Recurse -Force /etc -WhatIf:$true', null],
      ['Remove-Item -Recurse -Force /etc -whatif:$TRUE', null],
      ['Remove-Item -Recurse -Force /etc -WhatIf:$false', RM],
      ['Remove-Item -Recurse -Force /etc -whatif:$FALSE', RM],
      ['Remove-Item -Recurse -Force /etc -WhatIf:0', RM],
      ['Remove-Item -Recurse -Force /etc -Wh:$false', RM],
    ]);
  });

  it('variables reassigned by the command do not keep their hook-time value', () => {
    const env = { tmpDirs: ['/tmp'], tmpVars: { TMPDIR: '/tmp' } };
    table(env, [
      ['rm -rf $TMPDIR/foo', null],
      ['FOO=1 rm -rf $TMPDIR/foo', null],
      ['TMPDIR=/ rm -rf $TMPDIR/etc', RM_ASK],
      ['export TMPDIR=/; rm -rf "$TMPDIR/etc"', RM_ASK],
      ['declare TMPDIR=/ && rm -rf ${TMPDIR}/etc', RM_ASK],
      ['TMPDIR=/ find $TMPDIR/etc -delete', FIND],
      ['HOME=/ rm -rf $HOME/x', RM_ASK],
      ['export HOME=/x; rm -rf ~/y', RM_ASK],
      ['USERPROFILE=/ rm -rf ~/y', RM_ASK],
      ['HOME=/x git -C ~ status', null],
    ]);
    table({ dialect: 'ps', platform: 'win32', tmpDirs: ['C:\\T'], tmpVars: { TEMP: 'C:\\T' } }, [
      ['Remove-Item -Recurse -Force $env:TEMP\\x', null],
      ["$env:TEMP = 'C:\\'; Remove-Item -Recurse -Force $env:TEMP\\x", RM_ASK],
      ["$env:TEMP='C:\\'; Remove-Item -Recurse -Force $env:TEMP\\x", RM_ASK],
    ]);
  });

  it('partial stashes leave the tree state unknown', () => {
    table({ dirty: true }, [
      ['git stash push -- a.txt && git reset --hard', DIRTY],
      ['git stash -S && git reset --hard', DIRTY],
      ['git stash --staged && git reset --hard', DIRTY],
      ['git stash -p && git reset --hard', DIRTY],
      ['git stash --patch && git reset --hard', DIRTY],
      ['git stash --keep-index && git reset --hard', DIRTY],
      ['git stash --keep && git reset --hard', DIRTY],
      ['git stash push a.txt && git reset --hard', DIRTY],
      ['git stash push --pathspec-from-file=l && git reset --hard', DIRTY],
      ['git stash push -m msg && git reset --hard', null],
      ['git stash save "wip x" && git reset --hard', null],
      ['git stash push --message=m && git reset --hard', null],
    ]);
    table({ dirty: false, untracked: ['n'] }, [['git stash -u -S && git clean -fd', DIRTY]]);
  });

  it('find -exec with shells and wrappers is treated like a delete', () => {
    table({}, [
      ["find . -exec sh -c 'rm {}' ;", FIND],
      ['find . -exec sudo rm {} +', FIND],
      ['find . -exec env rm {} +', FIND],
      ['find . -execdir xargs rm {} +', FIND],
      ['find . -ok busybox rm {} +', FIND],
      ['find . -exec pwsh -c x {} +', FIND],
      ['find /etc -exec bash -c x {} +', RM],
      ['find . -exec echo {} +', null],
      ['find . -exec git status {} +', null],
    ]);
  });

  it('--dry-run only skips when it really is a dry run', () => {
    table({}, [
      ['npm publish --dry-run=false', DEPLOY],
      ['npm publish --dry-run=none', DEPLOY],
      ['cargo publish --dry-run=false', DEPLOY],
      ['kubectl apply -f prod.yaml --dry-run=none', DEPLOY],
      ['npm publish --dry-run=true', null],
      ['npm publish --dry-run=TRUE', null],
      ['kubectl apply -f prod.yaml --dry-run=server', null],
      ['kubectl apply -f prod.yaml --dry-run=client', null],
      ['npm publish --dry-run', null],
    ]);
  });

  it('runner unwrapping uses the real positional index', () => {
    table({}, [
      ['npx -p wrangler wrangler deploy', DEPLOY],
      ['npx --package wrangler wrangler publish', DEPLOY],
      ['npx -y -p x -- wrangler deploy', DEPLOY],
      ['npm --prefix exec exec lerna publish', DEPLOY],
      ['pnpm --filter dlx dlx wrangler deploy', DEPLOY],
      ['npx --package=wrangler wrangler deploy', DEPLOY],
      ['npx -p wrangler', null],
      ['npx --', null],
    ]);
  });

  it('a variable command word asks even before an equals sign in sh', () => {
    table({}, [
      ['$X = 5', INDIRECT],
      ['$X=5', INDIRECT],
    ]);
    table({ dialect: 'ps' }, [
      ['$X = 5', null],
      ['& $X = 5', INDIRECT],
    ]);
  });

  it('xargs optional-value flags never swallow the command, unknown options ask', () => {
    table({}, [
      ['xargs -l rm', INDIRECT],
      ['xargs -l echo', null],
      ['xargs -l5 echo', null],
      ['xargs -i echo {}', null],
      ['xargs -e grep x', null],
      ['xargs -i rm', INDIRECT],
      ['xargs -0r rm', INDIRECT],
      ['xargs -0r echo', null],
      ['xargs -I{} echo {}', null],
      ['xargs -n1 echo', null],
      ['xargs --foo bar rm', INDIRECT],
      ['xargs -Z echo', INDIRECT],
      ['xargs --max-args 1 echo', INDIRECT],
      ['xargs --max-args=1 echo', null],
      ['xargs --null echo', null],
      ['xargs -P 4 -n 1 echo', null],
      ['xargs -a list.txt echo', null],
      ['xargs -I', null],
    ]);
  });

  it('interpreters fed from stdin ask unless the program is certainly an argument', () => {
    table({}, [
      ['echo x | bash -o pipefail', INDIRECT],
      ['echo x | bash -o pipefail script.sh', INDIRECT],
      ['echo x | bash +o history', INDIRECT],
      ['echo x | node -r ts-node/register', INDIRECT],
      ['echo x | python3 -u', INDIRECT],
      ['echo x | bash script.sh', null],
      ['echo x | node app.js', null],
      ['echo x | bash -c "ls"', null],
      ['echo x | python3 -c "1"', null],
      ['echo x | python3 -m json.tool', null],
      ['echo x | node --eval 1', null],
      ['echo x | node -p 1', null],
      ['echo x | pwsh -File x.ps1', null],
      ['echo x | pwsh -Command "1"', null],
      ['echo x | cmd /c dir', null],
    ]);
  });

  it('cd alternatives are only dropped by a top-level cd x || exit', () => {
    table({}, [
      ['cd sub || exit 1; rm -rf ../x', null],
      ['cd sub || (exit 1); rm -rf ../x', RM],
      ['cd sub || true; exit 1; rm -rf ../x', RM],
      ['cd sub || echo no; rm -rf ../x', RM],
      ['cd sub; exit 1; rm -rf ../x', null],
      ['cd sub || { exit 1; }; rm -rf ../x', null],
      ['ls || exit 1; rm -rf dist', null],
    ]);
  });

  it('ambiguous parentheses keep both directories', () => {
    table({}, [
      ['(cd /etc; true); rm -rf dist', null],
      ['(cd /etc; case x in a) true;; esac); rm -rf dist', RM],
      ['(cd /etc; case x in (a) true;; esac); rm -rf dist', RM],
      ['(cd /etc; ls; rm -rf dist', RM],
    ]);
  });
});

describe('batch 4: interpreter flags, variable assigners, dry-run words', () => {
  it('program flags are per interpreter', () => {
    table({}, [
      ['echo x | bash -e', INDIRECT],
      ['echo x | bash -lc ls', null],
      ['echo x | sh -c ls', null],
      ['echo x | zsh -c ls', null],
      ['echo x | python3 -e 1', INDIRECT],
      ['echo x | python3 -c 1', null],
      ['echo x | python -m json.tool', null],
      ['echo x | node -c x', INDIRECT],
      ['echo x | node -e 1', null],
      ['echo x | node --print 1', null],
      ['echo x | perl -w', INDIRECT],
      ['echo x | perl -E say', null],
      ['echo x | perl -e 1', null],
      ['echo x | ruby -e 1', null],
      ['echo x | ruby -c', INDIRECT],
      ['echo x | php -r 1', null],
      ['echo x | php -e', INDIRECT],
      ['echo x | pwsh -nop', INDIRECT],
      ['echo x | pwsh -NoProfile -Command 1', null],
      ['echo x | PWSH -c 1', null],
      ['echo x | powershell -EncodedCommand AAA', null],
      ['echo x | powershell -ec AAA', null],
      ['echo x | powershell -File x.ps1', null],
      ['echo x | powershell -f x.ps1', null],
      ['echo x | powershell /c 1', null],
      ['echo x | cmd /C dir', null],
      ['echo x | cmd /k dir', null],
      ['echo x | cmd /q', INDIRECT],
      ['echo x | deno', INDIRECT],
      ['echo x | deno run x.ts', null],
      ['echo x | bash -o pipefail -c ls', INDIRECT],
    ]);
  });

  it('constructs that can assign variables make every variable in a delete target unresolved', () => {
    const env = { tmpDirs: ['/tmp'], tmpVars: { TMPDIR: '/tmp' } };
    table(env, [
      ['rm -rf $TMPDIR/foo', null],
      ['read TMPDIR; rm -rf $TMPDIR/foo', RM_ASK],
      ['local TMPDIR=/; rm -rf $TMPDIR/foo', RM_ASK],
      ['declare -x TMPDIR=/; rm -rf $TMPDIR/foo', RM_ASK],
      ['printf -v TMPDIR / ; rm -rf $TMPDIR/foo', RM_ASK],
      ['getopts a TMPDIR; rm -rf $TMPDIR/foo', RM_ASK],
      ['eval "TMPDIR=/"; rm -rf $TMPDIR/foo', RM_ASK],
      ['for TMPDIR in /; do rm -rf $TMPDIR/foo; done', RM_ASK],
      ['while read TMPDIR; do rm -rf $TMPDIR/foo; done < list', RM_ASK],
      ['echo ${TMPDIR:=/}; rm -rf $TMPDIR/foo', RM_ASK],
      ['echo ${TMPDIR=/}; rm -rf $TMPDIR/foo', RM_ASK],
      ['read X; rm -rf ~/foo', RM_ASK],
      ['read X; rm -rf dist', null],
      ['read X; rm -rf /tmp/foo', null],
    ]);
    table({ dialect: 'ps', platform: 'win32', tmpDirs: ['C:\\T'], tmpVars: { TEMP: 'C:\\T' } }, [
      ["Set-Item env:TEMP 'C:\\'; Remove-Item -Recurse -Force $env:TEMP\\x", RM_ASK],
      ["New-Item env:TEMP -Value 'C:\\' ; Remove-Item -Recurse -Force $env:TEMP\\x", RM_ASK],
      ["[Environment]::SetEnvironmentVariable('TEMP','C:\\'); Remove-Item -Recurse -Force $env:TEMP\\x", RM_ASK],
      ["Set-Variable T 'C:\\'; Remove-Item -Recurse -Force $T", RM_ASK],
      ["$x = 1; Remove-Item -Recurse -Force $env:TEMP\\x", RM_ASK],
      ['foreach ($d in 1) { Remove-Item -Recurse -Force $env:TEMP\\x }', RM_ASK],
      ['Remove-Item -Recurse -Force $env:TEMP\\x', null],
    ]);
    table({ dialect: 'ps', platform: 'win32' }, [['set /p X=; Remove-Item -Recurse -Force C:\\x', RM]]);
  });

  it('--dry-run followed by a word may carry a value', () => {
    table({}, [
      ['npm publish --dry-run false', DEPLOY],
      ['npm publish --dry-run 0', DEPLOY],
      ['npm publish --dry-run no', DEPLOY],
      ['npm publish --dry-run ./pkg', DEPLOY],
      ['npm publish --dry-run', null],
      ['npm publish --dry-run --access public', null],
      ['npm publish --dry-run -w pkg', null],
    ]);
  });
});
