import { parseArgs, type Simple } from './command.ts';
import { ask, type Decision } from './types.ts';

const RULE = 'deploy-publish';
const KUBECTL_SPEC = {
  valueShort: 'ns',
  valueLong: ['--context', '--namespace', '--cluster', '--kubeconfig', '--user', '--as', '--token', '--server', '--filename'],
};

function guarded(what: string): Decision {
  return ask(RULE, `${what} affects shared or production systems. Confirm with the user before running it.`);
}

function kubectl(argv: string[]): Decision | null {
  const parsed = parseArgs(argv, KUBECTL_SPEC);
  const [sub, action] = parsed.positionals;
  const mutating = sub === 'apply' || sub === 'delete' || (sub === 'rollout' && action !== 'status' && action !== 'history');
  const targets = [parsed.options.get('--context'), parsed.options.get('--namespace'), parsed.options.get('-n')];
  if (!mutating || !targets.some((t) => /prod/i.test(t ?? ''))) return null;
  return guarded(`kubectl ${sub} against a prod context or namespace`);
}

export function evaluateDeploy(simple: Simple): Decision | null {
  const { name, argv } = simple;
  const parsed = parseArgs(argv, { valueShort: 'R', valueLong: ['--repo'] });
  const [first, second] = parsed.positionals;
  const flags = parsed.flags;
  switch (name) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return first === 'publish' || second === 'publish' ? guarded(`${name} publish`) : null;
    case 'docker':
      return first === 'push' || (first === 'image' && second === 'push') ? guarded('docker push') : null;
    case 'terraform':
    case 'tofu':
      return first === 'apply' || first === 'destroy' ? guarded(`${name} ${first}`) : null;
    case 'kubectl':
      return kubectl(argv);
    case 'helm':
      return first === 'upgrade' || first === 'install' || first === 'uninstall' ? guarded(`helm ${first}`) : null;
    case 'vercel':
      return flags.includes('--prod') || flags.includes('--production') ? guarded('vercel --prod') : null;
    case 'fly':
    case 'flyctl':
      return first === 'deploy' ? guarded(`${name} deploy`) : null;
    case 'gh': {
      const command = `${first} ${second}`;
      return ['release create', 'workflow run', 'pr merge', 'repo delete'].includes(command) ? guarded(`gh ${command}`) : null;
    }
    default:
      return null;
  }
}
