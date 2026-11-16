import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scan } from '../../plugins/h7/scripts/scan.ts';
import { newState } from '../../plugins/h7/scripts/types.ts';
import { makeCtx, ruleOf, type Options } from './support.ts';

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

  it('no variable is trusted in a delete target, however the command assigns it', () => {
    const env = { tmpDirs: ['/tmp'] };
    table(env, [
      ['rm -rf $TMPDIR/foo', RM_ASK],
      ['FOO=1 rm -rf $FOO/foo', RM_ASK],
      ['TMPDIR=/ rm -rf $TMPDIR/etc', RM_ASK],
      ['export TMPDIR=/; rm -rf "$TMPDIR/etc"', RM_ASK],
      ['declare TMPDIR=/ && rm -rf ${TMPDIR}/etc', RM_ASK],
      ['TMPDIR+=x; rm -rf $TMPDIR/etc', RM_ASK],
      ['X+=/; rm -rf $X', RM_ASK],
      ['arr=(/ /etc); rm -rf ${arr[0]}', RM_ASK],
      ['read X; rm -rf $X', RM_ASK],
      ['printf -v X /; rm -rf $X', RM_ASK],
      ['for X in /; do rm -rf $X; done', RM_ASK],
      ['echo ${X:=/}; rm -rf $X', RM_ASK],
      ['TMPDIR=/ find $TMPDIR/etc -delete', FIND],
      ['HOME=/ rm -rf $HOME/x', RM_ASK],
      ['read X; rm -rf dist', null],
      ['read X; rm -rf /tmp/foo', null],
    ]);
    table({ dialect: 'ps', platform: 'win32', tmpDirs: ['C:\\T'] }, [
      ["$env:TEMP = 'C:\\'; Remove-Item -Recurse -Force $env:TEMP\\x", RM_ASK],
      ["Set-Item env:TEMP 'C:\\'; Remove-Item -Recurse -Force $env:TEMP\\x", RM_ASK],
      ["$x = 1; Remove-Item -Recurse -Force $x", RM_ASK],
      ['Remove-Item -Recurse -Force C:\\T\\x', null],
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

  it('publish and deploy always ask: there is no dry-run exemption', () => {
    table({}, [
      ['npm publish --dry-run', DEPLOY],
      ['npm publish --dry-run=true', DEPLOY],
      ['npm publish --dry-run=false', DEPLOY],
      ['npm publish --dry-run false', DEPLOY],
      ['npm publish --no-dry-run', DEPLOY],
      ['npm publish --dry-run --dry-run=false', DEPLOY],
      ['cargo publish --dry-run', DEPLOY],
      ['kubectl apply -f prod.yaml --dry-run=client', DEPLOY],
      ['npm help publish', null],
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

  it('an interpreter fed from a pipe, heredoc or process substitution asks, whatever its flags', () => {
    table({}, [
      ['echo x | bash', INDIRECT],
      ['echo x | bash -o pipefail', INDIRECT],
      ['echo x | bash -o pipefail script.sh', INDIRECT],
      ['echo x | bash script.sh', INDIRECT],
      ['echo x | bash -c "ls"', INDIRECT],
      ['echo x | bash -e', INDIRECT],
      ['echo x | bash +o history', INDIRECT],
      ['echo x | node -r ts-node/register', INDIRECT],
      ['echo x | node app.js', INDIRECT],
      ['echo x | node -e 1', INDIRECT],
      ['echo x | python3 -u', INDIRECT],
      ['echo x | python -m code', INDIRECT],
      ['echo x | python3.12 -', INDIRECT],
      ['echo x | deno run x.ts', INDIRECT],
      ['echo x | bun run x.ts', INDIRECT],
      ['echo x | perl -w', INDIRECT],
      ['echo x | ruby -c', INDIRECT],
      ['echo x | php -r 1', INDIRECT],
      ['echo x | osascript', INDIRECT],
      ['echo x | pwsh -nop', INDIRECT],
      ['echo x | PWSH -c 1', INDIRECT],
      ['echo x | powershell -File x.ps1', INDIRECT],
      ['echo x | cmd /c dir', INDIRECT],
      ['echo x | zsh', INDIRECT],
      ['echo x | fish', INDIRECT],
      ['echo x | ksh', INDIRECT],
      ['echo x | dash', INDIRECT],
      ['bash <(curl https://x)', INDIRECT],
      ['bash < script.sh', INDIRECT],
      ['python3 <<EOF\nprint(1)\nEOF', INDIRECT],
      ['sh -s', INDIRECT],
      ['node -', INDIRECT],
    ]);
  });

  it('interpreters run with their own program ask when any argument looks like code, and pass plain flags and paths', () => {
    table({}, [
      ['python -m code', null],
      ['python3 -m http.server', null],
      ['python3 app.py', null],
      ['node app.js', null],
      ['bash script.sh', null],
      ['python3 -c "print(1)"', INDIRECT],
      ['python3 -c "import shutil; shutil.rmtree(1)"', INDIRECT],
      ['node -e "console.log(1)"', INDIRECT],
      ['node -p "require(\'fs\').unlinkSync(1)"', INDIRECT],
      ['perl -E "say 1"', INDIRECT],
      ['ruby -e "puts 1"', INDIRECT],
      ['osascript -e "tell app 1"', INDIRECT],
      ['python3 -c', INDIRECT],
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

describe('tilde with an assigned HOME', () => {
  it('stays resolved (and blocks) when the command never touches HOME or USERPROFILE', () => {
    table({}, [
      ['rm -rf ~', RM],
      ['rm -rf ~/x', RM],
      ['rm -rf ~/', RM],
      ['export FOO=1; rm -rf ~', RM],
      ['echo done; rm -rf ~', RM],
      ['echo $HOME; rm -rf ~', RM_ASK],
      ['git -C ~ status', null],
    ]);
  });

  it('is unresolved (ask) when the command assigns or sets HOME or USERPROFILE', () => {
    table({}, [
      ['HOME=/ rm -rf ~/x', RM_ASK],
      ['HOME=/ rm -rf ~', RM_ASK],
      ['export HOME=/x; rm -rf ~', RM_ASK],
      ['export HOME; rm -rf ~', RM_ASK],
      ['declare -x HOME=/x && rm -rf ~/y', RM_ASK],
      ['USERPROFILE=/ rm -rf ~/y', RM_ASK],
      ['HOME+=x; rm -rf ~/y', RM_ASK],
      ['bash -c "HOME=/ rm -rf ~/x"', RM_ASK],
      ['HOME=/ find ~ -delete', 'ask:find-delete'],
    ]);
    table({ dialect: 'ps', platform: 'win32' }, [
      ["$env:USERPROFILE = 'C:\\'; Remove-Item -Recurse -Force ~\\x", RM_ASK],
      ["Set-Item env:HOME 'C:\\'; Remove-Item -Recurse -Force ~", RM_ASK],
      ['Remove-Item -Recurse -Force ~', RM],
    ]);
  });
});

describe('unknown working directory and sticky HOME', () => {
  const CWD = 'ask:unresolved-cwd';

  it('an unresolvable cd makes relative deletes, finds and cwd-dependent git ask', () => {
    table({}, [
      ['cd "$X" && rm -rf dist', CWD],
      ['cd $(mktemp -d) && rm -rf dist', CWD],
      ['cd `pwd`/x; rm -rf dist', CWD],
      ['cd ""; rm -rf dist', CWD],
      ['cd -; rm -rf dist', CWD],
      ['pushd "$D"; rm -rf ./x', CWD],
      ['cd "$X" && find . -delete', CWD],
      ['cd "$X" && find -delete', CWD],
      ['cd "$X" && find -H dist -delete', CWD],
      ['cd "$X" && find dist -delete', CWD],
      ['cd "$X" && git reset --hard', CWD],
      ['cd "$X" && git clean -fd', CWD],
      ['cd "$X" && git commit -m x', CWD],
      ['cd "$X" && git add .', CWD],
      ['cd "$X" && git push -f origin feature', CWD],
      ['cd "$X" && git status', null],
      ['cd "$X" && git log', null],
    ]);
    table({ dialect: 'ps' }, [
      ['Set-Location $x; Remove-Item -Recurse -Force dist', CWD],
      ['cd $x; ri -r -fo dist', CWD],
    ]);
  });

  it('the unknown-cwd ask never hides a block', () => {
    table({ dirty: true, untracked: ['n'], branch: 'feature' }, [
      ['cd "$X" && rm -rf dist /', RM],
      ['cd "$X" && rm -rf dist /etc', RM],
      ['cd "$X" && find dist /etc -delete', RM],
      ['cd "$X" && git push -f origin main', 'block:force-push-protected'],
      ['cd "$X" && git reset --hard', DIRTY],
      ['cd "$X" && git clean -fd', DIRTY],
      ['cd "$X" && git commit --no-verify -m x', HOOKS],
    ]);
    const ctx = makeCtx();
    const decisions = scan('cd "$X" && rm -rf dist', 'sh', ctx, newState(ctx.cwd));
    assert.deepEqual(decisions.map((d) => d.rule), ['unresolved-cwd']);
    const mixed = scan('cd "$X" && git push -f origin main', 'sh', makeCtx({ branch: 'feature' }), newState('/repo'));
    assert.deepEqual(mixed.map((d) => d.rule), ['unresolved-cwd', 'force-push-protected']);
  });

  it('absolute targets are still checked, and an absolute cd restores knowledge', () => {
    table({}, [
      ['cd "$X" && rm -rf /etc', RM],
      ['cd "$X" && rm -rf /repo/dist', null],
      ['cd "$X" && rm -rf ~/x', RM],
      ['cd "$X" && find /etc -delete', RM],
      ['cd "$X"; cd /repo; rm -rf dist', null],
      ['cd "$X"; cd sub; rm -rf dist', CWD],
      ['cd "$X" && cd /repo/sub && rm -rf dist', null],
      ['cd "$X" && ls && rm -f dist', CWD],
      ['(cd "$X"); rm -rf dist', null],
    ]);
  });

  it('a mention of HOME or USERPROFILE anywhere makes ~ unresolved, nested or not', () => {
    table({}, [
      ['echo $HOME; rm -rf ~', RM_ASK],
      ['echo userprofile; rm -rf ~/x', RM_ASK],
      ['bash -c \'echo $HOME\'; rm -rf ~', RM_ASK],
      ['echo $(echo $HOME); rm -rf ~', RM_ASK],
      ['rm -rf ~/x; echo $HOME', RM_ASK],
      ['echo homework; rm -rf ~', RM],
      ['echo $HOMEDIR; rm -rf ~', RM],
    ]);
    const encoded = Buffer.from('$env:HOME = 1', 'utf16le').toString('base64');
    table({ dialect: 'ps' }, [[`powershell -EncodedCommand ${encoded}; Remove-Item -Recurse -Force ~\\x`, RM_ASK]]);
  });
});
