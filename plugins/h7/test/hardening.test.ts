import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifySecret } from '../scripts/rules-git.ts';
import { pickDecision, scan } from '../scripts/scan.ts';
import { newState } from '../scripts/types.ts';
import { decide, makeCtx, ruleOf, type Options } from './support.ts';

const FORCE = 'block:force-push-protected';
const DIRTY = 'block:destructive-git-dirty';
const SECRET = 'block:secrets-commit';
const AMBIGUOUS = 'ask:secrets-ambiguous';
const HOOKS = 'block:skip-git-hooks';
const INDIRECT = 'ask:indirect-exec';
const RM = 'block:recursive-delete';
const RM_ASK = 'ask:recursive-delete-unresolved';
const DEPLOY = 'ask:deploy-publish';

function table(options: Options, rows: [string, string | null][]): void {
  for (const [command, expected] of rows) {
    assert.equal(ruleOf(command, options), expected, command);
  }
}

describe('git checkout with paths on a tracked-dirty tree', () => {
  const files = { '/repo/a.txt': '', '/repo/src/b.ts': '' };
  it('blocks every spelling that discards file changes', () => {
    table({ dirty: true, files }, [
      ['git checkout a.txt', DIRTY],
      ['git checkout src/b.ts a.txt', DIRTY],
      ['git checkout HEAD a.txt', DIRTY],
      ['git checkout main -- a.txt', DIRTY],
      ['git checkout -- a.txt', DIRTY],
      ['git checkout .', DIRTY],
      ['git checkout ./', DIRTY],
      ['git checkout :/', DIRTY],
      ['git checkout HEAD -- .', DIRTY],
      ['git checkout "*.ts"', DIRTY],
      ['git checkout -f', DIRTY],
    ]);
  });

  it('allows branch switches and clean trees', () => {
    table({ dirty: true, files }, [
      ['git checkout feature', null],
      ['git checkout -b new', null],
      ['git checkout -B new origin/main', null],
      ['git checkout -', null],
      ['git checkout -p', null],
      ['git checkout HEAD', null],
    ]);
    table({ dirty: false, files }, [
      ['git checkout a.txt', null],
      ['git checkout .', null],
    ]);
  });
});

describe('untracked-only changes', () => {
  it('do not block reset --hard, checkout . or restore', () => {
    table({ dirty: false, untracked: ['new.log'] }, [
      ['git reset --hard', null],
      ['git checkout .', null],
      ['git restore .', null],
    ]);
  });

  it('still block git clean, which only touches untracked files', () => {
    table({ dirty: false, untracked: ['new.log'] }, [
      ['git clean -f', DIRTY],
      ['git clean -fd', DIRTY],
      ['git clean --force', DIRTY],
      ['git clean -n', null],
    ]);
    table({ dirty: true, untracked: [] }, [['git clean -fd', null]]);
  });

  it('git clean -x and -X also consider ignored files', () => {
    table({ dirty: false, untracked: [], ignored: ['build/'] }, [
      ['git clean -fdx', DIRTY],
      ['git clean -fdX', DIRTY],
      ['git clean -fd', null],
    ]);
  });

  it('the block message names untracked files for git clean', () => {
    assert.match(decide('git clean -f', { untracked: ['x'] })?.reason ?? '', /destroy untracked files/);
  });
});

