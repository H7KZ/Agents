import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { detect, main, type Detection } from '../../plugins/h7/scripts/detect.ts';
import { workflowJobs, workflowTriggers } from '../../plugins/h7/scripts/detect-ci.ts';
import { openRepo, type Limits } from '../../plugins/h7/scripts/detect-fs.ts';
import { classifyCommits, redactUrl, remoteHost } from '../../plugins/h7/scripts/detect-git.ts';
import { globToRegex, tokens, tomlSection, tomlSections, yamlList } from '../../plugins/h7/scripts/detect-scan.ts';
import { findTools, kindOf, kindsOfCommand, mutates } from '../../plugins/h7/scripts/detect-tools.ts';
import type { Runner } from '../../plugins/h7/scripts/git.ts';
import { cleanupTmp, git, initRepo, runNode, SLOW, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const noGit: Runner = () => ({ status: 128, stdout: '' });

function run(files: Record<string, string>, runner: Runner = noGit): Detection {
  const dir = tmpDir();
  writeTree(dir, files);
  return detect(dir, runner);
}

const layer = (d: Detection, id: string) => d.layers.find((l) => l.layer === id)!;
const pkg = (o: object): string => JSON.stringify(o);

describe('fixture: pnpm + turbo monorepo', () => {
  const d = run({
    'package.json': pkg({ name: 'root', private: true, packageManager: 'pnpm@9.1.0', scripts: { lint: 'turbo run lint', format: 'prettier --write .', 'format:check': 'prettier --check .', test: 'turbo run test', prepare: 'x', pretest: 'y', posttest: 'q', postbuild: 'w', build: 'b', preview: 'z', 'test:e2e': 'playwright test' }, devDependencies: { turbo: '1', prettier: '3', typescript: '5' } }),
    'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!packages/skip'\n\ncatalog:\n  x: 1\n",
    'turbo.json': '{}',
    'apps/web/package.json': pkg({ name: '@x/web', scripts: { dev: 'vite', test: 'vitest run', 'test:cov': 'vitest run --coverage' }, dependencies: { vite: '5' }, devDependencies: { vitest: '1', '@vitest/coverage-v8': '1', 'fast-check': '3', eslint: '9', '@playwright/test': '1' } }),
    'apps/web/src/a.ts': '',
    'apps/web/src/b.tsx': '',
    'apps/api/package.json': pkg({ name: '@x/api', scripts: { start: 'node server.js' }, dependencies: { express: '4' } }),
    'packages/lib/package.json': pkg({ name: '@x/lib', main: 'index.js', scripts: { build: 'tsc -b' } }),
    'packages/skip/package.json': pkg({ name: '@x/skip' }),
    'packages/cli/package.json': pkg({ name: '@x/cli', bin: { cli: 'bin/cli.js' } }),
    'packages/bin/package.json': pkg({ name: '@x/bin', bin: 'run.js' }),
    'packages/desk/package.json': pkg({ name: '@x/desk', dependencies: { electron: '1' }, scripts: { dev: 'electron .' } }),
    'tools/loose/package.json': pkg({ name: 'loose', scripts: { start: 'node x' } }),
    'tools/loose/yarn.lock': '',
    '.github/workflows/ci.yml': 'name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  check:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm install\n      - run: pnpm lint\n  test:\n    steps:\n      - run: |\n          pnpm test\n          pnpm test:e2e\n',
    'README.md': '',
  });

  it('finds monorepo tools and workspaces', () => {
    assert.deepEqual(d.monorepo?.tools, ['pnpm-workspaces', 'turbo']);
    assert.deepEqual(d.monorepo?.workspaces.map((w) => w.dir), ['apps/api', 'apps/web', 'packages/bin', 'packages/cli', 'packages/desk', 'packages/lib']);
    assert.deepEqual(d.packageManagers, [{ name: 'pnpm', lockfile: 'pnpm-lock.yaml', dir: '.' }, { name: 'yarn', lockfile: 'tools/loose/yarn.lock', dir: 'tools/loose' }]);
  });

  it('builds run commands per package manager and skips lifecycle scripts', () => {
    const run = (dir: string, name: string) => d.scripts.find((s) => s.dir === dir && s.name === name);
    assert.equal(run('.', 'lint')?.run, 'pnpm run lint');
    assert.equal(run('apps/web', 'dev')?.run, 'pnpm --filter @x/web run dev');
    assert.equal(run('tools/loose', 'start')?.run, 'cd tools/loose && pnpm run start');
    assert.equal(run('.', 'prepare'), undefined);
    assert.equal(run('.', 'pretest'), undefined);
    assert.equal(run('.', 'posttest'), undefined);
    assert.equal(run('.', 'postbuild'), undefined);
    assert.ok(run('.', 'preview'));
    assert.equal(run('.', 'format')?.mutates, true);
    assert.equal(run('.', 'format:check')?.mutates, false);
    assert.equal(run('.', 'test:e2e')?.kind, 'e2e');
  });

  it('classifies surfaces', () => {
    const by = (dir: string) => d.surfaces.find((s) => s.dir === dir);
    assert.deepEqual(by('apps/web'), { kind: 'web', name: '@x/web', dir: 'apps/web', run: 'pnpm --filter @x/web run dev', evidence: 'dep:vite' });
    assert.equal(by('apps/api')?.kind, 'api');
    assert.equal(by('apps/api')?.run, 'pnpm --filter @x/api run start');
    assert.equal(by('packages/lib')?.kind, 'library');
    assert.equal(by('packages/lib')?.run, null);
    assert.equal(by('packages/cli')?.run, 'node packages/cli/bin/cli.js');
    assert.equal(by('packages/bin')?.run, 'node packages/bin/run.js');
    assert.equal(by('packages/desk')?.kind, 'desktop');
    assert.equal(by('packages/skip'), undefined);
    assert.equal(by('.'), undefined);
  });

  it('finds tools and layers', () => {
    assert.deepEqual(layer(d, 'unit').tools, ['vitest']);
    assert.deepEqual(layer(d, 'property').tools, ['fast-check']);
    assert.deepEqual(layer(d, 'e2e').tools, ['playwright']);
    assert.deepEqual(layer(d, 'format').commands, ['pnpm run format:check']);
    assert.equal(layer(d, 'mutation').status, 'gap');
    assert.equal(layer(d, 'mutation').recommend, '@stryker-mutator/core');
    assert.ok(d.gaps.some((g) => g.id === 'diff-coverage'));
    assert.ok(d.gaps.some((g) => g.id === 'layer:mutation'));
    assert.ok(!d.gaps.some((g) => g.id === 'lockfile'));
  });

  it('parses CI jobs and triggers', () => {
    assert.equal(d.ci.provider, 'github-actions');
    assert.deepEqual(d.ci.triggers, { 'ci.yml': ['pull_request', 'push'] });
    assert.deepEqual(d.ci.jobs.map((j) => [j.id, j.commands, j.kinds]), [
      ['check', ['pnpm install', 'pnpm lint'], ['lint']],
      ['test', ['pnpm test', 'pnpm test:e2e'], ['unit', 'e2e']],
    ]);
  });

  it('reports languages and non-git state', () => {
    assert.deepEqual(d.languages, [{ name: 'typescript', files: 2 }]);
    assert.equal(d.git.isRepo, false);
    assert.ok(d.gaps.some((g) => g.id === 'git'));
    assert.equal(d.docs.h7Excluded, null);
  });
});

describe('fixture: package managers and workspaces fields', () => {
  it('npm workspaces object form, package-lock, no packageManager', () => {
    const d = run({ 'package.json': pkg({ workspaces: { packages: ['pkgs/*'] } }), 'package-lock.json': '', 'pkgs/a/package.json': pkg({ name: 'a', scripts: { build: 'x' } }) });
    assert.deepEqual(d.monorepo?.tools, ['package-workspaces']);
    assert.equal(d.scripts[0]?.run, 'npm --workspace a run build');
  });
  it('yarn and bun workspaces', () => {
    const y = run({ 'package.json': pkg({ workspaces: ['p/*'] }), 'yarn.lock': '', 'p/a/package.json': pkg({ name: 'a', scripts: { t: 'x' } }) });
    assert.equal(y.scripts[0]?.run, 'yarn workspace a run t');
    const b = run({ 'package.json': pkg({ workspaces: ['p/*'] }), 'bun.lock': '', 'p/a/package.json': pkg({ name: 'a', scripts: { t: 'x' } }) });
    assert.equal(b.scripts[0]?.run, 'bun --cwd p/a run t');
  });
  it('lockfile missing falls back to packageManager field then npm', () => {
    const a = run({ 'package.json': pkg({ packageManager: 'yarn@4.0.0' }) });
    assert.deepEqual(a.packageManagers, [{ name: 'yarn', lockfile: null, dir: '.' }]);
    assert.ok(a.gaps.some((g) => g.id === 'lockfile'));
    const b = run({ 'package.json': pkg({ name: 'n' }) });
    assert.equal(b.packageManagers[0]?.name, 'npm');
  });
  it('unparseable and non-object package.json warn', () => {
    const d = run({ 'package.json': '{nope', 'a/package.json': '[]' });
    assert.deepEqual(d.warnings, ['unparseable a/package.json', 'unparseable package.json']);
  });
  it('tolerates odd field shapes', () => {
    const d = run({ 'package.json': pkg({ name: 3, scripts: { a: 1, b: 'x' }, workspaces: 5, bin: 7, dependencies: 'x' }) });
    assert.deepEqual(d.scripts.map((s) => s.name), ['b']);
    assert.equal(d.surfaces.length, 0);
  });
  it('workspaces object without packages', () => {
    assert.equal(run({ 'package.json': pkg({ workspaces: {} }) }).monorepo, null);
  });
  it('workspaces array with non-strings', () => {
    const d = run({ 'package.json': pkg({ workspaces: ['p/*', 3] }), 'p/a/package.json': '{}' });
    assert.equal(d.monorepo?.workspaces[0]?.name, 'p/a');
  });
  it('nx and lerna without workspaces', () => {
    const d = run({ 'nx.json': '{}', 'lerna.json': '{}' });
    assert.deepEqual(d.monorepo, { tools: ['nx', 'lerna'], workspaces: [] });
  });
});

describe('fixture: python poetry', () => {
  const d = run({
    'pyproject.toml': '[tool.poetry]\nname = "x"\n\n[tool.poetry.scripts]\nmycli = "x:main"\n\n[tool.poetry.group.dev.dependencies]\npytest = "*"\npytest-cov = "*"\nhypothesis = "*"\nruff = "*"\nmypy = "*"\nmutmut = "*"\nblack = "*"\n\n[tool.pytest.ini_options]\n\n[tool.coverage.run]\n',
    'poetry.lock': '',
    'x/a.py': '',
    'tests/test_a.py': '',
  });
  it('detects python tools and runner prefix', () => {
    assert.deepEqual(d.languages, [{ name: 'python', files: 2 }]);
    assert.deepEqual(d.packageManagers, [{ name: 'poetry', lockfile: 'poetry.lock', dir: '.' }]);
    assert.deepEqual(layer(d, 'unit').commands, ['poetry run pytest']);
    assert.deepEqual(layer(d, 'lint').tools, ['ruff']);
    assert.deepEqual(layer(d, 'typecheck').commands, ['poetry run mypy .']);
    assert.deepEqual(layer(d, 'mutation').tools, ['mutmut']);
    assert.deepEqual(layer(d, 'property').tools, ['hypothesis']);
    assert.deepEqual(layer(d, 'coverage').tools, ['coverage.py']);
    assert.deepEqual(d.surfaces, [{ kind: 'cli', name: '.', dir: '.', run: 'poetry run mycli', evidence: 'pyproject scripts' }]);
    assert.equal(layer(d, 'e2e').status, 'gap');
  });
  it('other python managers and surfaces', () => {
    const mk = (files: Record<string, string>) => run(files);
    assert.equal(mk({ 'pyproject.toml': '[tool.uv]\n', 'main.py': '' }).packageManagers.length, 0);
    const uv = mk({ 'pyproject.toml': '[project]\nname="a"\ndependencies=["fastapi"]\n', 'uv.lock': '' });
    assert.deepEqual(uv.surfaces[0], { kind: 'api', name: '.', dir: '.', run: null, evidence: 'py:fastapi' });
    assert.ok(uv.gaps.some((g) => g.id === 'surface:.'));
    const pdm = mk({ 'pyproject.toml': '[project]\nname="a"\n', 'pdm.lock': '' });
    assert.equal(pdm.surfaces[0]?.kind, 'library');
    const pipenv = mk({ Pipfile: '[packages]\nflask = "*"\n', 'manage.py': '' });
    assert.equal(pipenv.surfaces[0]?.run, 'pipenv run python manage.py runserver');
    const pdm2 = mk({ 'pyproject.toml': '[tool.pdm]\n[project]\nname="a"\n', 'manage.py': '' });
    assert.equal(pdm2.surfaces[0]?.run, 'pdm run python manage.py runserver');
    const none = mk({ 'requirements.txt': 'requests\n' });
    assert.deepEqual(none.surfaces, []);
  });
});

describe('fixture: rust cargo', () => {
  const d = run({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'Cargo.lock': '',
    'crates/app/Cargo.toml': '[package]\nname = "app"\n\n[dependencies]\naxum = "1"\n\n[dev-dependencies]\nproptest = "1"\n',
    'crates/app/src/main.rs': '',
    'crates/lib/Cargo.toml': '[package]\nname = "lib"\n',
    'crates/lib/src/lib.rs': '',
    'crates/desk/Cargo.toml': '[package]\nname = "desk"\n[dependencies]\ntauri = "1"\n',
    'crates/desk/src/main.rs': '',
    'crates/cli/Cargo.toml': '[package]\nname = "cli"\n[[bin]]\nname = "c"\n',
    'crates/empty/Cargo.toml': '[package]\nname = "empty"\n',
    'crates/other/Cargo.toml': '[package]\n',
  });
  it('detects workspace, toolchain layers, surfaces', () => {
    assert.deepEqual(d.monorepo?.tools, ['cargo-workspace']);
    assert.deepEqual(d.monorepo?.workspaces.map((w) => w.name), ['app', 'cli', 'desk', 'empty', 'lib', 'crates/other']);
    assert.deepEqual(layer(d, 'unit').commands, ['cargo test']);
    assert.deepEqual(layer(d, 'lint').commands, ['cargo clippy --all-targets -- -D warnings']);
    assert.deepEqual(layer(d, 'property').tools, ['proptest']);
    assert.equal(layer(d, 'mutation').recommend, 'cargo-mutants');
    const kinds = Object.fromEntries(d.surfaces.map((s) => [s.name, [s.kind, s.run]]));
    assert.deepEqual(kinds.app, ['api', 'cargo run -p app']);
    assert.deepEqual(kinds.lib, ['library', null]);
    assert.deepEqual(kinds.desk, ['desktop', 'cargo run -p desk']);
    assert.deepEqual(kinds.cli, ['cli', 'cargo run -p cli']);
    assert.equal(kinds.empty, undefined);
  });
  it('root crate runs plain cargo run', () => {
    const r = run({ 'Cargo.toml': '[package]\nname = "solo"\n', 'src/main.rs': '' });
    assert.equal(r.surfaces[0]?.run, 'cargo run');
    assert.equal(r.monorepo, null);
  });
});

describe('fixture: go', () => {
  it('detects modules, mains, work, tools', () => {
    const d = run({
      'go.work': 'go 1.22\n\nuse (\n\t./svc\n\t// c\n\t./lib\n)\nuse ./extra\nuse ./plain\n',
      'svc/go.mod': 'module example.com/svc\n\nrequire github.com/gin-gonic/gin v1.9.0\n',
      'svc/main.go': 'package main\n',
      'svc/x_test.go': 'package main\n',
      'lib/go.mod': 'module example.com/lib\n',
      'lib/lib.go': 'package lib\n',
      'extra/go.mod': 'module example.com/extra\n\nrequire pgregory.net/rapid v1\nrequire github.com/wailsapp/wails/v2 v2\n',
      'extra/cmd/tool/main.go': 'package main\n',
      'extra/cmd/tool/go.mod': 'module example.com/tool\n',
      'extra/other/main.go': 'package other\n',
      'plain/go.mod': '',
      'plain/main.go': 'package main\n',
      '.golangci.yml': '',
    });
    assert.deepEqual(d.monorepo?.tools, ['go-work']);
    assert.deepEqual(d.monorepo?.workspaces.map((w) => w.name), ['example.com/extra', 'example.com/lib', 'plain', 'example.com/svc']);
    const s = (name: string, dir: string) => d.surfaces.find((x) => x.name === name && x.dir === dir);
    assert.deepEqual(s('example.com/svc', 'svc'), { kind: 'api', name: 'example.com/svc', dir: 'svc', run: 'go run ./svc', evidence: 'go:github.com/gin-gonic/gin' });
    assert.equal(s('example.com/lib', 'lib')?.kind, 'library');
    assert.equal(s('example.com/extra', 'extra/cmd/tool'), undefined);
    assert.equal(s('example.com/tool', 'extra/cmd/tool')?.kind, 'cli');
    assert.equal(s('plain/go.mod'.slice(0, 5), 'plain')?.run, 'go run ./plain');
    assert.deepEqual(layer(d, 'unit').commands, ['go test ./...']);
    assert.deepEqual(layer(d, 'property').tools, ['rapid']);
    assert.ok(layer(d, 'lint').tools.includes('golangci-lint'));
  });
  it('root main and desktop', () => {
    const d = run({ 'go.mod': 'module m\nrequire github.com/wailsapp/wails/v2 v2\n', 'main.go': 'package main\n' });
    assert.deepEqual(d.surfaces[0], { kind: 'desktop', name: 'm', dir: '.', run: 'go run .', evidence: 'go:github.com/wailsapp/wails' });
    const n = run({ 'go.mod': 'x\n', 'main.go': 'package main\n' });
    assert.equal(n.surfaces[0]?.name, '.');
  });
});

describe('fixture: empty and no-CI repos', () => {
  it('empty repo reports gaps, never guesses', () => {
    const d = run({});
    assert.deepEqual(d.languages, []);
    assert.ok(d.layers.every((l) => l.status === 'na'));
    assert.deepEqual(d.gaps.map((g) => g.id), ['empty-repo', 'ci', 'git']);
    assert.equal(d.monorepo, null);
    assert.equal(d.ci.provider, null);
    assert.deepEqual(d.surfaces, []);
  });
  it('library only: e2e is n/a, repo without CI is a gap', () => {
    const d = run({ 'package.json': pkg({ main: 'i.js' }), 'package-lock.json': '', 'i.js': '' });
    assert.equal(layer(d, 'e2e').status, 'na');
    assert.match(layer(d, 'e2e').reason as string, /no runnable/);
    assert.ok(d.gaps.some((g) => g.id === 'ci'));
  });
  it('unknown language has gaps without recommendation', () => {
    const d = run({ 'A.java': '', 'B.java': '' });
    assert.equal(layer(d, 'unit').status, 'gap');
    assert.equal(layer(d, 'unit').recommend, null);
  });
  it('typed stack tie-break and extensions', () => {
    const d = run({ 'a.py': '', 'b.go': '' });
    assert.deepEqual(d.languages.map((l) => l.name), ['go', 'python']);
    assert.deepEqual(run({ 'a.rb': '', 'b.go': '', 'c.py': '', 'd.rs': '' }).languages.map((l) => l.name), ['go', 'python', 'ruby', 'rust']);
  });
  it('other CI providers are listed but flagged unparsed', () => {
    const d = run({ '.gitlab-ci.yml': 'x', Jenkinsfile: '', 'a.py': '' });
    assert.deepEqual(d.ci.providers, ['gitlab-ci', 'jenkins']);
    assert.equal(d.ci.parsed, false);
    assert.ok(d.gaps.some((g) => g.id === 'ci-unparsed'));
  });
});

describe('fixture: targets', () => {
  it('make, just, task', () => {
    const d = run({
      Makefile: '.PHONY: a\nVAR := 1\ntest:\n\tpytest --cov\nlint: test\n\truff check .\nbuild/out:\n\ttrue\n',
      justfile: 'set shell := ["sh"]\nalias b := build\nbuild target="x":\n  cargo build\n@fmt:\n  cargo fmt\nx := "1"\n',
      'Taskfile.yml': 'version: 3\ntasks:\n  check:\n    cmds: [x]\n  e2e:test:\n    cmds: [y]\nother:\n  z: 1\n',
      'Taskfile.yaml': 'tasks: {}\n',
    });
    const names = (src: string) => d.scripts.filter((s) => s.source === src).map((s) => s.name);
    assert.deepEqual(names('make'), ['test', 'lint', 'build/out']);
    assert.deepEqual(names('just'), ['build', 'fmt']);
    assert.deepEqual(names('task'), ['check', 'e2e:test']);
    assert.equal(d.scripts.find((s) => s.name === 'lint')?.run, 'make lint');
    assert.equal(d.scripts.find((s) => s.name === 'check')?.kind, 'check');
    assert.ok(layer(d, 'coverage').tools.length > 0);
  });
});

describe('git detection', () => {
  it('real repo: branches, convention, redacted remote, exclude', { ...SLOW }, () => {
    const dir = tmpDir();
    initRepo(dir);
    for (const m of ['feat: a', 'fix(x): b', 'chore!: c', 'wip']) {
      writeFileSync(join(dir, 'f.txt'), m);
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', m);
    }
    git(dir, 'branch', 'develop');
    git(dir, 'branch', 'feature/x');
    git(dir, 'remote', 'add', 'origin', 'https://user:secret@github.com/o/r.git');
    writeFileSync(join(dir, 'dirty.txt'), 'x');
    const d = detect(dir);
    assert.equal(d.git.isRepo, true);
    assert.equal(d.git.branch, 'main');
    assert.equal(d.git.dirty, true);
    assert.deepEqual(d.git.defaultBranch, { name: 'main', source: 'local-branch' });
    assert.deepEqual(d.git.protectedBranches, ['develop', 'main']);
    assert.deepEqual(d.git.remote, { url: 'https://github.com/o/r.git', host: 'github.com' });
    assert.equal(d.git.commitConvention.kind, 'conventional');
    assert.equal(d.git.commitConvention.sampled, 5);
    assert.equal(d.git.commitConvention.matching, 3);
    assert.equal(d.docs.h7Excluded, false);
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.h7/\n');
    assert.equal(detect(dir).docs.h7Excluded, true);
    assert.ok(!JSON.stringify(d).includes('secret'));
  });

  it('origin HEAD wins; detached head; no commits', { ...SLOW }, () => {
    const dir = tmpDir();
    git(dir, 'init', '-q', '-b', 'trunk');
    const empty = detect(dir);
    assert.equal(empty.git.defaultBranch, null);
    assert.equal(empty.git.commitConvention.kind, 'unknown');
    assert.ok(empty.gaps.some((g) => g.id === 'default-branch'));
    assert.ok(empty.gaps.some((g) => g.id === 'commit-convention'));
  });

  it('fake runner covers origin head, timeout and remote hosts', () => {
    const answers: Record<string, string> = {
      'rev-parse --show-toplevel': '/r',
      'branch --show-current': '',
      'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/dev',
      'branch -r --format=%(refname:short)': 'origin/HEAD\norigin\norigin/release/1.0\norigin/feat',
      'rev-parse --git-path info/exclude': '/nonexistent/exclude',
      'log -n30 --format=%s': 'a\nb\nc\nd',
    };
    const runner: Runner = (args) => {
      const key = args.join(' ');
      if (key === 'status --porcelain') throw new Error('timeout');
      return key in answers ? { status: 0, stdout: `${answers[key]}\n` } : { status: 1, stdout: '' };
    };
    const d = detect(tmpDir(), runner);
    assert.equal(d.git.branch, null);
    assert.deepEqual(d.git.defaultBranch, { name: 'dev', source: 'origin-head' });
    assert.deepEqual(d.git.protectedBranches, ['release/1.0']);
    assert.equal(d.git.dirty, false);
    assert.equal(d.git.commitConvention.kind, 'other');
    assert.equal(d.docs.h7Excluded, null);
  });

  it('classifyCommits thresholds', () => {
    assert.equal(classifyCommits(['feat: a', 'fix: b']).kind, 'unknown');
    assert.equal(classifyCommits(['feat: a', 'fix: b', 'x']).kind, 'conventional');
    assert.equal(classifyCommits(['feat: a', 'x', 'y']).kind, 'other');
    assert.equal(classifyCommits(['feat: a', 'x', 'y', 'z', 'feat: q']).kind, 'other');
    assert.deepEqual(classifyCommits(['a', 'b', 'c', 'd']).examples, ['a', 'b', 'c']);
    assert.equal(classifyCommits(['feat:x', 'feat: ', 'feat(a) b']).matching, 0);
  });

  it('redactUrl and remoteHost', () => {
    assert.equal(redactUrl('https://tok@github.com/a/b'), 'https://github.com/a/b');
    assert.equal(redactUrl('git@github.com:a/b.git'), 'git@github.com:a/b.git');
    assert.equal(remoteHost('git@github.com:a/b.git'), 'github.com');
    assert.equal(remoteHost('ssh://git@host.example:22/a'), 'host.example');
    assert.equal(remoteHost('https://gitlab.com/a/b'), 'gitlab.com');
    assert.equal(remoteHost('nonsense'), null);
    assert.equal(redactUrl('https://user:p@ss@github.com/a/b'), 'https://github.com/a/b');
    assert.equal(redactUrl('https://tok@github.com'), 'https://github.com/');
    assert.equal(redactUrl('https://github.com/a/b'), 'https://github.com/a/b');
    assert.equal(redactUrl('https://u:p@@@host/x y'), 'https://host/x%20y');
    assert.equal(redactUrl('https://bad host:p@ss@h/x'), 'https://h/x');
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9]{1,8}$/), fc.stringMatching(/^[a-z0-9@:]{0,8}$/), (user, pass) => redactUrl(`https://${user}:${pass}@h.com/x`) === 'https://h.com/x'));
  });
});

