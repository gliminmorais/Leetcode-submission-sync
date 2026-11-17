import { buildCommit, parseRepository } from './model.js';
import { readLedger, recordSubmission } from './stats.js';

const API = 'https://api.github.com';
const MAX_REF_ATTEMPTS = 3;
const EXPIRED_TOKEN = 'GitHub rejected the token. Use a valid token for this repository.';
const RECONNECT_REPO = 'The connected repository has changed. Reconnect it to resume sync.';
const MISSING_BRANCH = 'GitHub could not find the target branch. Check the repository and token access.';
const INDEX_PATH = '.verdict-sync/index.json';

export class GitHubError extends Error {
  constructor(message, { retryable = false, retryAt = 0, refConflict = false } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.retryable = retryable;
    this.retryAt = retryAt;
    this.refConflict = refConflict;
  }
}

function githubClient(token, request) {
  return async (path, { method = 'GET', data, missing, updatingRef = false, optionalText = false } = {}) => {
    let response;
    try {
      response = await request(API + path, {
        method,
        headers: {
          Accept: optionalText ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GitHubError('Could not reach GitHub. Sync will retry when it can.', { retryable: true });
    }

    const { status, headers } = response;
    if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
      throw new GitHubError(RECONNECT_REPO);
    }
    if (optionalText && status === 404) return null;
    if (optionalText && response.ok) {
      try {
        return await response.text();
      } catch {
        throw new GitHubError('GitHub could not send the repository stats index. Sync will retry.', { retryable: true });
      }
    }
    const payload = await response.json().catch(() => null);
    if (response.ok && payload && typeof payload === 'object') return payload;

    const message = typeof payload?.message === 'string' ? payload.message : '';
    const retryAfter = headers.get('retry-after');
    const primaryRateLimit = headers.get('x-ratelimit-remaining') === '0';
    if (status === 429 || (status === 403 && (primaryRateLimit || retryAfter || /rate limit/i.test(message)))) {
      const reset = primaryRateLimit ? 1000 * Number(headers.get('x-ratelimit-reset')) : 0;
      const wait = retryAfter === null ? 0 : 1000 * Number(retryAfter);
      throw new GitHubError('GitHub is limiting requests. Sync will retry later.', {
        retryable: true, retryAt: Math.max(Date.now() + 60_000, reset || 0, Date.now() + (wait || 0)),
      });
    }
    if (status >= 500 || status === 408 || response.ok) {
      throw new GitHubError('GitHub is temporarily unavailable. Sync will retry.', { retryable: true });
    }
    if (status === 401) throw new GitHubError(EXPIRED_TOKEN);
    if (status === 403) {
      throw new GitHubError('GitHub denied access. Check the token’s repository access and Contents permissions.');
    }
    if ((status === 404 || status === 409) && missing) throw new GitHubError(missing);
    if (updatingRef && (status === 409 || status === 422) && /fast.forward|reference update failed|reference changed/i.test(message)) {
      throw new GitHubError('The GitHub branch changed during sync.', { retryable: true, refConflict: true });
    }
    if (updatingRef && (status === 409 || status === 422)) {
      throw new GitHubError('GitHub refused the branch update. Check the branch’s protection rules.');
    }
    throw new GitHubError('GitHub refused the request. Check the repository, branch, and token permissions.');
  };
}

function branchPath(branch) {
  if (typeof branch !== 'string' || !branch || branch.length > 1024) {
    throw new GitHubError(MISSING_BRANCH);
  }
  const segments = branch.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new GitHubError(MISSING_BRANCH);
  }
  return segments.map(encodeURIComponent).join('/');
}

function objectId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(value)) {
    throw new GitHubError('GitHub returned an incomplete commit response.', { retryable: true });
  }
  return value;
}

function branchHead(response, branch, missing = MISSING_BRANCH) {
  if (response.ref && response.ref !== `refs/heads/${branch}` ||
      response.object?.type && response.object.type !== 'commit') {
    throw new GitHubError(missing);
  }
  return objectId(response.object?.sha);
}

function checkedLedger(text) {
  try {
    return readLedger(text);
  } catch {
    throw new GitHubError(`GitHub has an unreadable ${INDEX_PATH}. Restore a valid copy from repository history and retry.`);
  }
}