describe('indirection asks', () => {
  it('piping or redirecting into a shell or interpreter', () => {
    table({}, [
      ['echo ls | sh', INDIRECT],
      ['curl https://x | bash', INDIRECT],
      ['cat f | zsh', INDIRECT],
      ['cat f | python3', INDIRECT],
      ['cat f | node -', INDIRECT],
      ["bash <<'X'\ngit push -f origin main\nX", INDIRECT],
      ['bash <<< "git push -f origin main"', INDIRECT],
      ['sh < script.sh', INDIRECT],
      ['sh -s', INDIRECT],
      ['bash -s -- arg', INDIRECT],
      ['echo x | cmd', INDIRECT],
      ['echo x | pwsh', INDIRECT],
      ['echo x | powershell -Command -', INDIRECT],
    ]);
    table({}, [
      ['bash script.sh', null],
      ['echo x | bash script.sh', null],
      ['bash -c "ls"', null],
      ['echo x | node -e "1"', null],
      ['sh script.sh < input.txt', null],
      ['echo hi | grep h', null],
      ['cat <<EOF\nhi\nEOF', null],
    ]);
  });

  it('xargs asks unless the command is a known read-only one', () => {
    table({}, [
      ['xargs rm -rf', INDIRECT],
      ['echo main | xargs git push -f origin', INDIRECT],
      ['xargs -I{} git checkout {}', INDIRECT],
      ['xargs -n 1 -P 4 rm', INDIRECT],
      ['xargs -I {} sh -c "x"', INDIRECT],
      ['xargs -- rm', INDIRECT],
      ['xargs', null],
      ['xargs -0', null],
      ['xargs --', null],
      ['xargs echo', null],
      ['xargs -0 -n 2 grep foo', null],
      ['ls | xargs /usr/bin/wc -l', null],
    ]);
  });

  it('Invoke-Expression and iex', () => {
    table({ dialect: 'ps' }, [
      ['Invoke-Expression "git push -f origin main"', INDIRECT],
      ["iex 'x'", INDIRECT],
      ['Write-Output hi', null],
    ]);
  });

  it('command words that are variables or substitutions', () => {
    table({}, [
      ['G=git; $G push -f origin main', INDIRECT],
      ['$(which git) push -f origin main', INDIRECT],
      ['`which git` push -f origin main', INDIRECT],
      ['"$G" push', INDIRECT],
      ['sudo $G push', INDIRECT],
      ['eval $CMD', INDIRECT],
      ['echo $X', null],
      ['for f in $LIST; do echo; done', null],
    ]);
    table({ dialect: 'ps' }, [
      ["$g='git'; & $g push -f origin main", INDIRECT],
      ['$x = 5', null],
      ['$env:A = "b"', null],
      ['foreach ($f in $items) { Write-Output $f }', null],
      ['$items | ForEach-Object { $_ }', null],
    ]);
  });
});

describe('git global options with separate values', () => {
  it('finds the real subcommand', () => {
    table({}, [
      ['git -c user.name=x push -f origin main', FORCE],
      ['git -C . -c a=b push -f origin main', FORCE],
      ['git --git-dir=.git --work-tree=. push -f origin main', FORCE],
      ['git --git-dir .git --work-tree . push -f origin main', FORCE],
      ['git --namespace ns push -f origin main', FORCE],
      ['git --super-prefix p/ push -f origin main', FORCE],
      ['git --attr-source HEAD push -f origin main', FORCE],
      ['git --config-env=a=B push -f origin main', FORCE],
      ['git --config-env a=B push -f origin main', FORCE],
      ['git --exec-path push -f origin main', FORCE],
      ['git --exec-path=/x push -f origin main', FORCE],
      ['git --no-pager -P push -f origin main', FORCE],
    ]);
  });

  it('repository selectors that cannot be resolved ask before destructive commands', () => {
    table({ dirty: true }, [
      ['git -C "$D" reset --hard', 'ask:destructive-git-unresolved'],
      ['git --git-dir=/elsewhere/x reset --hard', 'ask:destructive-git-unresolved'],
      ['git --work-tree="$W" reset --hard', 'ask:destructive-git-unresolved'],
      ['git --git-dir=.git reset --hard', DIRTY],
      ['git --git-dir=sub/.git reset --hard', DIRTY],
      ['git --work-tree=sub reset --hard', DIRTY],
      ['git -C sub reset --hard', DIRTY],
      ['git -C "" reset --hard', DIRTY],
      ['git -C "$D" status', null],
    ]);
  });
});

