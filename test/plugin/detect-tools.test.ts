import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findTools, kindOf, kindsOfCommand, mutates, RULES, type Kind } from '../../plugins/h7/scripts/detect-tools.ts';

/** Sorted `layer:name` ids that a single signal triggers. */
const ids = (signal: string): string[] => findTools([signal], '').tools.map((t) => `${t.layer}:${t.name}`).sort();

/** [signal, expected ids, open ended (a suffix may still match)] */
type Row = [string, string[], boolean?];

const ROWS: Row[] = [
  ['dep:vitest', ['unit:vitest']],
  ['file:vitest.config.ts', ['unit:vitest']],
  ['file:vitest.config.js', ['unit:vitest']],
  ['file:vitest.config.mts', ['unit:vitest']],
  ['file:vitest.workspace.cjs', ['unit:vitest']],
  ['file:vitest.workspace.mjs', ['unit:vitest']],
  ['dep:jest', ['coverage:jest', 'unit:jest']],
  ['file:jest.config.ts', ['coverage:jest', 'unit:jest']],
  ['file:jest.config.mjs', ['coverage:jest', 'unit:jest']],
  ['file:jest.config.js', ['coverage:jest', 'unit:jest']],
  ['file:jest.config.json', ['coverage:jest', 'unit:jest']],
  ['dep:mocha', ['unit:mocha']],
  ['file:.mocharc.json', ['unit:mocha']],
  ['file:.mocharc.cjs', ['unit:mocha']],
  ['dep:ava', ['unit:ava']],
  ['cmd:node --test', ['unit:node:test'], true],
  ['cmd:node --test test/', ['unit:node:test'], true],
  ['cmd:node.exe --test', ['unit:node:test'], true],
  ['cmd:node  --import  tsx   --test x.ts', ['unit:node:test'], true],
  ['cmd:bun test', ['unit:bun test'], true],
  ['cmd:ci && bun test --bail', ['unit:bun test'], true],
  ['py:pytest', ['unit:pytest']],
  ['section:tool.pytest', ['unit:pytest'], true],
  ['section:tool.pytest.ini_options', ['unit:pytest'], true],
  ['file:pytest.ini', ['unit:pytest']],
  ['file:conftest.py', ['unit:pytest']],
  ['cmd:python -m unittest', ['unit:unittest'], true],
  ['cmd:python3  -m  unittest discover', ['unit:unittest'], true],
  ['file:a_test.go', ['unit:go test']],
  ['file:my-pkg.x_test.go', ['unit:go test']],
  ['file:Cargo.toml', ['format:rustfmt', 'lint:clippy', 'typecheck:cargo check', 'unit:cargo test']],
  ['dep:@playwright/test', ['e2e:playwright']],
  ['dep:playwright', ['e2e:playwright']],
  ['py:playwright', ['e2e:playwright']],
  ['py:pytest-playwright', ['e2e:playwright']],
  ['file:playwright.config.ts', ['e2e:playwright']],
  ['file:playwright.config.mjs', ['e2e:playwright']],
  ['dep:cypress', ['e2e:cypress']],
  ['file:cypress.config.ts', ['e2e:cypress']],
  ['file:cypress.config.mjs', ['e2e:cypress']],
  ['file:cypress.config.js', ['e2e:cypress']],
  ['dep:@wdio/cli', ['e2e:webdriverio']],
  ['py:selenium', ['e2e:selenium']],
  ['dep:eslint', ['lint:eslint']],
  ['file:eslint.config.ts', ['lint:eslint']],
  ['file:eslint.config.mjs', ['lint:eslint']],
  ['file:eslint.config.js', ['lint:eslint']],
  ['file:.eslintrc', ['lint:eslint']],
  ['file:.eslintrc.json', ['lint:eslint']],
  ['dep:@biomejs/biome', ['format:biome', 'lint:biome']],
  ['file:biome.json', ['format:biome', 'lint:biome']],
  ['file:biome.jsonc', ['format:biome', 'lint:biome']],
  ['dep:oxlint', ['lint:oxlint']],
  ['dep:stylelint', ['lint:stylelint']],
  ['py:ruff', ['format:ruff', 'lint:ruff']],
  ['section:tool.ruff', ['format:ruff', 'lint:ruff'], true],
  ['section:tool.ruff.lint', ['format:ruff', 'lint:ruff'], true],
  ['file:ruff.toml', ['format:ruff', 'lint:ruff']],
  ['file:.ruff.toml', ['format:ruff', 'lint:ruff']],
  ['py:flake8', ['lint:flake8']],
  ['file:.flake8', ['lint:flake8']],
  ['py:pylint', ['lint:pylint']],
  ['file:.pylintrc', ['lint:pylint']],
  ['file:go.mod', ['format:gofmt', 'lint:go vet', 'typecheck:go build']],
  ['file:.golangci.yml', ['lint:golangci-lint']],
  ['file:.golangci.yaml', ['lint:golangci-lint']],
  ['dep:prettier', ['format:prettier']],
  ['file:.prettierrc', ['format:prettier']],
  ['file:.prettierrc.json', ['format:prettier']],
  ['file:prettier.config.ts', ['format:prettier']],
  ['file:prettier.config.mjs', ['format:prettier']],
  ['file:prettier.config.js', ['format:prettier']],
  ['py:black', ['format:black']],
  ['section:tool.black', ['format:black']],
  ['dep:typescript', ['typecheck:typescript']],
  ['file:tsconfig.json', ['typecheck:typescript']],
  ['file:tsconfig.build.json', ['typecheck:typescript']],
  ['file:tsconfig.node-esm.json', ['typecheck:typescript']],
  ['dep:vue-tsc', ['typecheck:vue-tsc']],
  ['dep:svelte-check', ['typecheck:svelte-check']],
  ['py:mypy', ['typecheck:mypy']],
  ['section:tool.mypy', ['typecheck:mypy'], true],
  ['section:tool.mypy.overrides', ['typecheck:mypy'], true],
  ['file:mypy.ini', ['typecheck:mypy']],
  ['py:pyright', ['typecheck:pyright']],
  ['file:pyrightconfig.json', ['typecheck:pyright']],
  ['section:tool.pyright', ['typecheck:pyright']],
  ['dep:c8', ['coverage:c8']],
  ['dep:nyc', ['coverage:nyc']],
  ['dep:@vitest/coverage-v8', ['coverage:vitest coverage'], true],
  ['dep:@vitest/coverage-istanbul', ['coverage:vitest coverage'], true],
  ['cmd:node --experimental-test-coverage --test', ['coverage:node test coverage', 'unit:node:test'], true],
  ['cmd:tsx --experimental-test-coverage', ['coverage:node test coverage'], true],
  ['py:coverage', ['coverage:coverage.py']],
  ['py:pytest-cov', ['coverage:coverage.py']],
  ['section:tool.coverage', ['coverage:coverage.py'], true],
  ['section:tool.coverage.run', ['coverage:coverage.py'], true],
  ['file:.coveragerc', ['coverage:coverage.py']],
  ['cmd:pytest --cov', ['coverage:coverage.py'], true],
  ['cmd:pytest --cov=src', ['coverage:coverage.py'], true],
  ['cmd:pytest --cov src --x', ['coverage:coverage.py'], true],
  ['py:diff-cover', ['coverage:diff-cover']],
  ['cmd:diff-cover coverage.xml', ['coverage:diff-cover'], true],
  ['cmd:x && diff-cover a', ['coverage:diff-cover'], true],
  ['cmd:cargo llvm-cov', ['coverage:cargo-llvm-cov'], true],
  ['cmd:cargo   llvm-cov --html', ['coverage:cargo-llvm-cov'], true],
  ['cmd:cargo tarpaulin', ['coverage:tarpaulin'], true],
  ['cmd:cargo   tarpaulin --out Xml', ['coverage:tarpaulin'], true],
  ['file:tarpaulin.toml', ['coverage:tarpaulin']],
  ['cmd:go test -cover ./...', ['coverage:go cover'], true],
  ['cmd:go  test ./... -coverprofile=c.out', ['coverage:go cover'], true],
  ['dep:@stryker-mutator/core', ['mutation:stryker']],
  ['file:stryker.conf.js', ['mutation:stryker']],
  ['file:stryker.conf.json', ['mutation:stryker']],
  ['file:stryker.config.mjs', ['mutation:stryker']],
  ['file:stryker.config.ts', ['mutation:stryker']],
  ['file:stryker.config.cjs', ['mutation:stryker']],
  ['py:mutmut', ['mutation:mutmut']],
  ['section:tool.mutmut', ['mutation:mutmut']],
  ['py:cosmic-ray', ['mutation:cosmic-ray']],
  ['cmd:cargo mutants', ['mutation:cargo-mutants'], true],
  ['cmd:cargo   mutants -j2', ['mutation:cargo-mutants'], true],
  ['file:mutants.toml', ['mutation:cargo-mutants']],
  ['cmd:mvn pitest:mutationCoverage', ['mutation:pitest'], true],
  ['file:pitest.xml', ['mutation:pitest']],
  ['cmd:go-mutesting ./...', ['mutation:go-mutesting'], true],
  ['dep:fast-check', ['property:fast-check']],
  ['dep:jsverify', ['property:jsverify']],
  ['py:hypothesis', ['property:hypothesis']],
  ['cargo:proptest', ['property:proptest']],
  ['cargo:quickcheck', ['property:quickcheck']],
  ['go:pgregory.net/rapid', ['property:rapid']],
  ['go:github.com/leanovate/gopter', ['property:gopter']],
];