describe('docs detection', () => {
  it('reads AGENTS.md, CLAUDE.md, ADRs, verify skills', () => {
    const d = run({
      'AGENTS.md': 'a\r\nb\r\n<!-- h7:begin -->\nx\n<!-- h7:end -->\r\n',
      'CLAUDE.md': 'hi\n@AGENTS.md\n',
      'docs/CONTEXT.md': '',
      'docs/adr/README.md': '',
      'docs/adr/0001-a.md': '',
      'docs/adr/0002-b.txt': '',
      'docs/agents/verification.md': '',
      '.claude/skills/verify-web/SKILL.md': '',
      '.claude/skills/other/SKILL.md': '',
    });
    assert.deepEqual(d.docs.agentsMd, { exists: true, lines: 5, hasH7Block: true });
    assert.deepEqual(d.docs.claudeMd, { exists: true, importsAgents: true });
    assert.equal(d.docs.contextMd, true);
    assert.equal(d.docs.adrDir, 'docs/adr');
    assert.equal(d.docs.adrCount, 1);
    assert.equal(d.docs.verificationMd, true);
    assert.deepEqual(d.docs.verifySkills, ['verify-web']);
  });
  it('absent docs and half block', () => {
    const d = run({ 'AGENTS.md': '<!-- h7:begin -->\n', 'CLAUDE.md': 'no import\n', 'CONTEXT.md': '' });
    assert.equal(d.docs.agentsMd.hasH7Block, false);
    assert.equal(d.docs.claudeMd.importsAgents, false);
    assert.equal(d.docs.contextMd, true);
    assert.equal(d.docs.adrDir, null);
    assert.equal(d.docs.adrCount, 0);
    const e = run({ 'AGENTS.md': '' });
    assert.equal(e.docs.agentsMd.lines, 0);
    assert.equal(e.docs.claudeMd.exists, false);
  });
});

