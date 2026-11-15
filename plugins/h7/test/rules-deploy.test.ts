import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, ruleOf } from './support.ts';

const ASK = 'ask:deploy-publish';

function check(rows: [string, string | null][]): void {
  for (const [command, expected] of rows) {
    assert.equal(ruleOf(command), expected, command);
  }
}

describe('deploy and publish commands', () => {
  it('asks for package publishing', () => {
    check([
      ['npm publish', ASK],
      ['npm publish --access public', ASK],
      ['pnpm publish', ASK],
      ['pnpm -r publish', ASK],
      ['yarn publish', ASK],
      ['yarn npm publish', ASK],
      ['npm.cmd publish', ASK],
      ['npm -w pkg publish', ASK],
      ['npm install', null],
      ['npm run publish-docs', null],
      ['npm test', null],
      ['pnpm install', null],
      ['yarn', null],
      ['npm', null],
    ]);
  });

  it('asks for docker push, terraform, helm, fly and vercel production', () => {
    check([
      ['docker push ghcr.io/x/y:latest', ASK],
      ['docker image push x', ASK],
      ['docker --debug push x', ASK],
      ['docker build .', null],
      ['docker image ls', null],
      ['docker run x push', null],
      ['terraform apply', ASK],
      ['terraform apply -auto-approve', ASK],
      ['terraform destroy', ASK],
      ['terraform -chdir=infra apply', ASK],
      ['tofu apply', ASK],
      ['terraform plan', null],
      ['terraform', null],
      ['helm upgrade --install app ./chart', ASK],
      ['helm install app ./chart', ASK],
      ['helm uninstall app', ASK],
      ['helm list', null],
      ['helm template x', null],
      ['fly deploy', ASK],
      ['flyctl deploy --remote-only', ASK],
      ['fly status', null],
      ['vercel --prod', ASK],
      ['vercel deploy --prod', ASK],
      ['vercel --production', ASK],
      ['vercel deploy', null],
      ['vercel', null],
    ]);
  });

  it('asks for the listed gh commands only', () => {
    check([
      ['gh release create v1.0.0', ASK],
      ['gh workflow run ci.yml', ASK],
      ['gh pr merge 12 --squash', ASK],
      ['gh repo delete owner/name --yes', ASK],
      ['gh -R owner/name pr merge 12', ASK],
      ['gh --repo owner/name release create v1', ASK],
      ['gh pr create', null],
      ['gh pr view 12', null],
      ['gh release list', null],
      ['gh workflow list', null],
      ['gh repo view', null],
      ['gh', null],
    ]);
  });

  it('asks for kubectl mutations in prod contexts or namespaces only', () => {
    check([
      ['kubectl apply -f x.yaml --context prod-eu', ASK],
      ['kubectl --context=gke_prod_cluster delete pod x', ASK],
      ['kubectl apply -n production -f x.yaml', ASK],
      ['kubectl apply -nprod -f x.yaml', ASK],
      ['kubectl apply --namespace my-PROD-ns -f x', ASK],
      ['kubectl --namespace=prod rollout restart deploy/x', ASK],
      ['kubectl rollout undo deploy/x -n prod', ASK],
      ['kubectl rollout status deploy/x -n prod', null],
      ['kubectl rollout history deploy/x -n prod', null],
      ['kubectl apply -f x.yaml', null],
      ['kubectl apply -f x.yaml --context staging -n dev', null],
      ['kubectl get pods -n prod', null],
      ['kubectl describe pod x --context prod', null],
      ['kubectl', null],
    ]);
  });

  it('names the guarded action and asks the user to confirm', () => {
    const d = decide('npm publish');
    assert.equal(d?.decision, 'ask');
    assert.match(d?.reason ?? '', /npm publish/);
    assert.match(d?.reason ?? '', /Confirm with the user/);
    assert.match(decide('kubectl apply -n prod -f x')?.reason ?? '', /kubectl apply against a prod/);
  });

  it('is found inside wrappers and nested shells', () => {
    check([
      ['sudo npm publish', ASK],
      ['bash -c "docker push x"', ASK],
      ['CI=1 npm publish', ASK],
      ['echo $(npm publish)', ASK],
      ['echo "npm publish"', null],
    ]);
  });
});