describe('detect-tools: every rule matches exactly its own signals', () => {
  for (const [signal, expected, open] of ROWS) {
    it(`${signal} -> ${expected.join(', ')}`, () => {
      assert.deepEqual(ids(signal), expected);
      assert.deepEqual(ids(`x${signal}`), [], 'unanchored at the start');
      if (open !== true) assert.deepEqual(ids(`${signal}/`), [], 'unanchored at the end');
    });
  }

  it('every rule is exercised by at least one row', () => {
    const covered = new Set(ROWS.flatMap(([, expected]) => expected));
    for (const r of RULES) for (const layer of r.layers) assert.ok(covered.has(`${layer}:${r.name}`), `${layer}:${r.name} untested`);
  });

  it('near-misses match nothing', () => {
    for (const s of [
      'cmd:nodemon --test',
      'cmd:node --testing',
      'cmd:node test.js',
      'cmd:bun tests',
      'cmd:python -m unittestx',
      'cmd:python -m pytest',
      'cmd:pytest --coverage',
      'cmd:pytest --cov-report=xml',
      'cmd:cargo llvm-cove',
      'cmd:cargo tarpaulinx',
      'cmd:cargo mutantsx',
      'cmd:go test ./...',
      'dep:@vitest/coverage-',
      'dep:@vitest/coverage-v8/x',
      'file:biome.jsoncx',
      'file:tsconfig..json',
      'file:vitest.config.xs',
      'file:jest.config.json5',
      'file:.mocharc.',
      'file:conftest.pyc',
      'file:a_test.gox',
      'section:tool.other',
      'dep:viteste',
    ]) assert.deepEqual(ids(s), [], s);
  });
});