function updatedStats(ledger, entry, folder) {
  try {
    return recordSubmission(ledger, entry, folder);
  } catch {
    throw new GitHubError(`Could not update ${INDEX_PATH}. Check the repository stats index before retrying.`);
  }
}

export async function connectRepository(input, token, request = fetch) {
  const enteredRepo = parseRepository(input);
  const cleanToken = typeof token === 'string' ? token.trim() : '';
  if (!/^github_pat_[a-z0-9_]+$/i.test(cleanToken)) {
    throw new GitHubError('Enter a GitHub fine-grained personal access token.');
  }
  const github = githubClient(cleanToken, request);
  const user = await github('/user');
  if (typeof user.login !== 'string' || !user.login) throw new GitHubError(EXPIRED_TOKEN);

  const repository = await github(`/repos/${enteredRepo}`, {
    missing: 'GitHub could not open that repository. Check its name and the token’s repository access.',
  });
  if (repository.archived || repository.disabled || repository.permissions?.push === false) {
    throw new GitHubError('Choose a repository where you have write access and which is not archived.');
  }
  const repo = parseRepository(repository.full_name);
  const repoId = repository.id;
  if (!Number.isSafeInteger(repoId) || repoId < 1) throw new GitHubError(RECONNECT_REPO);
  const branch = repository.default_branch;
  const missing = 'The default branch needs an initial commit. Add a README in GitHub and connect again.';
  if (!branch) throw new GitHubError(missing);
  const head = await github(`/repos/${repo}/git/ref/heads/${branchPath(branch)}`, { missing });
  branchHead(head, branch, missing);
  return { repo, repoId, branch, username: user.login };
}

export async function commitSubmission({ repo, repoId, branch, token }, entry, request = fetch, canWrite = async () => true) {
  const fullRepo = parseRepository(repo);
  const repoPath = `/repos/${fullRepo}`;
  const refPath = `heads/${branchPath(branch)}`;
  const github = githubClient(token, request);
  if (!await canWrite()) return null;

  if (repoId !== undefined) {
    const repository = await github(repoPath, { missing: RECONNECT_REPO });
    if (repository.id !== repoId) throw new GitHubError(RECONNECT_REPO);
  }

  for (let attempt = 0; attempt < MAX_REF_ATTEMPTS; attempt++) {
    const ref = await github(`${repoPath}/git/ref/${refPath}`, { missing: MISSING_BRANCH });
    const head = branchHead(ref, branch);
    const indexText = await github(`${repoPath}/contents/${INDEX_PATH}?ref=${head}`, { optionalText: true });
    const ledger = checkedLedger(indexText);
    const pinnedFolder = Object.hasOwn(ledger.problems, entry.slug) ? ledger.problems[entry.slug].folder : undefined;
    const { files, message, folder } = buildCommit(entry, pinnedFolder);
    const stats = updatedStats(ledger, entry, folder);
    if (!stats) return { url: `https://github.com/${fullRepo}/commit/${head}`, unchanged: true };
    const treeEntries = Object.entries({ ...files, 'STATS.md': stats.stats, [INDEX_PATH]: stats.index })
      .map(([path, content]) => ({ path, content, mode: '100644', type: 'blob' }));

    const latest = await github(`${repoPath}/git/commits/${head}`);
    const baseTree = objectId(latest.tree?.sha);
    const tree = await github(`${repoPath}/git/trees`, {
      method: 'POST', data: { base_tree: baseTree, tree: treeEntries },
    });
    const newTree = objectId(tree.sha);
    if (newTree === baseTree) return { url: `https://github.com/${fullRepo}/commit/${head}`, unchanged: true };

    const commit = await github(`${repoPath}/git/commits`, {
      method: 'POST', data: { message, tree: newTree, parents: [head] },
    });
    const sha = objectId(commit.sha);
    if (!await canWrite()) return null;
    try {
      await github(`${repoPath}/git/refs/${refPath}`, {
        method: 'PATCH', data: { sha, force: false }, missing: MISSING_BRANCH, updatingRef: true,
      });
      return { url: `https://github.com/${fullRepo}/commit/${sha}`, unchanged: false };
    } catch (error) {
      if (!(error instanceof GitHubError) || !error.refConflict || attempt === MAX_REF_ATTEMPTS - 1) throw error;
    }
  }
}