describe('state across a command chain', () => {
  it('git checkout and switch change the branch for later pushes', () => {
    table({ branch: 'feature' }, [
      ['git checkout main && git push -f', FORCE],
      ['git switch main; git push --force', FORCE],
      ['git checkout -b main && git push --force-with-lease', FORCE],
      ['git switch -c master && git push -f origin HEAD', FORCE],
      ['git checkout -B production && git push -f', FORCE],
    ]);
    table({ branch: 'main' }, [
      ['git checkout other && git push -f', null],
      ['git switch other && git push -f origin HEAD', null],
      ['git checkout - && git push -f', null],
      ['git switch --detach && git push -f', null],
      ['git checkout -- a.txt && git push -f', FORCE],
    ]);
  });

  it('stash makes the tree clean for later segments, and pop makes it dirty again', () => {
    table({ dirty: true, untracked: ['n'] }, [
      ['git stash && git reset --hard', null],
      ['git stash push && git checkout .', null],
      ['git stash -u && git clean -fd', null],
      ['git stash --include-untracked && git clean -fd', null],
      ['git stash -a && git clean -fdx', null],
      ['git stash --all && git clean -fdx', null],
      ['git stash save x && git reset --hard', null],
      ['git stash && git clean -fd', DIRTY],
      ['git stash list && git reset --hard', DIRTY],
    ]);
    table({ dirty: false }, [
      ['git stash pop && git reset --hard', DIRTY],
      ['git stash apply; git reset --hard', DIRTY],
      ['git stash branch x && git reset --hard', DIRTY],
    ]);
  });

  it('commit -a, reset, restore and clean clear what they discard', () => {
    table({ dirty: true, untracked: ['n'] }, [
      ['git commit -am x && git reset --hard', null],
      ['git commit --all -m x; git checkout .', null],
      ['git commit -m x && git reset --hard', DIRTY],
      ['git clean -n && git clean -fd', DIRTY],
    ]);
  });

  it('files added earlier in the chain count for a later commit', () => {
    const ctx = makeCtx();
    const decisions = scan('git add .env.local; git commit -m x', 'sh', ctx, newState(ctx.cwd));
    assert.equal(decisions.filter((d) => d.rule === 'secrets-commit').length, 2);
    assert.equal(ruleOf('git commit -m x', { state: { staged: ['.env'] } }), SECRET);
    assert.equal(ruleOf('git stage .env && git commit -m x', {}), SECRET);
    assert.equal(ruleOf('git update-index --add .env && git commit -m x', {}), SECRET);
    assert.equal(ruleOf('git update-index --cacheinfo 100644,abc123,id_rsa', {}), SECRET);
    assert.equal(ruleOf('git update-index --refresh', {}), null);
    assert.equal(ruleOf('git update-index --add notes.txt', {}), null);
  });

  it('cd inside a subshell does not leak', () => {
    table({}, [
      ['(cd .. && ls); rm -rf dist', null],
      ['(cd / ; (cd /etc)); rm -rf dist', null],
      ['(cd /etc) && rm -rf dist', null],
      ['cd .. && rm -rf dist', RM],
      ['{ cd ..; }; rm -rf dist', RM],
      ['(cd ..); cd .. && rm -rf dist', RM],
      ['(ls); rm -rf /etc', RM],
    ]);
  });

  it('cd x || ... keeps both possible directories', () => {
    table({}, [
      ['cd /etc || true; rm -rf dist', RM],
      ['cd sub || true; rm -rf dist', null],
      ['cd /etc || exit 1; rm -rf dist', RM],
      ['cd sub || exit 1; rm -rf dist', null],
      ['cd sub || return; rm -rf dist', null],
      ['cd sub || cd /etc; rm -rf dist', RM],
      ['cd /nope && ls || echo no; rm -rf dist', RM],
    ]);
    table({ tmpDirs: ['/tmp'] }, [
      ['cd /tmp || true; rm -rf dist', null],
      ['cd /tmp/x || exit 1; rm -rf dist', null],
    ]);
  });

  it('git commands are evaluated in every possible directory', () => {
    assert.equal(ruleOf('cd sub || true; git push -f origin main', { branch: 'feature' }), FORCE);
  });

  it('the cwd set stays bounded', () => {
    const many = Array.from({ length: 20 }, (_, i) => `cd d${i} || true`).join('; ');
    assert.equal(ruleOf(`${many}; rm -rf dist`, {}), null);
  });
});

describe('git add: ignored files, stage, whole-repo scope and subdirectories', () => {
  it('add -f considers ignored files, add without -f does not', () => {
    table({ ignored: ['.env', 'node_modules/'] }, [
      ['git add -f .', SECRET],
      ['git add --force -A', SECRET],
      ['git add -fA', SECRET],
      ['git add .', null],
      ['git add -A', null],
    ]);
    table({ ignored: ['node_modules/'] }, [['git add -f .', null]]);
  });

  it('git stage behaves like git add', () => {
    table({ untracked: ['.env'] }, [
      ['git stage .', SECRET],
      ['git stage -A', SECRET],
      ['git stage src', null],
    ]);
  });

  it('commit -a and add -A consider the whole repository from a subdirectory', () => {
    const sub = { cwd: '/repo/sub' };
    table({ ...sub, modified: ['.env'] }, [
      ['git commit -am x', SECRET],
      ['git commit --all -m x', SECRET],
      ['git commit -m x', null],
      ['git add -u', SECRET],
    ]);
    table({ ...sub, untracked: ['.env'] }, [
      ['git add -A', SECRET],
      ['git add --all', SECRET],
      ['git add :/', SECRET],
      ['git add .', null],
      ['git add -A ..', SECRET],
    ]);
  });

  it('pathspecs are resolved against the cwd and matched against repo-root paths', () => {
    const sub = { cwd: '/repo/sub' };
    table({ ...sub, untracked: ['sub/.env', 'other/.env.local'] }, [
      ['git add .', SECRET],
      ['git add .env', SECRET],
      ["git add '.e*'", SECRET],
      ["git add '*.env'", SECRET],
      ['git add ../other', SECRET],
      ['git add ../other/.env.local', SECRET],
      ["git add '../other/.e*'", SECRET],
      ['git add :/other', SECRET],
      ['git add ../elsewhere', null],
      ['git add ../../outside', null],
    ]);
    table({ ...sub, untracked: ['.env'] }, [
      ['git add ../.env', SECRET],
      ['git add :/.env', SECRET],
      ["git add ':(top).env'", SECRET],
      ["git add ':!x'", SECRET],
      ["git add '.e*'", null],
      ["git add '../.e*'", SECRET],
      ["git add ':/.e*'", SECRET],
      ['git add .', null],
    ]);
  });

  it('evaluates glob pathspecs against candidate files', () => {
    table({ untracked: ['.env', 'a/.env.local', 'x.pem', 'readme.md'] }, [
      ["git add '.env*'", SECRET],
      ["git add '*.env'", SECRET],
      ['git add .e*', SECRET],
      ["git add '.?nv'", SECRET],
      ["git add '.[e]nv'", SECRET],
      ["git add '.[!e]nv'", null],
      ["git add 'a/*'", SECRET],
      ["git add '*.md'", null],
      ["git add '*.pem'", AMBIGUOUS],
      ["git add 'x[.]pem'", AMBIGUOUS],
      ["git add 'x[.pem'", null],
      ['git add "a+b(c).txt"', null],
    ]);
  });

  it('works outside a repository and survives odd specs', () => {
    table({ root: null }, [
      ['git add .env', SECRET],
      ['git add .', null],
    ]);
    table({ untracked: ['.env'] }, [
      ['git add "$X"', null],
      ['git add --pathspec-from-file=list.txt', null],
    ]);
  });
});