describe('scan limits', () => {
  it('truncates at maxFiles and depth, skips vendored dirs, survives unreadable dirs', () => {
    const dir = tmpDir();
    writeTree(dir, { 'a.txt': '', 'b.txt': '', 'c.txt': '', 'node_modules/x/y.js': '', 'd1/d2/d3/deep.txt': '', 'd1/top.txt': '' });
    const limits: Limits = { maxDepth: 2, maxFiles: 100 };
    const r = openRepo(dir, limits);
    assert.deepEqual(r.files, ['a.txt', 'b.txt', 'c.txt', 'd1/top.txt']);
    assert.equal(r.truncated, false);
    assert.equal(r.read('missing'), null);
    assert.equal(r.read('a.txt'), '');
    const t = openRepo(dir, { maxDepth: 4, maxFiles: 2 });
    assert.equal(t.files.length, 2);
    assert.equal(t.truncated, true);
    const exact = openRepo(dir, { maxDepth: 4, maxFiles: 5 });
    assert.equal(exact.truncated, false);
    const bad = openRepo(dir, limits, () => {
      throw new Error('EACCES');
    });
    assert.deepEqual(bad.files, []);
    const d = detect(dir, noGit, { maxDepth: 4, maxFiles: 2 });
    assert.ok(d.gaps.some((g) => g.id === 'scan-truncated'));
    assert.equal(d.scan.truncated, true);
  });
});

