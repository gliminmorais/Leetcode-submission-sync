import assert from 'node:assert/strict';
import test from 'node:test';
import { connectRepository, commitSubmission, GitHubError } from '../extension/github.js';
import { readLedger, recordSubmission } from '../extension/stats.js';

const token = 'github_pat_example';
const target = {repo: 'octo/leet', branch: 'main', repoId: 23, token};
const entry = {
  id: '4321', slug: 'two-sum', number: '1', title: 'Two Sum',
  difficulty: 'Easy', topics: [], language: 'python3', code: 'pass\n',
};

test('connect saves the canonical repository and default branch only if it exists', async () => {
  const request = async url => {
    const path = new URL(url).pathname.toLowerCase();
    if (path === '/user') return Response.json({login: 'octo'});
    if (path === '/repos/octo/leet') {
      return Response.json({id: 23, full_name: 'Octo/Leet', default_branch: 'solutions/main', permissions: {push: true}});
    }
    assert.equal(path, '/repos/octo/leet/git/ref/heads/solutions/main');
    return Response.json({ref: 'refs/heads/solutions/main', object: {sha: 'head', type: 'commit'}});
  };
  assert.deepEqual(await connectRepository('octo/leet', token, request), {
    repo: 'Octo/Leet', repoId: 23, branch: 'solutions/main', username: 'octo',
  });
  await assert.rejects(connectRepository('octo/leet', token, url =>
    url.includes('/git/ref/') ? Response.json({}, {status: 409}) : request(url)
  ), /initial commit/i);
});

test('a repository replaced at the same name cannot receive a queued upload', async () => {
  let reads = 0;
  await assert.rejects(commitSubmission(target, entry, async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(new URL(url).pathname, '/repos/octo/leet');
    reads++;
    return Response.json({id: 24, full_name: 'octo/leet'});
  }), /reconnect/i);
  assert.equal(reads, 1);
});

test('a pause before updating the branch leaves the remote branch untouched', async () => {
  let paused = false;
  const result = await commitSubmission(target, entry, async (url, options) => {
    const path = new URL(url).pathname;
    assert.notEqual(options.method, 'PATCH');
    if (path === '/repos/octo/leet') return Response.json({id: 23, full_name: 'octo/leet'});
    if (path.endsWith('/heads/main')) return Response.json({object: {sha: 'head'}});
    if (path.endsWith('/contents/.verdict-sync/index.json')) return Response.json({}, {status: 404});
    if (path.endsWith('/commits/head')) return Response.json({tree: {sha: 'old-tree'}});
    if (path.endsWith('/trees')) return Response.json({sha: 'new-tree'});
    paused = true;
    return Response.json({sha: 'new-commit'});
  }, async () => !paused);
  assert.equal(result, null);
});

test('an existing ledger entry prevents a duplicate commit after a browser retry', async () => {
  const {index} = recordSubmission(readLedger(null), entry, 'uncategorized/easy/0001-two-sum');
  const result = await commitSubmission(target, entry, async (url, options) => {
    assert.equal(options.method, 'GET');
    const path = new URL(url).pathname;
    if (path === '/repos/octo/leet') return Response.json({id: 23});
    if (path.endsWith('/heads/main')) return Response.json({object: {sha: 'head'}});
    assert.equal(path, '/repos/octo/leet/contents/.verdict-sync/index.json');
    return new Response(index);
  });
  assert.deepEqual(result, {url: 'https://github.com/octo/leet/commit/head', unchanged: true});
});

test('a corrupt repository ledger stops sync before any GitHub write', async () => {
  await assert.rejects(commitSubmission(target, entry, async (url, options) => {
    assert.equal(options.method, 'GET');
    const path = new URL(url).pathname;
    if (path === '/repos/octo/leet') return Response.json({id: 23});
    if (path.endsWith('/heads/main')) return Response.json({object: {sha: 'head'}});
    assert.equal(path, '/repos/octo/leet/contents/.verdict-sync/index.json');
    return new Response('{broken');
  }), error => error instanceof GitHubError && !error.retryable && error.message.includes('.verdict-sync/index.json'));
});

test('expired credentials report a sanitized error without retrying', async () => {
  await assert.rejects(connectRepository('octo/leet', token, async () =>
    Response.json({message: token}, {status: 401})
  ), error => error instanceof GitHubError && !error.retryable && !error.message.includes(token));
});