describe('GNU long option abbreviations', () => {
  it('rm treats unique prefixes of --recursive and --force as the real thing', () => {
    table({}, [
      ['rm --rec --for /etc', RM],
      ['rm --recur --f /etc', RM],
      ['rm --recursive --fo /etc', RM],
      ['rm --recursive=x /etc', RM],
      ['rm --force --recursiv /etc', RM],
      ['rm --verbose --dir /etc', null],
      ['rm --no-preserve-root /etc', null],
      ['rm --interactive /etc', null],
    ]);
  });

  it('rm -r without -f counts as a recursive delete', () => {
    table({}, [
      ['rm -r /etc', RM],
      ['rm -R /etc', RM],
      ['rm --recursive /etc', RM],
      ['rm -r dist', null],
      ['rm /etc/hosts', null],
      ['rm -f /etc/hosts', null],
    ]);
  });

  it('git options are matched by unique prefix', () => {
    table({ branch: 'feature' }, [
      ['git push --force-w origin main', FORCE],
      ['git push --force-with origin main', FORCE],
      ['git push --force-if origin main', FORCE],
      ['git push --forc origin main', FORCE],
      ['git push --f origin main', 'ask:push-protected'],
      ['git push --dele origin main', 'block:push-delete-protected'],
      ['git push --no-ver origin feature', HOOKS],
      ['git commit --no-ver -m x', HOOKS],
      ['git commit --no-verif -m x', HOOKS],
      ['git commit --no-v -m x', HOOKS],
      ['git commit --no-edit -m x', null],
      ['git commit --no- -m x', null],
      ['git commit --no -m x', null],
      ['git push --no-thin origin feature', null],
    ]);
    table({ dirty: true, untracked: ['n'] }, [
      ['git reset --har', DIRTY],
      ['git clean --forc -d', DIRTY],
      ['git checkout --forc', DIRTY],
      ['git switch --discard-c main', DIRTY],
      ['git reset --har --', DIRTY],
      ['git reset --soft HEAD~1', null],
    ]);
  });
});

describe('find and xargs deletes', () => {
  it('blocks find -delete and -exec rm outside the repository, root and home', () => {
    table({}, [
      ['find / -name "*.log" -delete', RM],
      ['find ~ -delete', RM],
      ['find ~/Documents -type f -exec rm -rf {} +', RM],
      ['find /etc -exec rm {} \\;', RM],
      ['find ../other -delete', RM],
      ['find /repo/.git -delete', RM],
      ['find -H /etc -delete', RM],
      ['find . /etc -delete', RM],
    ]);
  });

  it('asks for find deletes inside the repository or with unresolved start paths', () => {
    table({}, [
      ['find . -delete', 'ask:find-delete'],
      ['find dist -type f -delete', 'ask:find-delete'],
      ['find -delete', 'ask:find-delete'],
      ['find /repo -name x -exec rm {} +', 'ask:find-delete'],
      ['find . -execdir /bin/rm -f {} +', 'ask:find-delete'],
      ['find "$D" -delete', 'ask:find-delete'],
      ['find . ! -name x -delete', 'ask:find-delete'],
      ['find . -name x', null],
      ['find . -exec grep x {} +', null],
      ['find /etc -name x', null],
      ['find . -exec', null],
    ]);
  });

  it('allows deletes under the temp directory', () => {
    table({ tmpDirs: ['/tmp'] }, [
      ['find /tmp/x -delete', null],
      ['find /tmp -name "*.log" -delete', null],
    ]);
  });
});