describe('CI parsing', () => {
  it('trigger forms', () => {
    assert.deepEqual(workflowTriggers('name: x\non: push\n'), ['push']);
    assert.deepEqual(workflowTriggers('on: [push, "pull_request"]  # c\n'), ['push', 'pull_request']);
    assert.deepEqual(workflowTriggers('"on":\n  # c\n  push:\n    branches: [a]\n\n  workflow_dispatch:\njobs:\n'), ['push', 'workflow_dispatch']);
    assert.deepEqual(workflowTriggers('on:\n  - push\n  - pull_request\n'), ['push', 'pull_request']);
    assert.deepEqual(workflowTriggers('jobs: {}\n'), []);
  });
  it('jobs: uses, quoted and block runs, comments, nested keys', () => {
    const text = [
      'jobs:',
      '  # comment',
      '  call:',
      '    uses: ./.github/workflows/x.yml',
      '    with:',
      '      a: 1',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      "      - run: 'npm test' # trailing",
      '      - name: multi',
      '        run: >-',
      '          npm run lint',
      '          # skip',
      '',
      '          npm run build',
      '      - run: |',
      '      - run: echo done',
      'other: 1',
      'jobs2:',
      '  nope:',
    ].join('\n');
    const jobs = workflowJobs('f.yml', text);
    assert.deepEqual(jobs.map((j) => [j.id, j.uses, j.commands]), [
      ['call', './.github/workflows/x.yml', []],
      ['build', null, ['npm test', 'npm run lint', 'npm run build', 'echo done']],
    ]);
    assert.deepEqual(jobs[1]?.kinds, ['unit', 'lint', 'build']);
  });
  it('stray content under jobs before any job is ignored', () => {
    assert.deepEqual(workflowJobs('f', 'jobs:\n    run: x\n'), []);
  });
});

