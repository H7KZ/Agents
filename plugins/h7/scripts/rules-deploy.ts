import { commandName, parseArgs, type ParsedArgs, type Simple } from './command.ts';
import { ask, type Decision } from './types.ts';

const RULE = 'deploy-publish';
const PROTECTED_REF = /^(?:main|master|production|prod|release\/.+)$/;
const SCRIPT = /deploy|release|publish/i;
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const NPM_SPEC = {
  valueShort: 'wFC',
  valueLong: ['--registry', '--tag', '--prefix', '--userconfig', '--cache', '--workspace', '--filter', '--cwd', '--dir', '--otp', '--access', '--scope', '--loglevel'],
};
const RUNNER_SPEC = { valueShort: 'p', valueLong: ['--package', '--call'] };
const KUBECTL_SPEC = {
  valueShort: 'nfk',
  valueLong: ['--context', '--namespace', '--cluster', '--kubeconfig', '--user', '--as', '--token', '--server', '--filename', '--kustomize'],
};
const GH_SPEC = {
  valueShort: 'RXfFHqt',
  valueLong: ['--repo', '--method', '--field', '--raw-field', '--header', '--jq', '--template', '--input', '--hostname', '--preview', '--cache'],
};

function guarded(what: string): Decision {
  return ask(RULE, `${what} affects shared or production systems. Confirm with the user before running it.`);
}

function kubectl(argv: string[]): Decision | null {
  const parsed = parseArgs(argv, KUBECTL_SPEC);
  const [sub, action] = parsed.positionals;
  const mutating = sub === 'apply' || sub === 'delete' || (sub === 'rollout' && action !== 'status' && action !== 'history');
  const targets = [
    parsed.options.get('--context'),
    parsed.options.get('--namespace'),
    parsed.options.get('-n'),
    parsed.options.get('--filename'),
    parsed.options.get('-f'),
    parsed.options.get('--kustomize'),
    parsed.options.get('-k'),
  ];
  if (!mutating || !targets.some((t) => /prod/i.test(t ?? ''))) return null;
  return guarded(`kubectl ${sub} against a prod context, namespace or manifest`);
}

function packageManager(name: string, parsed: ParsedArgs): Decision | null {
  const [first, second, third] = parsed.positionals;
  const publishes =
    first === 'publish' || (name === 'yarn' && first === 'npm' && second === 'publish') || (name === 'yarn' && first === 'workspace' && third === 'publish');
  if (publishes) return guarded(`${name} publish`);
  const script = first === 'run' || first === 'run-script' ? second : name === 'yarn' ? first : undefined;
  if (script !== undefined && SCRIPT.test(script)) return guarded(`${name} run ${script}`);
  return null;
}

function ghApi(parsed: ParsedArgs): Decision | null {
  const method = (parsed.options.get('--method') ?? parsed.options.get('-X') ?? '').toUpperCase();
  if (!['DELETE', 'PATCH', 'PUT'].includes(method)) return null;
  let endpoint = parsed.positionals[1] ?? '';
  try {
    endpoint = decodeURIComponent(endpoint);
  } catch {
    // keep the raw endpoint
  }
  const ref = /\/git\/refs\/heads\/(.+)$/.exec(endpoint);
  return ref !== null && PROTECTED_REF.test(ref[1] as string) ? guarded(`gh api ${method} on protected branch ref "${ref[1]}"`) : null;
}

function unwrapRunner(argv: string[]): Simple | null {
  const parsed = parseArgs(argv, RUNNER_SPEC);
  const command = parsed.positionals[0];
  if (command === undefined) return null;
  return { name: commandName(command), argv: argv.slice(argv.indexOf(command) + 1), env: {}, raw: command };
}

export function evaluateDeploy(simple: Simple): Decision | null {
  const { name, argv } = simple;
  if (RUNNERS.has(name)) {
    const inner = unwrapRunner(argv);
    return inner === null ? null : evaluateDeploy(inner);
  }
  const parsed = parseArgs(argv, PACKAGE_MANAGERS.has(name) ? NPM_SPEC : { valueShort: 'R', valueLong: ['--repo'] });
  const [first, second] = parsed.positionals;
  const flags = parsed.flags;
  if (flags.includes('--dry-run')) return null;
  if ((name === 'pnpm' || name === 'yarn' || name === 'npm') && (first === 'dlx' || first === 'exec')) {
    const inner = unwrapRunner(argv.slice(argv.indexOf(first) + 1));
    return inner === null ? null : evaluateDeploy(inner);
  }
  switch (name) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return packageManager(name, parsed);
    case 'lerna':
    case 'changeset':
    case 'changesets':
    case 'cargo':
    case 'poetry':
      return first === 'publish' ? guarded(`${name} publish`) : null;
    case 'twine':
      return first === 'upload' ? guarded('twine upload') : null;
    case 'gem':
      return first === 'push' ? guarded('gem push') : null;
    case 'dotnet':
      return first === 'nuget' && second === 'push' ? guarded('dotnet nuget push') : null;
    case 'docker':
    case 'docker-compose':
      return first === 'push' || (first === 'image' && second === 'push') || (first === 'compose' && second === 'push') || flags.includes('--push')
        ? guarded('docker push')
        : null;
    case 'terraform':
    case 'tofu':
      return first === 'apply' || first === 'destroy' ? guarded(`${name} ${first}`) : null;
    case 'kubectl':
      return kubectl(argv);
    case 'helm':
      return first === 'upgrade' || first === 'install' || first === 'uninstall' ? guarded(`helm ${first}`) : null;
    case 'vercel':
      return flags.includes('--prod') || flags.includes('--production') ? guarded('vercel --prod') : null;
    case 'netlify':
      return first === 'deploy' && (flags.includes('--prod') || flags.includes('-p') || flags.includes('--production')) ? guarded('netlify deploy --prod') : null;
    case 'fly':
    case 'flyctl':
    case 'firebase':
    case 'cdk':
      return first === 'deploy' ? guarded(`${name} deploy`) : null;
    case 'wrangler':
      return first === 'deploy' || first === 'publish' ? guarded(`wrangler ${first}`) : null;
    case 'serverless':
    case 'sls':
      return first === 'deploy' ? guarded(`${name} deploy`) : null;
    case 'pulumi':
      return first === 'up' || first === 'destroy' ? guarded(`pulumi ${first}`) : null;
    case 'gh': {
      const command = `${first} ${second}`;
      if (first === 'api') return ghApi(parseArgs(argv, GH_SPEC));
      return ['release create', 'workflow run', 'pr merge', 'repo delete'].includes(command) ? guarded(`gh ${command}`) : null;
    }
    default:
      return null;
  }
}