describe('PowerShell delete targets', () => {
  const ps = { dialect: 'ps' as const };
  it('asks for parenthesised, piped and variable targets', () => {
    table(ps, [
      ['Remove-Item -Recurse -Force (Join-Path $HOME Documents)', RM_ASK],
      ['Remove-Item -Recurse -Force -Path (Get-Item C:\\)', RM_ASK],
      ['Get-ChildItem C:\\x | Remove-Item -Recurse -Force', RM_ASK],
      ['gci x -Recurse | ri -Force', RM_ASK],
      ['Remove-Item -Recurse -Force $target', RM_ASK],
      ['Remove-Item -Recurse -Force "$env:USERPROFILE\\x"', RM],
      ['Remove-Item -Recurse -Force', RM_ASK],
    ]);
  });

  it('keeps allowing literal repository paths, piped plain deletes and -WhatIf', () => {
    table(ps, [
      ['Remove-Item -Recurse -Force dist', null],
      ['Get-ChildItem x | Remove-Item', null],
      ['Get-ChildItem x | Remove-Item -Force dist', null],
      ['Remove-Item -Recurse -Force C:\\ -WhatIf', null],
      ['Remove-Item -Recurse -Force C:\\ -wh', null],
    ]);
  });
});

describe('core.hooksPath', () => {
  it('blocks paths outside the repository from every channel', () => {
    table({}, [
      ['git config core.hooksPath /dev/null', HOOKS],
      ['git config --global core.hooksPath ~/hooks', HOOKS],
      ['git config core.hookspath ../hooks', HOOKS],
      ['git -c core.hooksPath=/tmp/x commit -m x', HOOKS],
      ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x', HOOKS],
      ['export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_1=core.hookspath GIT_CONFIG_VALUE_1=/x; git commit -m y', HOOKS],
      ['H=/tmp/x git --config-env core.hooksPath=H commit -m x', HOOKS],
      ['H=/tmp/x git --config-env=core.hooksPath=H commit -m x', HOOKS],
    ]);
  });

  it('allows paths inside the repository and unrelated config', () => {
    table({}, [
      ['git config core.hooksPath .husky', null],
      ['git config core.hooksPath /repo/.githooks', null],
      ['git -c core.hooksPath=.husky commit -m x', null],
      ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=.husky git commit -m x', null],
      ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=/dev/null git commit -m x', null],
      ['GIT_CONFIG_COUNT=x GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git status', null],
      ['git config --unset core.hooksPath', null],
      ['git config core.hooksPath', null],
      ['git config user.name x', null],
    ]);
  });

  it('asks when the value cannot be resolved', () => {
    table({}, [
      ['git -c core.hooksPath="$H" commit -m x', 'ask:skip-git-hooks'],
      ['git -c core.hooksPath= commit -m x', 'ask:skip-git-hooks'],
      ['git --config-env core.hooksPath=H commit -m x', 'ask:skip-git-hooks'],
      ['git config core.hooksPath "$(pwd)/h"', 'ask:skip-git-hooks'],
    ]);
  });
});

describe('git aliases', () => {
  it('expands aliases defined with -c, git config or earlier in the chain', () => {
    table({ branch: 'feature' }, [
      ["git -c alias.p='push -f' p origin main", FORCE],
      ["git config alias.pf 'push -f' && git pf origin main", FORCE],
      ["git -c alias.p='push' p origin feature", 'ask:git-alias'],
      ["git -c alias.PF='push -f' pf origin main", FORCE],
      ["git -c alias.a=b -c alias.b='push -f' a origin main", FORCE],
    ]);
    assert.equal(ruleOf("git -c alias.loop=loop loop", {}), 'ask:git-alias');
  });

  it('definitions ask, or block when the value is dangerous', () => {
    table({ branch: 'feature', dirty: true }, [
      ["git config alias.st status", 'ask:git-alias'],
      ["git config alias.pf 'push -f origin main'", FORCE],
      ["git config --global alias.nuke 'reset --hard'", DIRTY],
      ["git config alias.x '!git push -f origin main'", FORCE],
      ["git config alias.x '!ls'", 'ask:git-alias'],
      ["git -c alias.x='!git reset --hard' x", DIRTY],
      ['git config alias.x', null],
    ]);
  });

  it('shell aliases are scanned', () => {
    assert.equal(ruleOf("git -c alias.x='!git push -f origin main' x", { branch: 'f' }), FORCE);
  });
});

