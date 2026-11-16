export type Layer = 'lint' | 'typecheck' | 'format' | 'unit' | 'coverage' | 'mutation' | 'property' | 'e2e';

export const LAYERS: Layer[] = ['lint', 'typecheck', 'format', 'unit', 'coverage', 'mutation', 'property', 'e2e'];

export type Kind = Layer | 'build' | 'deploy' | 'dev' | 'check';

/** Ordered: the first rule that matches a script name (then its command) decides the kind. */
const KIND_RULES: [Kind, RegExp][] = [
  ['deploy', /\b(deploy|publish|release|migrate|rollout|rollback|docker\s+push|helm|kubectl|terraform|ansible|rsync)\b/],
  ['mutation', /mutation|mutate|stryker|mutmut|mutants|pitest/],
  ['e2e', /e2e|end-to-end|playwright|cypress/],
  ['coverage', /coverage|--cov\b|\bcov\b|llvm-cov|tarpaulin|\bc8\b|\bnyc\b/],
  ['property', /property|fuzz|hypothesis|proptest/],
  ['typecheck', /type-?check|check-types|\btsc\b|mypy|pyright|cargo check|go vet|svelte-check|vue-tsc/],
  ['lint', /lint|ruff check|clippy|golangci/],
  ['format', /format|\bfmt\b|prettier|\bblack\b|rustfmt|gofmt/],
  ['unit', /\btests?\b|pytest|vitest|jest|mocha|go test|cargo test|\bunit\b|--test\b|bun test/],
  ['build', /\bbuild\b|cargo build|go build/],
];

const NAME_ONLY: [Kind, RegExp][] = [
  ['dev', /^(dev|start|serve|develop|watch)(:.*)?$/],
  ['check', /^(check|verify|ci|validate|all)$/],
];

const SPECIFIC: Kind[] = ['mutation', 'e2e', 'coverage', 'property'];

/** Kind of a script or target: by name first; a generic test name yields to a more specific command. */
export function kindOf(name: string, command: string): Kind | null {
  for (const [kind, re] of NAME_ONLY) if (re.test(name)) return kind;
  const byName = KIND_RULES.find(([, re]) => re.test(name))?.[0] ?? null;
  const byCommand = KIND_RULES.find(([, re]) => re.test(command))?.[0] ?? null;
  const specific = SPECIFIC.find((k) => k === byCommand);
  return byName === null || byName === 'unit' ? (specific ?? byName ?? byCommand) : byName;
}

/** Every kind a CI command touches. */
export function kindsOfCommand(command: string): Kind[] {
  return KIND_RULES.filter(([, re]) => re.test(command)).map(([kind]) => kind);
}

/** True when a script rewrites files (a format or fix run), not a check. */
export function mutates(name: string, command: string): boolean {
  return /--write\b|--fix\b|\bfix\b/.test(`${name} ${command}`) && !/--check\b/.test(command);
}

export interface Tool {
  layer: Layer;
  name: string;
  evidence: string;
}

interface Rule {
  layers: Layer[];
  name: string;
  match: RegExp;
  /** Static run command; `{py}` is the python runner prefix. */
  command?: string;
}

const rule = (layers: Layer[], name: string, match: RegExp, command?: string): Rule => (command === undefined ? { layers, name, match } : { layers, name, match, command });

/**
 * Signals are strings: `dep:<npm>`, `py:<token>`, `cargo:<token>`, `go:<token>`, `section:<toml>`, `file:<basename>`, `cmd:<command>`.
 */