describe('helpers', () => {
  it('tokens, toml, yaml, glob', () => {
    assert.deepEqual(tokens('Foo_bar = "pytest-cov"\nFoo-bar'), ['foo-bar', 'pytest-cov']);
    assert.deepEqual(tokens('!!'), []);
    assert.equal(tomlSection('[a]\nx=1\n[b]\ny=2', 'a'), 'x=1');
    assert.equal(tomlSection('[a]\nx=1', 'z'), null);
    assert.deepEqual(tomlSections('[a.b]\n[[c]]\nx = [1]\n'), ['a.b', 'c']);
    assert.deepEqual(yamlList('packages:\n  - "a/*" # c\n  - b\nx:\n  - c\n', 'packages'), ['a/*', 'b']);
    assert.deepEqual(yamlList('  packages:\n  - a\n', 'packages'), []);
    assert.ok(globToRegex('apps/*').test('apps/web'));
    assert.ok(!globToRegex('apps/*').test('apps/web/x'));
    assert.ok(globToRegex('./libs/**').test('libs/a/b'));
    assert.ok(globToRegex('a.b/').test('a.b'));
    assert.ok(!globToRegex('a.b').test('axb'));
  });
  it('kinds', () => {
    assert.equal(kindOf('dev', ''), 'dev');
    assert.equal(kindOf('verify', ''), 'check');
    assert.equal(kindOf('lint:fix', 'eslint --fix'), 'lint');
    assert.equal(kindOf('x', 'vitest run --coverage'), 'coverage');
    assert.equal(kindOf('test', 'playwright test'), 'e2e');
    assert.equal(kindOf('check-all', 'tsc'), 'typecheck');
    assert.equal(kindOf('test', 'vitest'), 'unit');
    assert.equal(kindOf('lint', 'vitest --coverage'), 'lint');
    assert.equal(kindOf('x', 'y'), null);
    assert.equal(kindOf('migrate', 'x'), 'deploy');
    assert.deepEqual(kindsOfCommand('pnpm lint && pnpm test'), ['lint', 'unit']);
    assert.equal(mutates('format', 'prettier --write .'), true);
    assert.equal(mutates('lint:fix', 'eslint .'), true);
    assert.equal(mutates('format', 'prettier --write . --check'), false);
    assert.equal(mutates('lint', 'eslint .'), false);
  });
  it('findTools matches signals and fills python prefix', () => {
    const f = findTools(['py:pytest', 'dep:jest', 'cmd:node --test x.ts', 'cmd:cargo llvm-cov', 'cmd:go test -cover ./...', 'cmd:diff-cover a'], 'uv run ');
    assert.deepEqual(f.tools.map((t) => `${t.layer}:${t.name}`).sort(), ['coverage:cargo-llvm-cov', 'coverage:diff-cover', 'coverage:go cover', 'coverage:jest', 'unit:jest', 'unit:node:test', 'unit:pytest']);
    assert.deepEqual(f.commands.get('unit'), ['uv run pytest']);
    assert.deepEqual(findTools([], '').tools, []);
  });
  it('property: detection never throws on arbitrary package.json content', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const d = run({ 'package.json': JSON.stringify(value) });
        return Array.isArray(d.gaps);
      }),
      { numRuns: 25 },
    );
  });
});

describe('CLI', () => {
  it('main prints JSON for a directory and errors for a non-directory', () => {
    const dir = tmpDir();
    let out = '';
    assert.equal(main([dir], (t) => (out += t), () => {}, noGit), 0);
    assert.equal((JSON.parse(out) as Detection).root, dir);
    let err = '';
    assert.equal(main([join(dir, 'nope')], () => {}, (t) => (err += t), noGit), 2);
    assert.match(err, /not a directory/);
    assert.equal(main([], () => {}, () => {}, noGit), 0);
  });
  it('runs as a script', { ...SLOW }, () => {
    const dir = tmpDir();
    const r = runNode(join(import.meta.dirname, '../../plugins/h7/scripts/detect.ts'), [dir]);
    assert.equal(r.status, 0);
    assert.equal((JSON.parse(r.stdout) as Detection).root, dir);
    const bad = runNode(join(import.meta.dirname, '../../plugins/h7/scripts/detect.ts'), [join(dir, 'missing')]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /not a directory/);
  });
});