describe('secret tiers', () => {
  it('blocks high-confidence names', () => {
    for (const name of ['.env', '.env.local', '.env.staging.local', '.env.production', '.env.production.local', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'a.p12', 'a.pfx', 'a.keystore', 'a.jks', 'credentials.json', 'secrets.yaml', 'secrets.prod.json', 'server.key', '.netrc', '.pgpass']) {
      assert.equal(classifySecret(name)?.tier, 'block', name);
    }
  });

  it('asks for ambiguous names and allows examples and public keys', () => {
    for (const name of ['.env.development', '.env.test', '.env.staging', 'a.pem', '.npmrc', 'prod.tfvars']) {
      assert.equal(classifySecret(name)?.tier, 'ask', name);
    }
    for (const name of ['.env.example', '.env.sample', '.env.template', '.env.local.example', 'id_rsa.pub', 'id_ed25519.pub', '.envrc', 'secrets.ts', 'secrets.md', 'secrets.test.js', 'README.md']) {
      assert.equal(classifySecret(name), null, name);
    }
  });

  it('adds and commits use the tiers', () => {
    table({}, [
      ['git add .env.development', AMBIGUOUS],
      ['git add .npmrc prod.tfvars', AMBIGUOUS],
      ['git add id_ecdsa', SECRET],
      ['git add .env.development .env', SECRET],
      ['git add id_rsa.pub', null],
    ]);
    assert.equal(ruleOf('git commit -m x', { staged: ['.env.test'] }), AMBIGUOUS);
    assert.match(decide('git add ca.pem')?.reason ?? '', /may contain secrets \(PEM key or certificate\)/);
  });

  it('sniffs *.pem content for private keys', () => {
    const files = { '/repo/key.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc', '/repo/ca.pem': '-----BEGIN CERTIFICATE-----\nabc', '/repo/sub/key.pem': 'PRIVATE KEY' };
    table({ files }, [
      ['git add key.pem', SECRET],
      ['git add ca.pem', AMBIGUOUS],
      ['git add missing.pem', AMBIGUOUS],
    ]);
    assert.equal(ruleOf('git commit -m x', { files, staged: ['key.pem'] }), SECRET);
    assert.equal(ruleOf('git add key.pem', { files, cwd: '/repo/sub' }), SECRET);
    assert.equal(ruleOf('git add key.pem', { files, root: null }), SECRET);
  });
});

describe('publish and deploy', () => {
  it('detects subcommands behind options and wrappers', () => {
    table({}, [
      ['npm --registry https://r.example --tag next publish', DEPLOY],
      ['npm -w pkg publish', DEPLOY],
      ['pnpm --filter pkg publish', DEPLOY],
      ['pnpm -r publish', DEPLOY],
      ['yarn workspace pkg publish', DEPLOY],
      ['yarn npm publish', DEPLOY],
      ['bun publish', DEPLOY],
      ['npx lerna publish', DEPLOY],
      ['npx -y wrangler publish', DEPLOY],
      ['npx --package x wrangler deploy', DEPLOY],
      ['pnpm dlx wrangler deploy', DEPLOY],
      ['npm exec lerna publish', DEPLOY],
      ['yarn dlx firebase deploy', DEPLOY],
      ['bunx cdk deploy', DEPLOY],
      ['npx', null],
      ['npx -y', null],
      ['lerna publish', DEPLOY],
      ['changeset publish', DEPLOY],
      ['npx changeset version', null],
    ]);
  });

  it('asks for deploy-like npm scripts, not other scripts', () => {
    table({}, [
      ['npm run deploy', DEPLOY],
      ['npm run release:ci', DEPLOY],
      ['pnpm run publish-docs', DEPLOY],
      ['yarn deploy', DEPLOY],
      ['bun run Deploy', DEPLOY],
      ['npm run-script release', DEPLOY],
      ['npm run build', null],
      ['npm test', null],
      ['yarn build', null],
      ['npm install', null],
      ['yarn', null],
    ]);
  });

  it('asks for other registries and cloud tools', () => {
    table({}, [
      ['cargo publish', DEPLOY],
      ['poetry publish', DEPLOY],
      ['twine upload dist/*', DEPLOY],
      ['gem push x.gem', DEPLOY],
      ['dotnet nuget push x.nupkg', DEPLOY],
      ['docker compose push', DEPLOY],
      ['docker-compose push', DEPLOY],
      ['docker buildx build --push .', DEPLOY],
      ['docker build --push .', DEPLOY],
      ['netlify deploy --prod', DEPLOY],
      ['netlify deploy -p', DEPLOY],
      ['firebase deploy --only hosting', DEPLOY],
      ['wrangler deploy', DEPLOY],
      ['wrangler publish', DEPLOY],
      ['serverless deploy', DEPLOY],
      ['sls deploy --stage prod', DEPLOY],
      ['cdk deploy', DEPLOY],
      ['pulumi up', DEPLOY],
      ['pulumi destroy', DEPLOY],
      ['kubectl apply -f k8s/prod/app.yaml', DEPLOY],
      ['kubectl apply --filename=prod.yaml', DEPLOY],
      ['kubectl delete -k overlays/production', DEPLOY],
      ['kubectl apply -f k8s/dev.yaml', null],
      ['kubectl get pods -f prod.yaml', null],
      ['netlify deploy', null],
      ['netlify status', null],
      ['pulumi preview', null],
      ['wrangler dev', null],
      ['cargo build', null],
      ['twine check', null],
      ['dotnet build', null],
      ['docker build .', null],
      ['docker compose up', null],
    ]);
  });

  it('gh api against protected branch refs', () => {
    table({}, [
      ['gh api -X DELETE repos/o/r/git/refs/heads/main', DEPLOY],
      ['gh api --method PATCH repos/o/r/git/refs/heads/master -f force=true', DEPLOY],
      ['gh api -XPUT repos/o/r/git/refs/heads/release%2F1', DEPLOY],
      ['gh api -X delete repos/o/r/git/refs/heads/production', DEPLOY],
      ['gh api -X DELETE repos/o/r/git/refs/heads/feature', null],
      ['gh api repos/o/r/git/refs/heads/main', null],
      ['gh api -X POST repos/o/r/git/refs/heads/main', null],
      ['gh api -X DELETE repos/o/r/issues/1', null],
      ['gh api -X DELETE', null],
      ['gh api -X DELETE repos/o/r/git/refs/heads/%E0%A4%A', null],
    ]);
  });

  it('--dry-run and help are allowed', () => {
    table({}, [
      ['npm publish --dry-run', null],
      ['npm help publish', null],
      ['cargo publish --dry-run', null],
      ['kubectl apply -f prod.yaml --dry-run=client', null],
      ['pnpm run deploy --dry-run', null],
    ]);
  });
});