export const RULES: Rule[] = [
  rule(['unit'], 'vitest', /^(dep:vitest|file:vitest\.(config|workspace)\.[cm]?[jt]s)$/),
  rule(['unit', 'coverage'], 'jest', /^(dep:jest|file:jest\.config\.[cm]?[jt]s|file:jest\.config\.json)$/),
  rule(['unit'], 'mocha', /^(dep:mocha|file:\.mocharc\.[\w.]+)$/),
  rule(['unit'], 'ava', /^dep:ava$/),
  rule(['unit'], 'node:test', /^cmd:.*\bnode(\.exe)?\s+(\S+\s+)*--test\b/),
  rule(['unit'], 'bun test', /^cmd:.*\bbun test\b/),
  rule(['unit'], 'pytest', /^(py:pytest|section:tool\.pytest.*|file:pytest\.ini|file:conftest\.py)$/, '{py}pytest'),
  rule(['unit'], 'unittest', /^cmd:.*python3?\s+-m\s+unittest\b/),
  rule(['unit'], 'go test', /^file:[\w.-]+_test\.go$/, 'go test ./...'),
  rule(['unit'], 'cargo test', /^file:Cargo\.toml$/, 'cargo test'),
  rule(['e2e'], 'playwright', /^(dep:@playwright\/test|dep:playwright|py:playwright|py:pytest-playwright|file:playwright\.config\.[cm]?[jt]s)$/),
  rule(['e2e'], 'cypress', /^(dep:cypress|file:cypress\.config\.[cm]?[jt]s)$/),
  rule(['e2e'], 'webdriverio', /^dep:@wdio\/cli$/),
  rule(['e2e'], 'selenium', /^py:selenium$/),
  rule(['lint'], 'eslint', /^(dep:eslint|file:eslint\.config\.[cm]?[jt]s|file:\.eslintrc(\.[\w]+)?)$/),
  rule(['lint', 'format'], 'biome', /^(dep:@biomejs\/biome|file:biome\.jsonc?)$/),
  rule(['lint'], 'oxlint', /^dep:oxlint$/),
  rule(['lint'], 'stylelint', /^dep:stylelint$/),
  rule(['lint', 'format'], 'ruff', /^(py:ruff|section:tool\.ruff.*|file:ruff\.toml|file:\.ruff\.toml)$/, '{py}ruff check .'),
  rule(['lint'], 'flake8', /^(py:flake8|file:\.flake8)$/, '{py}flake8'),
  rule(['lint'], 'pylint', /^(py:pylint|file:\.pylintrc)$/, '{py}pylint'),
  rule(['lint'], 'clippy', /^file:Cargo\.toml$/, 'cargo clippy --all-targets -- -D warnings'),
  rule(['lint'], 'go vet', /^file:go\.mod$/, 'go vet ./...'),
  rule(['lint'], 'golangci-lint', /^file:\.golangci\.ya?ml$/, 'golangci-lint run'),
  rule(['format'], 'prettier', /^(dep:prettier|file:\.prettierrc(\.[\w]+)?|file:prettier\.config\.[cm]?[jt]s)$/),
  rule(['format'], 'black', /^(py:black|section:tool\.black)$/, '{py}black --check .'),
  rule(['format'], 'rustfmt', /^file:Cargo\.toml$/, 'cargo fmt --check'),
  rule(['format'], 'gofmt', /^file:go\.mod$/, 'gofmt -l .'),
  rule(['typecheck'], 'typescript', /^(dep:typescript|file:tsconfig(\.[\w-]+)?\.json)$/),
  rule(['typecheck'], 'vue-tsc', /^dep:vue-tsc$/),
  rule(['typecheck'], 'svelte-check', /^dep:svelte-check$/),
  rule(['typecheck'], 'mypy', /^(py:mypy|section:tool\.mypy.*|file:mypy\.ini)$/, '{py}mypy .'),
  rule(['typecheck'], 'pyright', /^(py:pyright|file:pyrightconfig\.json|section:tool\.pyright)$/, '{py}pyright'),
  rule(['typecheck'], 'cargo check', /^file:Cargo\.toml$/, 'cargo check --all-targets'),
  rule(['typecheck'], 'go build', /^file:go\.mod$/, 'go build ./...'),
  rule(['coverage'], 'c8', /^dep:c8$/),
  rule(['coverage'], 'nyc', /^dep:nyc$/),
  rule(['coverage'], 'vitest coverage', /^dep:@vitest\/coverage-[\w-]+$/),
  rule(['coverage'], 'node test coverage', /^cmd:.*--experimental-test-coverage/),
  rule(['coverage'], 'coverage.py', /^(py:coverage|py:pytest-cov|section:tool\.coverage.*|file:\.coveragerc|cmd:.*--cov(\s.*|=.*)?)$/, '{py}pytest --cov'),
  rule(['coverage'], 'diff-cover', /^(py:diff-cover|cmd:.*diff-cover.*)$/),
  rule(['coverage'], 'cargo-llvm-cov', /^cmd:.*cargo\s+llvm-cov\b/),
  rule(['coverage'], 'tarpaulin', /^(cmd:.*cargo\s+tarpaulin\b.*|file:tarpaulin\.toml)$/),
  rule(['coverage'], 'go cover', /^cmd:.*go\s+test\b.*-cover/),
  rule(['mutation'], 'stryker', /^(dep:@stryker-mutator\/core|file:stryker\.conf(ig)?\.[cm]?[jt]s(on)?)$/),
  rule(['mutation'], 'mutmut', /^(py:mutmut|section:tool\.mutmut)$/),
  rule(['mutation'], 'cosmic-ray', /^py:cosmic-ray$/),
  rule(['mutation'], 'cargo-mutants', /^(cmd:.*cargo\s+mutants\b.*|file:mutants\.toml)$/),
  rule(['mutation'], 'pitest', /^(cmd:.*pitest.*|file:pitest\.xml)$/),
  rule(['mutation'], 'go-mutesting', /^cmd:.*go-mutesting/),
  rule(['property'], 'fast-check', /^dep:fast-check$/),
  rule(['property'], 'jsverify', /^dep:jsverify$/),
  rule(['property'], 'hypothesis', /^py:hypothesis$/),
  rule(['property'], 'proptest', /^cargo:proptest$/),
  rule(['property'], 'quickcheck', /^cargo:quickcheck$/),
  rule(['property'], 'rapid', /^go:pgregory\.net\/rapid$/),
  rule(['property'], 'gopter', /^go:github\.com\/leanovate\/gopter$/),
];

export interface Found {
  tools: Tool[];
  /** Static commands per layer (toolchain and python tools). */
  commands: Map<Layer, string[]>;
}

export function findTools(signals: string[], py: string): Found {
  const tools: Tool[] = [];
  const commands = new Map<Layer, string[]>();
  for (const r of RULES) {
    const evidence = signals.find((s) => r.match.test(s));
    if (evidence === undefined) continue;
    for (const layer of r.layers) {
      tools.push({ layer, name: r.name, evidence });
      if (r.command !== undefined && layer === r.layers[0]) commands.set(layer, [...(commands.get(layer) ?? []), r.command.replace('{py}', py)]);
    }
  }
  return { tools, commands };
}

