import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommit, parseRepository } from '../extension/model.js';
import { commitSubmission } from '../extension/github.js';
import { readLedger, recordSubmission } from '../extension/stats.js';

const entry = {
  id: '123456', slug: 'two-sum', number: '1', title: 'Two Sum',
  difficulty: 'Easy', topics: ['Array', 'Hash Table'],
  language: 'python3', code: 'return [0, 1] # café\n', runtime: '2 ms', memory: '16 MB'
};

test('files contain unchanged source and safe, distinct language and submission paths', () => {
  const { files } = buildCommit(entry);
  assert.equal(files['array/easy/0001-two-sum/python3-123456.py'], entry.code);
  assert.match(files['array/easy/0001-two-sum/README.md'], /Easy[\s\S]*Array/);
  assert.match(files['array/easy/0001-two-sum/README.md'], /leetcode\.com\/problems\/two-sum/);
  assert.throws(() => buildCommit({ ...entry, slug: '../workflow' }));
  assert.throws(() => buildCommit({ ...entry, language: '../python' }));
});

test('only a GitHub repository URL or owner/repo can become a destination', () => {
  assert.equal(parseRepository('https://github.com/octocat/leetcode.git'), 'octocat/leetcode');
  assert.equal(parseRepository(' octocat/leetcode '), 'octocat/leetcode');
  for (const input of ['https://elsewhere.com/octocat/leetcode', 'owner/..', 'owner/repo/extra']) {
    assert.throws(() => parseRepository(input));
  }
});

test('a conflicting branch update merges both submissions and atomically commits all four files', async () => {
  let currentHead = 'head1';
  const pinnedFolder = 'hash-table/easy/0001-two-sum';
  const previous = { ...entry, id: '123455', language: 'cpp', topics: ['Hash Table'] };
  const existing = recordSubmission(readLedger(null), previous, pinnedFolder);
  const commits = [];
  const reads = [];
  const request = async (url, {method, body, headers}) => {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.replace('/repos/octo/leet', '');
    const data = body ? JSON.parse(body) : undefined;
    if (path === '/git/ref/heads/main') return Response.json({object: {sha: currentHead}});
    if (path === '/contents/.verdict-sync/index.json') {
      assert.equal(headers.Accept, 'application/vnd.github.raw+json');
      const ref = parsedUrl.searchParams.get('ref');
      assert.equal(ref, currentHead);
      reads.push(ref);
      return ref === 'head2' ? new Response(existing.index) : Response.json({}, {status: 404});
    }
    if (path.startsWith('/git/commits/')) return Response.json({tree: {sha: 'tree-' + currentHead}});
    if (path === '/git/trees') {
      assert.equal(data.base_tree, 'tree-' + currentHead);
      const folder = currentHead === 'head1' ? 'array/easy/0001-two-sum' : pinnedFolder;
      const files = Object.fromEntries(data.tree.map(file => [file.path, file.content]));
      assert.deepEqual(Object.keys(files).sort(), [
        '.verdict-sync/index.json', 'STATS.md', folder + '/README.md', folder + '/python3-123456.py',
      ].sort());
      assert.equal(files[folder + '/python3-123456.py'], entry.code);
      const merged = readLedger(files['.verdict-sync/index.json']);
      assert.equal(merged.problems['two-sum'].folder, folder);
      assert.equal(recordSubmission(merged, entry, folder), null);
      if (currentHead === 'head2') assert.equal(recordSubmission(merged, previous, folder), null);
      return Response.json({sha: 'new-tree'});
    }
    if (path === '/git/commits') {
      commits.push(data.parents[0]);
      return Response.json({sha: 'new-' + currentHead});
    }
    assert.equal(path, '/git/refs/heads/main');
    assert.equal(method, 'PATCH');
    assert.equal(data.force, false);
    if (currentHead === 'head1') {
      currentHead = 'head2';
      return Response.json({message: 'Update is not a fast forward'}, {status: 422});
    }
    return Response.json({});
  };
  const result = await commitSubmission({repo: 'octo/leet', branch: 'main', token: 'test'}, entry, request);
  assert.deepEqual(commits, ['head1', 'head2']);
  assert.deepEqual(reads, ['head1', 'head2']);
  assert.match(result.url, /\/commit\/new-head2$/);
});