describe('history rewriting and protected refs', () => {
  it('asks for stash drop and clear, dirty or not', () => {
    table({ dirty: true }, [
      ['git stash drop', 'ask:git-stash-drop'],
      ['git stash drop stash@{1}', 'ask:git-stash-drop'],
      ['git stash clear', 'ask:git-stash-drop'],
    ]);
    table({ dirty: false }, [['git stash clear', 'ask:git-stash-drop']]);
    assert.equal(ruleOf('git stash list', {}), null);
  });

  it('asks before moving protected branches or rewriting history', () => {
    table({}, [
      ['git branch -f main HEAD~1', 'ask:git-protected-ref'],
      ['git branch --force master abc', 'ask:git-protected-ref'],
      ['git branch -M main', 'ask:git-protected-ref'],
      ['git branch -f release/1 abc', 'ask:git-protected-ref'],
      ['git branch -f feature abc', null],
      ['git branch main', null],
      ['git branch -d main', null],
      ['git update-ref refs/heads/main HEAD~1', 'ask:git-protected-ref'],
      ['git update-ref -d refs/heads/release/2', 'ask:git-protected-ref'],
      ['git update-ref refs/heads/feature HEAD', null],
      ['git update-ref refs/tags/main HEAD', null],
      ['git filter-branch --all', 'ask:git-history-rewrite'],
      ['git filter-repo --path x', 'ask:git-history-rewrite'],
      ['git reflog expire --expire=now --all', 'ask:git-history-rewrite'],
      ['git reflog expire --expire-unreachable=now --all', 'ask:git-history-rewrite'],
      ['git reflog expire --expire=30.days --all', null],
      ['git reflog', null],
      ['git gc --prune=now', 'ask:git-history-rewrite'],
      ['git gc --prune=2.weeks.ago', null],
      ['git gc', null],
    ]);
  });

  it('blocks non-force deletes of protected branches on the remote', () => {
    table({ branch: 'feature' }, [
      ['git push origin :main', 'block:push-delete-protected'],
      ['git push --delete origin main', 'block:push-delete-protected'],
      ['git push origin --delete release/1', 'block:push-delete-protected'],
      ['git push origin :feature', null],
      ['git push origin --delete feature', null],
    ]);
  });

  it('rm -rf .git is blocked, nested .git directories are not', () => {
    table({}, [
      ['rm -rf .git', RM],
      ['rm -rf ./.git', RM],
      ['rm -rf /repo/.git', RM],
      ['rm -rf sub/../.git', RM],
      ['rm -rf sub/.git', null],
      ['rm -rf .git/hooks', null],
      ['rm -rf .github', null],
    ]);
    assert.match(decide('rm -rf .git')?.reason ?? '', /\.git directory/);
  });
});