describe('detect-tools: findTools commands', () => {
  it('collects static commands per layer in rule order, only under the first layer of a rule', () => {
    const f = findTools(['py:ruff', 'file:Cargo.toml', 'file:go.mod', 'py:pytest', 'py:mypy'], 'uv run ');
    assert.deepEqual([...f.commands.entries()], [
      ['unit', ['uv run pytest', 'cargo test']],
      ['lint', ['uv run ruff check .', 'cargo clippy --all-targets -- -D warnings', 'go vet ./...']],
      ['format', ['cargo fmt --check', 'gofmt -l .']],
      ['typecheck', ['uv run mypy .', 'cargo check --all-targets', 'go build ./...']],
    ]);
  });

  it('python runner commands for every python tool', () => {
    const f = findTools(['py:flake8', 'py:pylint', 'py:black', 'py:pyright', 'py:coverage'], 'poetry run ');
    assert.deepEqual([...f.commands.entries()], [
      ['lint', ['poetry run flake8', 'poetry run pylint']],
      ['format', ['poetry run black --check .']],
      ['typecheck', ['poetry run pyright']],
      ['coverage', ['poetry run pytest --cov']],
    ]);
  });

  it('go lint tool and tools without a static command', () => {
    const f = findTools(['file:.golangci.yml', 'dep:vitest', 'dep:jest'], '');
    assert.deepEqual([...f.commands.entries()], [['lint', ['golangci-lint run']]]);
    assert.deepEqual(f.tools.map((t) => t.evidence), ['dep:vitest', 'dep:jest', 'dep:jest', 'file:.golangci.yml']);
  });

  it('rules without a command carry no command key', () => {
    for (const r of RULES) assert.equal('command' in r, r.command !== undefined, r.name);
  });

  it('uses the first matching signal as evidence', () => {
    const f = findTools(['file:conftest.py', 'py:pytest'], '');
    assert.deepEqual(f.tools, [{ layer: 'unit', name: 'pytest', evidence: 'file:conftest.py' }]);
  });
});

