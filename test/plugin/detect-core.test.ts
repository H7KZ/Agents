import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detect, main, type Detection } from '../../plugins/h7/scripts/detect.ts';
import type { Limits } from '../../plugins/h7/scripts/detect-fs.ts';
import type { Runner } from '../../plugins/h7/scripts/git.ts';
import { cleanupTmp, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const noGit: Runner = () => ({ status: 128, stdout: '' });

/** A repository that answers only the listed git questions. */
const gitWith = (answers: Record<string, string>): Runner => (args) => {
  const key = args.join(' ');
  return key in answers ? { status: 0, stdout: `${answers[key]}\n` } : { status: 1, stdout: '' };
};

function run(files: Record<string, string>, runner: Runner = noGit, limits?: Limits): Detection {
  const dir = tmpDir();
  writeTree(dir, files);
  return limits === undefined ? detect(dir, runner) : detect(dir, runner, limits);
}

const pkg = (o: object): string => JSON.stringify(o);
const layer = (d: Detection, id: string) => d.layers.find((l) => l.layer === id)!;

describe('detect: languages and stacks', () => {
  it('maps every known extension to its language and counts files', () => {
    const exts = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'rb', 'php', 'cs', 'swift', 'c', 'h', 'cpp', 'cc', 'hpp'];
    const d = run(Object.fromEntries([...exts.map((e) => [`f/a.${e}`, '']), ['f/a.txt', ''], ['f/Makefile', ''], ['f/noext', '']]));
    assert.deepEqual(d.languages, [
      { name: 'javascript', files: 4 },
      { name: 'typescript', files: 4 },
      { name: 'cpp', files: 3 },
      { name: 'c', files: 2 },
      { name: 'csharp', files: 1 },
      { name: 'go', files: 1 },
      { name: 'java', files: 1 },
      { name: 'kotlin', files: 1 },
      { name: 'php', files: 1 },
      { name: 'python', files: 1 },
      { name: 'ruby', files: 1 },
      { name: 'rust', files: 1 },
      { name: 'swift', files: 1 },
    ]);
    assert.equal(d.scan.files, exts.length + 3);
  });

  it('the stack is the one with the most files, typescript and javascript together', () => {
    const d = run({ 'a.ts': '', 'b.js': '', 'c.mjs': '', 'd.cts': '', 'e.py': '', 'f.py': '', 'g.py': '' });
    assert.equal(layer(d, 'lint').recommend, 'eslint (or biome)');
    const py = run({ 'a.ts': '', 'b.py': '', 'c.py': '' });
    assert.equal(layer(py, 'lint').recommend, 'ruff');
  });

  const REC: Record<string, Record<string, string>> = {
    'a.ts': { lint: 'eslint (or biome)', typecheck: 'typescript (tsc --noEmit)', format: 'prettier (or biome)', unit: 'vitest', coverage: '@vitest/coverage-v8 (or c8)', mutation: '@stryker-mutator/core', property: 'fast-check' },
    'a.py': { lint: 'ruff', typecheck: 'mypy (or pyright)', format: 'ruff format (or black)', unit: 'pytest', coverage: 'pytest-cov', mutation: 'mutmut', property: 'hypothesis' },
    'a.rs': { lint: 'clippy (cargo clippy)', typecheck: 'cargo check', format: 'rustfmt (cargo fmt)', unit: 'cargo test', coverage: 'cargo-llvm-cov', mutation: 'cargo-mutants', property: 'proptest' },
    'a.go': { lint: 'golangci-lint', typecheck: 'go vet', format: 'gofmt', unit: 'go test', coverage: 'go test -cover', mutation: 'go-mutesting (immature; owner decides)', property: 'rapid' },
  };
  for (const [file, expected] of Object.entries(REC)) {
    it(`recommendations for the ${file} stack`, () => {
      const d = run({ [file]: '' });
      for (const [id, rec] of Object.entries(expected)) {
        assert.equal(layer(d, id).status, 'gap', id);
        assert.equal(layer(d, id).recommend, rec, id);
      }
      assert.deepEqual(layer(d, 'e2e'), { layer: 'e2e', status: 'na', tools: [], commands: [], recommend: null, reason: 'no runnable app surface (web, api, cli, desktop)' });
    });
  }

  it('e2e recommendations when a runnable surface exists', () => {
    const e2e = (files: Record<string, string>) => layer(run(files), 'e2e');
    assert.equal(e2e({ 'package.json': pkg({ bin: 'cli.js' }), 'a.ts': '' }).recommend, '@playwright/test');
    assert.equal(e2e({ 'pyproject.toml': '[project.scripts]\ntool = "x:y"\n', 'a.py': '' }).recommend, 'pytest-playwright');
    assert.equal(e2e({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/main.rs': '' }).recommend, 'integration tests under tests/ driving the built binary');
    assert.equal(e2e({ 'go.mod': 'module x\n', 'main.go': 'package main\n' }).recommend, 'go test with an integration build tag');
  });

  it('an unknown stack recommends nothing; no source files makes every layer n/a', () => {
    const java = run({ 'A.java': '' });
    assert.deepEqual(layer(java, 'unit'), { layer: 'unit', status: 'gap', tools: [], commands: [], recommend: null, reason: null });
    const empty = run({ 'README.md': '' });
    assert.deepEqual(layer(empty, 'unit'), { layer: 'unit', status: 'na', tools: [], commands: [], recommend: null, reason: 'no source files detected' });
    assert.deepEqual(layer(empty, 'e2e').reason, 'no source files detected');
  });

  it('found layers list their tools without a recommendation', () => {
    const d = run({ 'package.json': pkg({ devDependencies: { vitest: '1', jest: '1' } }), 'a.ts': '' });
    assert.deepEqual(layer(d, 'unit'), { layer: 'unit', status: 'found', tools: ['vitest', 'jest'], commands: [], recommend: null, reason: null });
    assert.deepEqual(layer(d, 'coverage').tools, ['jest']);
  });
});

describe('detect: gaps', () => {
  it('a bare typescript file', () => {
    const d = run({ 'a.ts': '' });
    assert.deepEqual(d.gaps, [
      { id: 'layer:lint', message: 'no linter', recommend: 'eslint (or biome)' },
      { id: 'layer:typecheck', message: 'no type checker', recommend: 'typescript (tsc --noEmit)' },
      { id: 'layer:format', message: 'no formatter', recommend: 'prettier (or biome)' },
      { id: 'layer:unit', message: 'no unit test runner', recommend: 'vitest' },
      { id: 'layer:coverage', message: 'no coverage tool', recommend: '@vitest/coverage-v8 (or c8)' },
      { id: 'layer:mutation', message: 'no mutation tool', recommend: '@stryker-mutator/core' },
      { id: 'layer:property', message: 'no property-based testing library', recommend: 'fast-check' },
      { id: 'ci', message: 'no CI detected', recommend: null },
      { id: 'git', message: 'not a git repository', recommend: null },
    ]);
  });

  it('e2e is a gap when a runnable surface exists', () => {
    const d = run({ 'package.json': pkg({ bin: 'cli.js' }), 'a.ts': '' });
    assert.deepEqual(d.gaps.find((g) => g.id === 'layer:e2e'), { id: 'layer:e2e', message: 'no e2e tooling', recommend: '@playwright/test' });
  });

  it('e2e needs only one runnable surface among several', () => {
    const d = run({ 'package.json': pkg({ main: 'i.js' }), 'cli/package.json': pkg({ name: 'cli', bin: 'c.js' }), 'a.ts': '' });
    assert.equal(layer(d, 'e2e').status, 'gap');
  });

  it('empty repository', () => {
    assert.deepEqual(run({}).gaps, [
      { id: 'empty-repo', message: 'no source files or manifests detected', recommend: null },
      { id: 'ci', message: 'no CI detected', recommend: null },
      { id: 'git', message: 'not a git repository', recommend: null },
    ]);
  });

  it('coverage without diff coverage', () => {
    const files = { 'package.json': pkg({ devDependencies: { c8: '1' } }), 'a.js': '' };
    const gap = run(files).gaps.find((g) => g.id === 'diff-coverage');
    assert.deepEqual(gap, { id: 'diff-coverage', message: 'no diff-coverage command (100% line+branch on changed lines)', recommend: 'diff-cover <lcov or cobertura report> --compare-branch=<default branch>' });
    assert.equal(run({ ...files, 'ci.sh': '', '.github/workflows/c.yml': 'on: push\njobs:\n  a:\n    steps:\n      - run: diff-cover cov.xml\n' }).gaps.some((g) => g.id === 'diff-coverage'), false);
    assert.equal(run({ 'a.js': '' }).gaps.some((g) => g.id === 'diff-coverage'), false);
  });

  it('unparsed CI names the provider and files', () => {
    const d = run({ '.gitlab-ci.yml': '', Jenkinsfile: '', 'a.py': '' });
    assert.deepEqual(d.gaps.find((g) => g.id === 'ci-unparsed'), { id: 'ci-unparsed', message: 'CI provider gitlab-ci found but its jobs are not parsed; read .gitlab-ci.yml, Jenkinsfile', recommend: null });
    assert.equal(d.gaps.some((g) => g.id === 'ci'), false);
    const parsed = run({ '.github/workflows/a.yml': 'on: push\n', 'a.py': '' });
    assert.equal(parsed.gaps.some((g) => g.id === 'ci' || g.id === 'ci-unparsed'), false);
  });

  it('runnable surfaces without a run command', () => {
    const d = run({ 'api/pyproject.toml': '[project]\ndependencies = ["fastapi"]\n', 'cli/package.json': pkg({ name: 'cli', bin: 'c.js' }), 'lib/package.json': pkg({ name: 'lib', main: 'i.js' }), 'a.py': '' });
    assert.deepEqual(d.gaps.filter((g) => g.id.startsWith('surface:')), [{ id: 'surface:api', message: 'api surface api (api) has no derivable run command', recommend: null }]);
  });

  it('a package.json without a root lock file', () => {
    assert.deepEqual(run({ 'package.json': pkg({}) }).gaps.find((g) => g.id === 'lockfile'), { id: 'lockfile', message: 'package.json without a root lockfile', recommend: null });
    assert.equal(run({ 'package.json': pkg({}), 'yarn.lock': '' }).gaps.some((g) => g.id === 'lockfile'), false);
    assert.equal(run({ 'package.json': pkg({}), 'Cargo.lock': '' }).gaps.some((g) => g.id === 'lockfile'), true);
    assert.equal(run({ 'package.json': pkg({}), 'sub/yarn.lock': '' }).gaps.some((g) => g.id === 'lockfile'), true);
    assert.equal(run({ 'a.py': '' }).gaps.some((g) => g.id === 'lockfile'), false);
  });

  it('git gaps only for a repository, and only for what is unknown', () => {
    const repo = gitWith({ 'rev-parse --show-toplevel': '/r' });
    const d = run({ 'a.py': '' }, repo);
    assert.deepEqual(d.gaps.filter((g) => ['git', 'default-branch', 'commit-convention'].includes(g.id)), [
      { id: 'default-branch', message: 'default branch unknown (no origin/HEAD, no local main or master)', recommend: null },
      { id: 'commit-convention', message: 'commit convention unknown (fewer than 3 commits)', recommend: null },
    ]);
    const known = run({ 'a.py': '' }, gitWith({ 'rev-parse --show-toplevel': '/r', 'branch --format=%(refname:short)': 'main', 'log -n30 --format=%s': 'feat: a\nfeat: b\nfeat: c' }));
    assert.equal(known.gaps.some((g) => ['git', 'default-branch', 'commit-convention'].includes(g.id)), false);
    const other = run({ 'a.py': '' }, gitWith({ 'rev-parse --show-toplevel': '/r', 'branch --format=%(refname:short)': 'main', 'log -n30 --format=%s': 'x\ny\nz' }));
    assert.equal(other.gaps.some((g) => g.id === 'commit-convention'), false);
  });

  it('a truncated scan says where it stopped', () => {
    const d = run({ 'a.txt': '', 'b.txt': '', 'c.txt': '' }, noGit, { maxDepth: 4, maxFiles: 2 });
    assert.deepEqual(d.gaps.find((g) => g.id === 'scan-truncated'), { id: 'scan-truncated', message: 'scan stopped at 2 files; results may be incomplete', recommend: null });
    assert.equal(run({ 'a.txt': '' }).gaps.some((g) => g.id === 'scan-truncated'), false);
  });
});

describe('detect: package managers', () => {
  it('every lock file names its manager', () => {
    const locks: Record<string, string> = {
      'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'package-lock.json': 'npm', 'bun.lock': 'bun', 'bun.lockb': 'bun',
      'poetry.lock': 'poetry', 'uv.lock': 'uv', 'pdm.lock': 'pdm', 'Pipfile.lock': 'pipenv', 'Cargo.lock': 'cargo', 'go.sum': 'go', 'Gemfile.lock': 'bundler', 'composer.lock': 'composer',
    };
    const d = run(Object.fromEntries(Object.keys(locks).map((l) => [`d/${l}`, ''])));
    assert.deepEqual(Object.fromEntries(d.packageManagers.map((p) => [p.lockfile?.replace('d/', ''), p.name])), locks);
    assert.ok(d.packageManagers.every((p) => p.dir === 'd'));
  });

  it('a root package without a lock file takes its manager from packageManager, else npm', () => {
    assert.deepEqual(run({ 'package.json': pkg({ packageManager: 'yarn@4.1.0' }) }).packageManagers, [{ name: 'yarn', lockfile: null, dir: '.' }]);
    assert.deepEqual(run({ 'package.json': pkg({}) }).packageManagers, [{ name: 'npm', lockfile: null, dir: '.' }]);
    assert.deepEqual(run({ 'package.json': pkg({ packageManager: 'pnpm@9' }), 'bun.lockb': '' }).packageManagers, [{ name: 'bun', lockfile: 'bun.lockb', dir: '.' }]);
    assert.deepEqual(run({ 'package.json': pkg({ packageManager: 'pnpm@9' }), 'Cargo.lock': '' }).packageManagers, [{ name: 'cargo', lockfile: 'Cargo.lock', dir: '.' }, { name: 'pnpm', lockfile: null, dir: '.' }]);
    assert.deepEqual(run({ 'package.json': pkg({}), 'sub/yarn.lock': '' }).packageManagers, [{ name: 'yarn', lockfile: 'sub/yarn.lock', dir: 'sub' }, { name: 'npm', lockfile: null, dir: '.' }]);
    assert.deepEqual(run({ 'sub/package.json': pkg({}) }).packageManagers, []);
  });
});

describe('detect: monorepo', () => {
  it('lists every tool in a fixed order', () => {
    const d = run({
      'package.json': pkg({ workspaces: ['pkgs/*'] }),
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n',
      'turbo.json': '{}',
      'nx.json': '{}',
      'lerna.json': '{}',
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'go.work': 'use ./svc\n',
      'svc/go.mod': 'module example.com/svc\n',
    });
    assert.deepEqual(d.monorepo?.tools, ['pnpm-workspaces', 'package-workspaces', 'turbo', 'nx', 'lerna', 'cargo-workspace', 'go-work']);
  });

  it('single tools', () => {
    assert.deepEqual(run({ 'lerna.json': '{}' }).monorepo?.tools, ['lerna']);
    assert.deepEqual(run({ 'nx.json': '{}' }).monorepo?.tools, ['nx']);
    assert.equal(run({ 'package.json': pkg({ workspaces: [] }) }).monorepo, null);
    assert.equal(run({ 'package.json': pkg({}) }).monorepo, null);
    assert.equal(run({ 'a/Cargo.toml': '[workspace]\nmembers = ["b"]\n', 'a/b/Cargo.toml': '[package]\nname = "b"\n' }).monorepo, null);
  });

  it('node workspaces: patterns, negations, root exclusion', () => {
    const d = run({
      'package.json': pkg({ name: 'root', workspaces: ['apps/*', '!apps/skip'] }),
      'pnpm-workspace.yaml': 'packages:\n  - "libs/*"\n  - "!libs/hidden"\n',
      'apps/a/package.json': pkg({ name: 'a' }),
      'apps/skip/package.json': pkg({ name: 'skip' }),
      'libs/l/package.json': pkg({ name: 'l' }),
      'libs/hidden/package.json': pkg({ name: 'hidden' }),
      'other/o/package.json': pkg({ name: 'o' }),
    });
    assert.deepEqual(d.monorepo?.workspaces, [
      { dir: 'apps/a', name: 'a', kind: 'node' },
      { dir: 'libs/l', name: 'l', kind: 'node' },
    ]);
    const star = run({ 'package.json': pkg({ name: 'root', workspaces: ['*'] }), 'x/package.json': pkg({ name: 'x' }) });
    assert.deepEqual(star.monorepo?.workspaces.map((w) => w.dir), ['x']);
  });

  it('cargo and go workspaces take their names, falling back to the directory', () => {
    const d = run({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'crates/a/Cargo.toml': '[package]\nname = "a"\n',
      'crates/virtual/Cargo.toml': '[workspace]\n',
      'elsewhere/Cargo.toml': '[package]\nname = "e"\n',
      'go.work': 'use ./svc\nuse ./anon\n',
      'svc/go.mod': 'module example.com/svc\n',
      'anon/go.mod': 'go 1.22\n',
      'unused/go.mod': 'module u\n',
    });
    assert.deepEqual(d.monorepo?.workspaces, [
      { dir: 'crates/a', name: 'a', kind: 'cargo' },
      { dir: 'crates/virtual', name: 'crates/virtual', kind: 'cargo' },
      { dir: 'anon', name: 'anon', kind: 'go' },
      { dir: 'svc', name: 'example.com/svc', kind: 'go' },
    ].sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'cargo' ? -1 : 1)));
  });

  it('a nested workspace manifest is not the workspace root', () => {
    const d = run({ 'sub/Cargo.toml': '[workspace]\nmembers = ["x"]\n', 'sub/x/Cargo.toml': '[package]\nname = "x"\n', 'turbo.json': '{}' });
    assert.deepEqual(d.monorepo?.tools, ['turbo']);
    assert.deepEqual(d.monorepo?.workspaces, []);
  });
});

describe('detect: scripts', () => {
  it('skips lifecycle scripts, but keeps look-alikes', () => {
    const scripts: Record<string, string> = { install: 'a', postinstall: 'a', preinstall: 'a', prepare: 'a', prepublish: 'a', prepublishOnly: 'a', postpublish: 'a', build: 'b', prebuild: 'p', postbuild: 'p', pretest: 'q', myposttest: 'r', xpretest: 's', test: 't', predeploy: 'u', undefined: 'v' };
    const d = run({ 'package.json': pkg({ scripts }), 'package-lock.json': '' });
    assert.deepEqual(d.scripts.map((s) => s.name), ['build', 'myposttest', 'xpretest', 'test', 'predeploy', 'undefined']);
  });

  it('an undefined-named script does not hide scripts without a pre or post', () => {
    const d = run({ 'package.json': pkg({ scripts: { undefined: 'x', build: 'y' } }) });
    assert.deepEqual(d.scripts.map((s) => s.name), ['undefined', 'build']);
  });

  it('run commands per package manager, workspace and directory', () => {
    const ws = (lock: string, pm?: string) => run({
      'package.json': pkg({ name: 'root', workspaces: ['apps/*'], scripts: { r: 'x' }, ...(pm === undefined ? {} : { packageManager: pm }) }),
      [lock]: '',
      'apps/a/package.json': pkg({ name: '@x/a', scripts: { t: 'x' } }),
      'tools/b/package.json': pkg({ name: 'b', scripts: { t: 'x' } }),
    }).scripts.map((s) => s.run);
    assert.deepEqual(ws('pnpm-lock.yaml'), ['pnpm --filter @x/a run t', 'pnpm run r', 'cd tools/b && pnpm run t']);
    assert.deepEqual(ws('package-lock.json'), ['npm --workspace @x/a run t', 'npm run r', 'cd tools/b && npm run t']);
    assert.deepEqual(ws('yarn.lock'), ['yarn workspace @x/a run t', 'yarn run r', 'cd tools/b && yarn run t']);
    assert.deepEqual(ws('bun.lock'), ['bun --cwd apps/a run t', 'bun run r', 'cd tools/b && bun run t']);
  });

  it('kinds and mutation flags of package scripts and make targets', () => {
    const d = run({
      'package.json': pkg({ scripts: { lint: 'eslint .', 'lint:fix': 'eslint . --fix', dev: 'vite', test: 'vitest' } }),
      Makefile: 'foo:\n\ttrue\nlint:\n\tx\nformat-fix:\n\tx\n',
    });
    const by = (n: string, src: string) => d.scripts.find((s) => s.name === n && s.source === src);
    assert.deepEqual([by('lint', 'package.json')?.kind, by('lint', 'package.json')?.mutates], ['lint', false]);
    assert.deepEqual([by('lint:fix', 'package.json')?.kind, by('lint:fix', 'package.json')?.mutates], ['lint', true]);
    assert.equal(by('dev', 'package.json')?.kind, 'dev');
    assert.deepEqual(by('foo', 'make'), { source: 'make', dir: '.', package: null, name: 'foo', command: 'make foo', run: 'make foo', kind: null, mutates: false });
    assert.deepEqual([by('lint', 'make')?.kind, by('lint', 'make')?.mutates], ['lint', false]);
    assert.deepEqual([by('format-fix', 'make')?.kind, by('format-fix', 'make')?.mutates], ['format', true]);
  });

  it('layer commands come from non-mutating scripts of that kind, de-duplicated, then toolchain commands', () => {
    const d = run({
      'package.json': pkg({ scripts: { lint: 'eslint .', 'lint:fix': 'eslint . --fix', 'lint:ci': 'eslint .', test: 'vitest' } }),
      'package-lock.json': '',
      'a.py': '',
      'pyproject.toml': '[tool.ruff]\n',
    });
    assert.deepEqual(layer(d, 'lint').commands, ['npm run lint', 'npm run lint:ci', 'ruff check .']);
    assert.deepEqual(layer(d, 'unit').commands, ['npm run test']);
  });

  it('a make target named like a tool is not a signal for it', () => {
    const d = run({ Makefile: 'diff-cover:\n\ttrue\n', 'a.js': '' });
    assert.equal(d.tools.some((t) => t.name === 'diff-cover'), false);
  });

  it('recipe lines and ci commands are signals', () => {
    const d = run({ Makefile: 'cov:\n\tpytest --cov\n', '.github/workflows/c.yml': 'on: push\njobs:\n  a:\n    steps:\n      - run: cargo llvm-cov\n', 'a.py': '' });
    assert.deepEqual(layer(d, 'coverage').tools, ['coverage.py', 'cargo-llvm-cov']);
  });
});

describe('detect: python tools', () => {
  it('commands use the project runner prefix, none for plain pip', () => {
    assert.deepEqual(layer(run({ 'requirements.txt': 'pytest\n', 'a.py': '' }), 'unit').commands, ['pytest']);
    assert.deepEqual(layer(run({ 'pyproject.toml': '[tool.poetry]\n[tool.pytest.ini_options]\n', 'a.py': '' }), 'unit').commands, ['poetry run pytest']);
    assert.deepEqual(layer(run({ 'pyproject.toml': '[tool.ruff]\n', 'uv.lock': '', 'a.py': '' }), 'lint').commands, ['uv run ruff check .']);
  });

  it('python deps and sections are signals', () => {
    const d = run({ 'requirements.txt': 'mypy\nhypothesis\n', 'pyproject.toml': '[tool.black]\n', 'a.py': '' });
    assert.deepEqual(d.tools.map((t) => `${t.layer}:${t.name}`).sort(), ['format:black', 'property:hypothesis', 'typecheck:mypy']);
  });
});

describe('detect: surfaces and dev runs', () => {
  it('a web package runs its first dev-like script, in dev start serve develop order', () => {
    const d = (scripts: Record<string, string>) => run({ 'package.json': pkg({ name: 'w', dependencies: { vite: '1' }, scripts }), 'package-lock.json': '' }).surfaces[0]?.run;
    assert.equal(d({ serve: 'x', develop: 'x', start: 'x', dev: 'x' }), 'npm run dev');
    assert.equal(d({ serve: 'x', develop: 'x', start: 'x' }), 'npm run start');
    assert.equal(d({ serve: 'x', develop: 'x' }), 'npm run serve');
    assert.equal(d({ develop: 'x' }), 'npm run develop');
    assert.equal(d({ build: 'x' }), null);
  });

  it('only scripts of the same package, and only from package.json, count', () => {
    const d = run({
      'package.json': pkg({ name: 'root', dependencies: { vite: '1' } }),
      'package-lock.json': '',
      'other/package.json': pkg({ name: 'other', scripts: { dev: 'x' } }),
      Makefile: 'dev:\n\ttrue\n',
    });
    assert.equal(d.surfaces.find((s) => s.name === 'root')?.run, null);
  });

  it('every ecosystem contributes surfaces', () => {
    const d = run({
      'package.json': pkg({ name: 'n', bin: 'n.js' }),
      'Cargo.toml': '[package]\nname = "r"\n',
      'src/main.rs': '',
      'go.mod': 'module example.com/g\n',
      'cmd/main.go': 'package main\n',
      'py/pyproject.toml': '[project.scripts]\nt = "x:y"\n',
    });
    assert.deepEqual(d.surfaces.map((s) => [s.kind, s.name, s.run]), [
      ['cli', 'n', 'node n.js'],
      ['cli', 'r', 'cargo run'],
      ['cli', 'example.com/g', 'go run ./cmd'],
      ['cli', 'py', 't'],
    ]);
  });
});

describe('detect: docs', () => {
  it('counts AGENTS.md lines the way an editor does', () => {
    const lines = (text: string) => run({ 'AGENTS.md': text }).docs.agentsMd.lines;
    assert.equal(lines(''), 0);
    assert.equal(lines('a'), 1);
    assert.equal(lines('a\n'), 1);
    assert.equal(lines('a\nb'), 2);
    assert.equal(lines('a\nb\n'), 2);
    assert.equal(lines('a\r\nb\r\n'), 2);
    assert.equal(lines('a\n\n'), 2);
    assert.equal(lines('a\n\nb\n'), 3);
  });

  it('h7 block needs both markers; missing files are absent', () => {
    const block = (text: string) => run({ 'AGENTS.md': text }).docs.agentsMd;
    assert.deepEqual(block('<!-- h7:begin -->\n<!-- h7:end -->\n'), { exists: true, lines: 2, hasH7Block: true });
    assert.equal(block('<!-- h7:end -->\n').hasH7Block, false);
    assert.equal(block('<!-- h7:begin -->\n').hasH7Block, false);
    assert.deepEqual(run({}).docs.agentsMd, { exists: false, lines: 0, hasH7Block: false });
    assert.deepEqual(run({}).docs.claudeMd, { exists: false, importsAgents: false });
  });

  it('CLAUDE.md imports AGENTS.md only on a line of its own', () => {
    const imports = (text: string) => run({ 'CLAUDE.md': text }).docs.claudeMd;
    assert.deepEqual(imports('@AGENTS.md'), { exists: true, importsAgents: true });
    assert.equal(imports('hi\n@AGENTS.md  \nbye').importsAgents, true);
    assert.equal(imports('see @AGENTS.md').importsAgents, false);
    assert.equal(imports('@AGENTS.mdx').importsAgents, false);
    assert.equal(imports('@AGENTS.md trailing').importsAgents, false);
    assert.equal(imports('').importsAgents, false);
  });

  it('context, verification and verify skills', () => {
    assert.equal(run({ 'CONTEXT.md': '' }).docs.contextMd, true);
    assert.equal(run({ 'docs/CONTEXT.md': '' }).docs.contextMd, true);
    assert.equal(run({ 'docs/context.md': '' }).docs.contextMd, false);
    assert.equal(run({}).docs.contextMd, false);
    assert.equal(run({ 'docs/agents/verification.md': '' }).docs.verificationMd, true);
    assert.equal(run({}).docs.verificationMd, false);
    const skills = run({
      '.claude/skills/verify-web/SKILL.md': '',
      '.claude/skills/verify-api/SKILL.md': '',
      '.claude/skills/verify-/SKILL.md': '',
      '.claude/skills/other/SKILL.md': '',
      '.claude/skills/verify-x/sub/SKILL.md': '',
      'pkg/.claude/skills/verify-z/SKILL.md': '',
      '.claude/skills/verify-q/SKILL.md.bak': '',
    });
    assert.deepEqual(skills.docs.verifySkills, ['verify-api', 'verify-web']);
  });

  it('finds the first architecture decision directory and counts only real records', () => {
    for (const dir of ['docs/adr', 'docs/adrs', 'doc/adr', 'adr', 'docs/decisions']) {
      const d = run({ [`${dir}/README.md`]: '', [`${dir}/0001-a.md`]: '', [`${dir}/0002-b.md`]: '', [`${dir}/Readme.MD`]: '', [`${dir}/notes.txt`]: '', [`${dir}/sub/0003-c.md`]: '' });
      assert.equal(d.docs.adrDir, dir, dir);
      assert.equal(d.docs.adrCount, 3, dir);
    }
    assert.equal(run({ 'docs/adr/a.md': '', 'adr/b.md': '', 'docs/decisions/c.md': '' }).docs.adrDir, 'docs/adr');
    assert.equal(run({ 'adr/b.md': '', 'docs/decisions/c.md': '' }).docs.adrDir, 'adr');
    assert.deepEqual([run({}).docs.adrDir, run({}).docs.adrCount], [null, 0]);
    assert.equal(run({ 'docsadr/a.md': '', 'x/docs/adr/a.md': '' }).docs.adrDir, null);
  });

  it('h7 exclusion is read from the repository exclude file', () => {
    const excluded = (content: string | null) => {
      const dir = tmpDir();
      writeTree(dir, content === null ? { 'a.txt': '' } : { 'excl/exclude': content });
      const d = detect(dir, gitWith({ 'rev-parse --show-toplevel': '/r', 'rev-parse --git-path info/exclude': 'excl/exclude' }));
      return d.docs.h7Excluded;
    };
    assert.equal(excluded('.h7/'), true);
    assert.equal(excluded('.h7'), true);
    assert.equal(excluded('node_modules\n.h7/  \nx\n'), true);
    assert.equal(excluded('.h7/\r\n'), true);
    assert.equal(excluded(' .h7/'), false);
    assert.equal(excluded('foo.h7/'), false);
    assert.equal(excluded('.h7x'), false);
    assert.equal(excluded('.h7//'), false);
    assert.equal(excluded(''), false);
    assert.equal(excluded(null), null);
    assert.equal(run({ 'a.txt': '' }).docs.h7Excluded, null);
  });
});

describe('detect: main', () => {
  it('prints JSON for a directory and exits 0', () => {
    const dir = tmpDir();
    writeTree(dir, { 'a.py': '' });
    const out: string[] = [];
    const err: string[] = [];
    assert.equal(main([dir], (t) => out.push(t), (t) => err.push(t), noGit), 0);
    assert.deepEqual(err, []);
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0] as string).languages[0].name, 'python');
  });

  it('a missing path or a file is a usage error, nothing printed', () => {
    const dir = tmpDir();
    writeTree(dir, { 'f.txt': '' });
    for (const bad of [`${dir}/missing`, `${dir}/f.txt`]) {
      const out: string[] = [];
      const err: string[] = [];
      assert.equal(main([bad], (t) => out.push(t), (t) => err.push(t), noGit), 2);
      assert.deepEqual(out, []);
      assert.equal(err.length, 1);
      assert.match(err[0] as string, /^not a directory: .*(missing|f\.txt)$/);
    }
  });
});