describe('false positives', () => {
  it('deletes under the temp directory are allowed, the temp directory itself is not', () => {
    table({ tmpDirs: ['/tmp', '/var/tmp'] }, [
      ['rm -rf /tmp/foo', null],
      ['rm -rf /var/tmp/a/b', null],
      ['rm -rf /tmp/foo*', null],
      ['rm -rf /tmp/*', null],
      ['rm -rf /tmp', RM],
      ['rm -rf /tmp/../etc', RM],
      ['rm -rf /tmpx/foo', RM],
      ['rm -rf /tmp/x /etc/y', RM],
    ]);
    table({}, [['rm -rf /tmp/foo', RM]]);
  });

  it('temp variables expand only when they are literally set', () => {
    table({ tmpDirs: ['/tmp'], tmpVars: { TMPDIR: '/tmp' } }, [
      ['rm -rf $TMPDIR/foo', null],
      ['rm -rf "${TMPDIR}/foo"', null],
      ['rm -rf $TMPDIR', RM],
      ['rm -rf $OTHER/foo', RM_ASK],
      ['rm -rf $TMPDIRX/foo', RM_ASK],
    ]);
    table({ tmpDirs: ['/tmp'] }, [['rm -rf $TMPDIR/foo', RM_ASK]]);
    table(
      { dialect: 'ps', platform: 'win32', tmpDirs: ['C:\\Users\\me\\AppData\\Local\\Temp'], tmpVars: { TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp' } },
      [
        ['Remove-Item -Recurse -Force $env:TEMP\\foo', null],
        ['Remove-Item -Recurse -Force %TEMP%\\foo', null],
        ['Remove-Item -Recurse -Force $env:TMP\\foo', RM_ASK],
        ['Remove-Item -Recurse -Force C:\\Users\\me\\AppData\\Local\\Temp', RM],
      ],
    );
    assert.equal(
      ruleOf('Remove-Item -Recurse -Force $env:temp\\foo', { dialect: 'ps', platform: 'win32', tmpDirs: ['C:\\T'], tmpVars: { TEMP: 'C:\\T' } }),
      null,
    );
  });

  it('rm -rf * at the repository root asks instead of blocking, but other broad globs still block', () => {
    table({}, [
      ['rm -rf *', 'ask:recursive-delete-broad'],
      ['rm -rf ./*', 'ask:recursive-delete-broad'],
      ['rm -rf .*', 'ask:recursive-delete-broad'],
      ['rm -rf ../*', RM],
      ['rm -rf ~/*', RM],
      ['rm -rf /*', RM],
      ['rm -rf sub/*', null],
    ]);
  });
});

describe('block messages never recommend a sequence the guard blocks', () => {
  const advice = (text: string): string[] => [...text.matchAll(/"((?:git|rm) [^"]+)"/g)].map((m) => m[1] as string);

  it('every quoted command in a block reason passes the guard', () => {
    const offenders: [string, Options][] = [
      ['git reset --hard', { dirty: true }],
      ['git clean -fd', { untracked: ['x'] }],
      ['git add .env', {}],
      ['git commit -m x', { staged: ['.env'] }],
      ['rm -rf /etc', {}],
      ['rm -rf .git', {}],
      ['git push -f origin main', {}],
      ['git commit --no-verify -m x', {}],
      ['find / -delete', {}],
      ['git push origin :main', {}],
    ];
    let seen = 0;
    for (const [command, options] of offenders) {
      const reason = decide(command, options)?.reason ?? '';
      for (const suggestion of advice(reason)) {
        seen++;
        assert.equal(ruleOf(suggestion, { ...options, dirty: false, untracked: [], staged: [] }), null, `${command} suggests ${suggestion}`);
      }
    }
    assert.ok(seen >= 4);
  });

  it('the stash-then-run sequence it recommends is allowed in one chain', () => {
    table({ dirty: true, untracked: ['x'] }, [
      ['git stash push -u && git reset --hard', null],
      ['git stash push -u && git clean -fd', null],
      ['git stash push -u && git checkout .', null],
    ]);
    assert.match(decide('git reset --hard', { dirty: true })?.reason ?? '', /"git stash push -u"/);
  });

  it('unstaging advice and the delete advice are allowed', () => {
    table({ dirty: true, untracked: ['x'] }, [
      ['git restore --staged .env', null],
      ['rm -rf node_modules dist', null],
      ['rm -rf dist', null],
    ]);
  });
});

describe('scan state helpers', () => {
  it('picks blocks over asks', () => {
    const ctx = makeCtx();
    const decisions = scan('git stash drop; git push -f origin main', 'sh', ctx, newState(ctx.cwd));
    assert.equal(pickDecision(decisions)?.decision, 'block');
  });
});