describe('detect-tools: kinds', () => {
  const CMD: [string, Kind[]][] = [
    ['deploy', ['deploy']],
    ['publish', ['deploy']],
    ['release', ['deploy']],
    ['migrate', ['deploy']],
    ['rollout', ['deploy']],
    ['rollback', ['deploy']],
    ['docker push', ['deploy']],
    ['docker  push', ['deploy']],
    ['helm', ['deploy']],
    ['kubectl', ['deploy']],
    ['terraform', ['deploy']],
    ['ansible', ['deploy']],
    ['rsync', ['deploy']],
    ['deployment', []],
    ['predeploy', []],
    ['mutation', ['mutation']],
    ['mutate', ['mutation']],
    ['stryker', ['mutation']],
    ['mutmut', ['mutation']],
    ['mutants', ['mutation']],
    ['pitest', ['mutation']],
    ['e2e', ['e2e']],
    ['end-to-end', ['e2e']],
    ['playwright', ['e2e']],
    ['cypress', ['e2e']],
    ['coverage', ['coverage']],
    ['--cov', ['coverage']],
    ['pytest --cov', ['coverage', 'unit']],
    ['cov', ['coverage']],
    ['llvm-cov', ['coverage']],
    ['tarpaulin', ['coverage']],
    ['c8', ['coverage']],
    ['nyc', ['coverage']],
    ['covered', []],
    ['property', ['property']],
    ['fuzz', ['property']],
    ['hypothesis', ['property']],
    ['proptest', ['property']],
    ['typecheck', ['typecheck']],
    ['type-check', ['typecheck']],
    ['check-types', ['typecheck']],
    ['tsc', ['typecheck']],
    ['mypy', ['typecheck']],
    ['pyright', ['typecheck']],
    ['cargo check', ['typecheck']],
    ['go vet', ['typecheck']],
    ['svelte-check', ['typecheck']],
    ['vue-tsc', ['typecheck']],
    ['tscx', []],
    ['lint', ['lint']],
    ['ruff check', ['lint']],
    ['clippy', ['lint']],
    ['golangci', ['lint']],
    ['format', ['format']],
    ['fmt', ['format']],
    ['prettier', ['format']],
    ['black', ['format']],
    ['rustfmt', ['format']],
    ['gofmt', ['format']],
    ['fmtx', []],
    ['test', ['unit']],
    ['tests', ['unit']],
    ['pytest', ['unit']],
    ['vitest', ['unit']],
    ['jest', ['unit']],
    ['mocha', ['unit']],
    ['go test', ['unit']],
    ['cargo test', ['unit']],
    ['unit', ['unit']],
    ['bun test', ['unit']],
    ['contest', []],
    ['build', ['build']],
    ['cargo build', ['build']],
    ['go build', ['build']],
    ['rebuild', []],
    ['', []],
  ];

  it('kindsOfCommand names every kind a command touches, in rule order', () => {
    for (const [command, kinds] of CMD) assert.deepEqual(kindsOfCommand(command), kinds, command);
    assert.deepEqual(kindsOfCommand('pnpm build && pnpm lint && pnpm test && pnpm deploy'), ['deploy', 'lint', 'unit', 'build']);
  });

  it('kindOf by name or command alone', () => {
    for (const [command, kinds] of CMD) {
      if (kinds.length !== 1) continue;
      assert.equal(kindOf('x', command), kinds[0], `command ${command}`);
      assert.equal(kindOf(command, ''), kinds[0], `name ${command}`);
    }
    assert.equal(kindOf('x', 'nothing special'), null);
    assert.equal(kindOf('x', ''), null);
  });

  it('name-only kinds are whole names', () => {
    for (const n of ['dev', 'start', 'serve', 'develop', 'watch', 'dev:web', 'start:prod', 'watch:', 'serve:a:b']) assert.equal(kindOf(n, 'vite'), 'dev', n);
    for (const n of ['check', 'verify', 'ci', 'validate', 'all']) assert.equal(kindOf(n, 'tsc && eslint'), 'check', n);
    for (const n of ['devs', 'xdev', 'startup', 'checks', 'xcheck', 'allx', 'ci2']) assert.equal(kindOf(n, ''), null, n);
    assert.equal(kindOf('dev:web', 'playwright test'), 'dev');
    assert.equal(kindOf('verify', 'vitest --coverage'), 'check');
  });

  it('a name wins over the command, except a generic test name yields to a specific command', () => {
    assert.equal(kindOf('lint', 'stryker run'), 'lint');
    assert.equal(kindOf('build', 'vitest run --coverage'), 'build');
    assert.equal(kindOf('test', 'stryker run'), 'mutation');
    assert.equal(kindOf('test', 'cypress run'), 'e2e');
    assert.equal(kindOf('test', 'vitest --coverage'), 'coverage');
    assert.equal(kindOf('test', 'fast-check fuzz'), 'property');
    assert.equal(kindOf('test', 'vitest run'), 'unit');
    assert.equal(kindOf('test', 'eslint .'), 'unit');
    assert.equal(kindOf('test', 'tsc'), 'unit');
    assert.equal(kindOf('test', 'docker push'), 'unit');
    assert.equal(kindOf('', 'stryker run'), 'mutation');
    assert.equal(kindOf('e2e', 'vitest --coverage'), 'e2e');
    assert.equal(kindOf('', 'tsc'), 'typecheck');
  });

  it('only a unit name yields to a specific command', () => {
    assert.equal(kindOf('lint', 'playwright test'), 'lint');
    assert.equal(kindOf('typecheck', 'stryker'), 'typecheck');
    assert.equal(kindOf('unit', 'playwright test'), 'e2e');
    assert.equal(kindOf('tests', 'c8 node --test'), 'coverage');
  });

  it('mutates flags writers, but not checks', () => {
    assert.equal(mutates('x', 'prettier --write .'), true);
    assert.equal(mutates('x', 'eslint --fix .'), true);
    assert.equal(mutates('fix', 'eslint .'), true);
    assert.equal(mutates('x', 'ruff fix .'), true);
    assert.equal(mutates('lint:fix', 'x'), true);
    assert.equal(mutates('x', 'prettier --writeall'), false);
    assert.equal(mutates('x', 'eslint --fixed'), false);
    assert.equal(mutates('prefix', 'echo'), false);
    assert.equal(mutates('x', 'prettier --write --check'), false);
    assert.equal(mutates('x', 'prettier --write --checks'), true);
    assert.equal(mutates('fix --check', 'eslint .'), true);
    assert.equal(mutates('lint', 'eslint .'), false);
  });
});
