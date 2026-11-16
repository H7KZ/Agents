import { readFileSync, statSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { detectCi, type Ci } from './detect-ci.ts';
import { DEFAULT_LIMITS, openRepo, type Limits, type Repo } from './detect-fs.ts';
import { detectGit, type GitInfo } from './detect-git.ts';
import { crates, filesNamed, globToRegex, goModules, goWorkUses, nodePackages, pythonProjects, targets, yamlList, type NodePkg } from './detect-scan.ts';
import { crateSurface, goSurfaces, nodeSurface, pythonSurface, PY_PREFIX, RUNNABLE, type Surface } from './detect-surfaces.ts';
import { findTools, kindOf, LAYERS, mutates, type Kind, type Layer, type Tool } from './detect-tools.ts';
import { spawnRunner, type Runner } from './git.ts';

const { basename, dirname, extname } = posix;

export interface Script {
  source: 'package.json' | 'make' | 'just' | 'task';
  dir: string;
  package: string | null;
  name: string;
  command: string;
  /** Invocation from the repo root. */
  run: string;
  kind: Kind | null;
  /** Rewrites files (format or fix run), so it is not a check. */
  mutates: boolean;
}

export interface LayerInfo {
  layer: Layer;
  status: 'found' | 'gap' | 'na';
  tools: string[];
  commands: string[];
  recommend: string | null;
  reason: string | null;
}

export interface Gap {
  id: string;
  message: string;
  recommend: string | null;
}

export interface Detection {
  root: string;
  scan: { files: number; truncated: boolean };
  languages: { name: string; files: number }[];
  packageManagers: { name: string; lockfile: string | null; dir: string }[];
  monorepo: { tools: string[]; workspaces: { dir: string; name: string; kind: 'node' | 'cargo' | 'go' }[] } | null;
  scripts: Script[];
  tools: Tool[];
  layers: LayerInfo[];
  surfaces: Surface[];
  ci: Ci;
  docs: {
    agentsMd: { exists: boolean; lines: number; hasH7Block: boolean };
    claudeMd: { exists: boolean; importsAgents: boolean };
    contextMd: boolean;
    adrDir: string | null;
    adrCount: number;
    verificationMd: boolean;
    verifySkills: string[];
    h7Excluded: boolean | null;
  };
  git: GitInfo;
  gaps: Gap[];
  warnings: string[];
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
};

type Stack = 'js' | 'python' | 'rust' | 'go';
const STACK_OF: Record<string, Stack> = { typescript: 'js', javascript: 'js', python: 'python', rust: 'rust', go: 'go' };

const REC: Record<Stack, Record<Layer, string>> = {
  js: { lint: 'eslint (or biome)', typecheck: 'typescript (tsc --noEmit)', format: 'prettier (or biome)', unit: 'vitest', coverage: '@vitest/coverage-v8 (or c8)', mutation: '@stryker-mutator/core', property: 'fast-check', e2e: '@playwright/test' },
  python: { lint: 'ruff', typecheck: 'mypy (or pyright)', format: 'ruff format (or black)', unit: 'pytest', coverage: 'pytest-cov', mutation: 'mutmut', property: 'hypothesis', e2e: 'pytest-playwright' },
  rust: { lint: 'clippy (cargo clippy)', typecheck: 'cargo check', format: 'rustfmt (cargo fmt)', unit: 'cargo test', coverage: 'cargo-llvm-cov', mutation: 'cargo-mutants', property: 'proptest', e2e: 'integration tests under tests/ driving the built binary' },
  go: { lint: 'golangci-lint', typecheck: 'go vet', format: 'gofmt', unit: 'go test', coverage: 'go test -cover', mutation: 'go-mutesting (immature; owner decides)', property: 'rapid', e2e: 'go test with an integration build tag' },
};

const MESSAGE: Record<Layer, string> = {
  lint: 'no linter',
  typecheck: 'no type checker',
  format: 'no formatter',
  unit: 'no unit test runner',
  coverage: 'no coverage tool',
  mutation: 'no mutation tool',
  property: 'no property-based testing library',
  e2e: 'no e2e tooling',
};

const NODE_LOCKS: Record<string, string> = { 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'package-lock.json': 'npm', 'bun.lock': 'bun', 'bun.lockb': 'bun' };
const NODE_PMS = new Set(Object.values(NODE_LOCKS));
const OTHER_LOCKS: Record<string, string> = {
  'poetry.lock': 'poetry', 'uv.lock': 'uv', 'pdm.lock': 'pdm', 'Pipfile.lock': 'pipenv', 'Cargo.lock': 'cargo', 'go.sum': 'go', 'Gemfile.lock': 'bundler', 'composer.lock': 'composer',
};

const ADR_DIRS = ['docs/adr', 'docs/adrs', 'doc/adr', 'adr', 'docs/decisions'];
const LIFECYCLE = new Set(['install', 'postinstall', 'preinstall', 'prepare', 'prepublish', 'prepublishOnly', 'postpublish']);
const DEV_NAMES = ['dev', 'start', 'serve', 'develop'];

function nodeRun(pm: string, pkg: NodePkg, inWorkspace: boolean, script: string): string {
  if (pkg.dir === '.') return `${pm} run ${script}`;
  if (!inWorkspace) return `cd ${pkg.dir} && ${pm} run ${script}`;
  if (pm === 'pnpm') return `pnpm --filter ${pkg.name} run ${script}`;
  if (pm === 'npm') return `npm --workspace ${pkg.name} run ${script}`;
  if (pm === 'yarn') return `yarn workspace ${pkg.name} run ${script}`;
  return `${pm} --cwd ${pkg.dir} run ${script}`;
}

function isLifecycle(name: string, scripts: Record<string, string>): boolean {
  if (LIFECYCLE.has(name)) return true;
  const base = /^pre(.+)/.exec(name)?.[1] ?? /^post(.+)/.exec(name)?.[1];
  return base !== undefined && base in scripts;
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function readExclude(root: string, path: string | null): boolean | null {
  if (path === null) return null;
  try {
    return /^\.h7\/?\s*$/m.test(readFileSync(resolve(root, path), 'utf8'));
  } catch {
    return null;
  }
}

export function detect(rootInput: string, run: Runner = spawnRunner, limits: Limits = DEFAULT_LIMITS): Detection {
  const root = resolve(rootInput);
  const repo: Repo = openRepo(root, limits);
  const warnings: string[] = [];
  const pkgs = nodePackages(repo, warnings);
  const cargo = crates(repo);
  const gomods = goModules(repo);
  const py = pythonProjects(repo);
  const tg = targets(repo);
  const git = detectGit(root, run);
  const ci = detectCi(repo);

  const languages = Object.entries(
    repo.files.reduce<Record<string, number>>((acc, f) => {
      const lang = LANG_BY_EXT[extname(f).slice(1)];
      return lang === undefined ? acc : { ...acc, [lang]: (acc[lang] ?? 0) + 1 };
    }, {}),
  )
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files - a.files || (a.name < b.name ? -1 : 1));
  const stackCounts = languages.reduce<Record<string, number>>((acc, l) => {
    const stack = STACK_OF[l.name];
    return stack === undefined ? acc : { ...acc, [stack]: (acc[stack] ?? 0) + l.files };
  }, {});
  const stack = (Object.entries(stackCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) as Stack | null;

  // Package managers.
  const packageManagers: Detection['packageManagers'] = repo.files.flatMap((f) => {
    const name = NODE_LOCKS[basename(f)] ?? OTHER_LOCKS[basename(f)];
    return name === undefined ? [] : [{ name, lockfile: f, dir: dirname(f) }];
  });
  const rootPkg = pkgs.find((p) => p.dir === '.');
  const rootNodeLock = packageManagers.find((p) => p.dir === '.' && NODE_PMS.has(p.name));
  const nodePm = rootNodeLock?.name ?? rootPkg?.packageManager?.split('@')[0] ?? 'npm';
  if (rootPkg !== undefined && rootNodeLock === undefined) packageManagers.push({ name: nodePm, lockfile: null, dir: '.' });

  // Monorepo.
  const pnpmWs = repo.read('pnpm-workspace.yaml');
  const nodePatterns = [...(pnpmWs === null ? [] : yamlList(pnpmWs, 'packages')), ...(rootPkg?.workspaces ?? [])];
  const cargoRoot = cargo.find((c) => c.dir === '.' && c.isWorkspace);
  const goUses = goWorkUses(repo);
  const inPatterns = (patterns: string[], dir: string): boolean =>
    patterns.some((p) => !p.startsWith('!') && globToRegex(p).test(dir)) && !patterns.some((p) => p.startsWith('!') && globToRegex(p.slice(1)).test(dir));
  const workspaces: NonNullable<Detection['monorepo']>['workspaces'] = [
    ...pkgs.filter((p) => p.dir !== '.' && inPatterns(nodePatterns, p.dir)).map((p) => ({ dir: p.dir, name: p.name, kind: 'node' as const })),
    ...cargo.filter((c) => c.dir !== '.' && cargoRoot !== undefined && inPatterns(cargoRoot.workspaceMembers, c.dir)).map((c) => ({ dir: c.dir, name: c.name ?? c.dir, kind: 'cargo' as const })),
    ...gomods.filter((m) => goUses.includes(m.dir)).map((m) => ({ dir: m.dir, name: m.name ?? m.dir, kind: 'go' as const })),
  ];
  const monoTools = [
    ...(pnpmWs === null ? [] : ['pnpm-workspaces']),
    ...((rootPkg?.workspaces.length ?? 0) > 0 ? ['package-workspaces'] : []),
    ...(['turbo', 'nx', 'lerna'] as const).filter((t) => repo.has(`${t}.json`)),
    ...(cargoRoot === undefined ? [] : ['cargo-workspace']),
    ...(goUses.length > 0 ? ['go-work'] : []),
  ];
  const monorepo = monoTools.length > 0 ? { tools: monoTools, workspaces } : null;
  const inWs = (dir: string): boolean => workspaces.some((w) => w.kind === 'node' && w.dir === dir);

  // Scripts.
  const scripts: Script[] = [
    ...pkgs.flatMap((pkg) =>
      Object.entries(pkg.scripts)
        .filter(([name]) => !isLifecycle(name, pkg.scripts))
        .map(([name, command]) => ({
          source: 'package.json' as const,
          dir: pkg.dir,
          package: pkg.name,
          name,
          command,
          run: nodeRun(nodePm, pkg, inWs(pkg.dir), name),
          kind: kindOf(name, command),
          mutates: mutates(name, command),
        })),
    ),
    ...tg.targets.map((t) => ({ source: t.source, dir: t.dir, package: null, name: t.name, command: t.command, run: t.command, kind: kindOf(t.name, ''), mutates: mutates(t.name, '') })),
  ];

  // Tools from signals.
  const signals = [
    ...pkgs.flatMap((p) => p.deps.map((d) => `dep:${d}`)),
    ...py.flatMap((p) => [...p.deps.map((d) => `py:${d}`), ...p.sections.map((s) => `section:${s}`)]),
    ...cargo.flatMap((c) => c.deps.map((d) => `cargo:${d}`)),
    ...gomods.flatMap((m) => m.deps.map((d) => `go:${d}`)),
    ...new Set(repo.files.map((f) => `file:${basename(f)}`)),
    ...[...scripts.filter((s) => s.source === 'package.json').map((s) => s.command), ...tg.recipeLines, ...ci.jobs.flatMap((j) => j.commands)].map((c) => `cmd:${c}`),
  ];
  const found = findTools(signals, PY_PREFIX[py[0]?.manager ?? 'pip']);
  const tools = found.tools;

  // Surfaces.
  const devRunOf = (pkg: NodePkg): string | null => {
    const mine = scripts.filter((s) => s.source === 'package.json' && s.dir === pkg.dir);
    const script = DEV_NAMES.map((n) => mine.find((s) => s.name === n)).find((s) => s !== undefined);
    return script === undefined ? null : script.run;
  };
  const surfaces = [
    ...pkgs.flatMap((pkg) => nodeSurface({ pkg, devRun: devRunOf(pkg) }) ?? []),
    ...cargo.flatMap((c) => crateSurface(c) ?? []),
    ...gomods.flatMap((m) => goSurfaces(m)),
    ...py.flatMap((p) => pythonSurface(p) ?? []),
  ];
  const runnable = surfaces.some((s) => RUNNABLE.includes(s.kind));

  // Layers.
  const layers: LayerInfo[] = LAYERS.map((layer) => {
    const names = [...new Set(tools.filter((t) => t.layer === layer).map((t) => t.name))];
    const commands = [...new Set([...scripts.filter((s) => s.kind === layer && !s.mutates).map((s) => s.run), ...(found.commands.get(layer) ?? [])])];
    const recommend = stack === null ? null : REC[stack][layer];
    if (names.length > 0) return { layer, status: 'found', tools: names, commands, recommend: null, reason: null };
    if (languages.length === 0) return { layer, status: 'na', tools: [], commands, recommend: null, reason: 'no source files detected' };
    if (layer === 'e2e' && !runnable) return { layer, status: 'na', tools: [], commands, recommend: null, reason: 'no runnable app surface (web, api, cli, desktop)' };
    return { layer, status: 'gap', tools: [], commands, recommend, reason: null };
  });

  // Gaps.
  const gaps: Gap[] = layers.filter((l) => l.status === 'gap').map((l) => ({ id: `layer:${l.layer}`, message: MESSAGE[l.layer], recommend: l.recommend }));
  const cov = layers.find((l) => l.layer === 'coverage') as LayerInfo;
  if (cov.status === 'found' && !tools.some((t) => t.name === 'diff-cover')) {
    gaps.push({ id: 'diff-coverage', message: 'no diff-coverage command (100% line+branch on changed lines)', recommend: 'diff-cover <lcov or cobertura report> --compare-branch=<default branch>' });
  }
  if (languages.length === 0) gaps.push({ id: 'empty-repo', message: 'no source files or manifests detected', recommend: null });
  if (ci.provider === null) gaps.push({ id: 'ci', message: 'no CI detected', recommend: null });
  else if (!ci.parsed) gaps.push({ id: 'ci-unparsed', message: `CI provider ${ci.provider} found but its jobs are not parsed; read ${ci.files.join(', ')}`, recommend: null });
  for (const s of surfaces) {
    if (RUNNABLE.includes(s.kind) && s.run === null) gaps.push({ id: `surface:${s.name}`, message: `${s.kind} surface ${s.name} (${s.dir}) has no derivable run command`, recommend: null });
  }
  if (pkgs.length > 0 && rootNodeLock === undefined) gaps.push({ id: 'lockfile', message: 'package.json without a root lockfile', recommend: null });
  if (!git.isRepo) gaps.push({ id: 'git', message: 'not a git repository', recommend: null });
  else {
    if (git.defaultBranch === null) gaps.push({ id: 'default-branch', message: 'default branch unknown (no origin/HEAD, no local main or master)', recommend: null });
    if (git.commitConvention.kind === 'unknown') gaps.push({ id: 'commit-convention', message: 'commit convention unknown (fewer than 3 commits)', recommend: null });
  }
  if (repo.truncated) gaps.push({ id: 'scan-truncated', message: `scan stopped at ${limits.maxFiles} files; results may be incomplete`, recommend: null });

  // Docs.
  const read = (f: string): string | null => repo.read(f);
  const agents = read('AGENTS.md');
  const claude = read('CLAUDE.md');
  const adrDir = ADR_DIRS.find((d) => repo.files.some((f) => f.startsWith(`${d}/`))) ?? null;
  const docs: Detection['docs'] = {
    agentsMd: { exists: agents !== null, lines: lineCount(agents ?? ''), hasH7Block: /<!-- h7:begin -->/.test(agents ?? '') && /<!-- h7:end -->/.test(agents ?? '') },
    claudeMd: { exists: claude !== null, importsAgents: /^@AGENTS\.md\s*$/m.test(claude ?? '') },
    contextMd: repo.has('CONTEXT.md') || repo.has('docs/CONTEXT.md'),
    adrDir,
    adrCount: adrDir === null ? 0 : repo.files.filter((f) => f.startsWith(`${adrDir}/`) && f.endsWith('.md') && basename(f).toLowerCase() !== 'readme.md').length,
    verificationMd: repo.has('docs/agents/verification.md'),
    verifySkills: filesNamed(repo, (b) => b === 'SKILL.md').filter((f) => /^\.claude\/skills\/verify-[^/]+\/SKILL\.md$/.test(f)).map((f) => f.split('/')[2] as string),
    h7Excluded: readExclude(root, git.excludePath),
  };

  return {
    root,
    scan: { files: repo.files.length, truncated: repo.truncated },
    languages,
    packageManagers,
    monorepo,
    scripts,
    tools,
    layers,
    surfaces,
    ci,
    docs,
    git,
    gaps,
    warnings,
  };
}

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, run: Runner = spawnRunner): number {
  const dir = resolve(argv[0] ?? process.cwd());
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) {
    err(`not a directory: ${dir}`);
    return 2;
  }
  out(JSON.stringify(detect(dir, run), null, 2));
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t));
}
