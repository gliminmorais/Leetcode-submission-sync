// ISOLATED world: follow a submission ID using the browser's signed-in LeetCode session.
(() => {
  'use strict';

  const origin = 'https://leetcode.com';
  const numericId = /^[1-9]\d{0,9}$/;
  const slugFormat = /^[a-z0-9-]{1,200}$/;
  const active = new Set();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const query = [
    'query submissionDetails($submissionId: Int!, $titleSlug: String!) {',
    '  userStatus { isSignedIn username }',
    '  submissionDetails(submissionId: $submissionId) {',
    '    statusCode code lang { name } user { username } question { titleSlug }',
    '    runtimeDisplay memoryDisplay',
    '  }',
    '  question(titleSlug: $titleSlug) {',
    '    titleSlug questionFrontendId title difficulty topicTags { name }',
    '  }',
    '}'
  ].join('\n');

  async function request(path, options = {}) {
    return fetch(origin + path, {
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
      ...options
    });
  }

  async function verdict(id) {
    const root = '/submissions/detail/' + id;
    let path = root + '/v2/check/';
    const deadline = Date.now() + 120_000;
    for (let delay = 750; Date.now() < deadline; delay = Math.min(delay * 2, 5_000)) {
      await wait(delay);
      let reply;
      try {
        reply = await request(path);
      } catch {
        continue;
      }
      if (path.endsWith('/v2/check/') && (reply.status === 404 || reply.status === 405)) {
        path = root + '/check/';
        continue;
      }
      if (reply.status === 429 || reply.status >= 500) continue;
      if (!reply.ok) throw new Error('Judge request rejected');
      const result = await reply.json();
      if (result?.submission_id != null && String(result.submission_id) !== id) {
        throw new Error('Judge returned a different submission');
      }
      if (result?.state === 'SUCCESS' && Number.isInteger(result.status_code)) {
        return result.status_code === 10;
      }
      if (result?.state !== 'PENDING' && result?.state !== 'STARTED') {
        throw new Error('Unrecognized judge result');
      }
    }
    throw new Error('Judge timed out');
  }

  async function readEntry(id, slug) {
    const headers = {'Content-Type': 'application/json'};
    const cookie = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
    if (cookie) headers['X-CSRFToken'] = decodeURIComponent(cookie);

    const reply = await request('/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationName: 'submissionDetails', query,
        variables: {submissionId: Number(id), titleSlug: slug}
      })
    });
    if (!reply.ok) throw new Error('Submission lookup failed');
    const {data, errors} = await reply.json();
    const detail = data?.submissionDetails;
    const question = data?.question;
    const user = data?.userStatus;
    if (errors?.length || !user?.isSignedIn || !user.username ||
        detail?.user?.username !== user.username ||
        detail?.statusCode !== 10 || detail?.question?.titleSlug !== slug ||
        question?.titleSlug !== slug || typeof detail.code !== 'string' || !detail.code.trim() ||
        typeof detail.lang?.name !== 'string' || !question.title || !question.questionFrontendId) {
      throw new Error('Invalid or inaccessible submission details');
    }
    return {
      id, slug, number: String(question.questionFrontendId), title: question.title,
      difficulty: question.difficulty,
      topics: (question.topicTags ?? []).map(tag => tag.name),
      code: detail.code, language: detail.lang.name,
      runtime: detail.runtimeDisplay ?? '', memory: detail.memoryDisplay ?? ''
    };
  }

  async function onSubmission(id, slug) {
    const capture = await chrome.runtime.sendMessage({type: 'capture', id, slug});
    if (!capture?.ok || capture.epoch == null) return;
    const {epoch} = capture;
    let accepted = false;
    try {
      accepted = await verdict(id);
      if (!accepted) return;
      // The details query may briefly lag the judge's final response.
      let entry;
      for (const delay of [0, 1_000, 2_000]) {
        if (delay) await wait(delay);
        try {
          entry = await readEntry(id, slug);
          break;
        } catch {
          // Retry with the same verified ID and slug.
        }
      }
      if (!entry) throw new Error('Accepted submission details unavailable');
      const queued = await chrome.runtime.sendMessage({type: 'enqueue', epoch, entry});
      if (!queued?.ok) throw new Error('Submission could not be queued');
    } catch {
      const message = accepted
        ? 'Could not read the accepted submission from LeetCode. Sign in, reload, and submit again.'
        : 'Could not confirm the LeetCode verdict. Reload the problem and try submitting again.';
      await chrome.runtime.sendMessage({type: 'capture-error', epoch, message});
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== origin || event.data?.kind !== 'verdict-sync:submitted') return;
    const {id, slug} = event.data;
    if (typeof id !== 'string' || !numericId.test(id) || Number(id) > 2_147_483_647 ||
        typeof slug !== 'string' || !slugFormat.test(slug) || active.has(id) || active.size >= 8) return;
    active.add(id);
    // The extension context can disappear during a reload or update.
    void onSubmission(id, slug).catch(() => {}).finally(() => active.delete(id));
  });
})();
