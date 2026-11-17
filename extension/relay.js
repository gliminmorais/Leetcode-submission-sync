// ISOLATED world: follow a submission ID using the browser's signed-in LeetCode session.
(() => {
  'use strict';

  const origin = 'https://leetcode.com';
  const numericId = /^[1-9]\d{0,18}$/;
  const slugFormat = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const submissionPath = /^\/problems\/([a-z0-9-]{1,120})\/submissions\/([1-9]\d{0,18})\/?$/;
  const active = new Set();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const questionFields = 'question(titleSlug: $titleSlug) { titleSlug questionFrontendId title difficulty topicTags { name } }';
  const detailQuery = idLiteral => [
    'query submissionDetails($titleSlug: String!) {',
    '  userStatus { isSignedIn username }',
    '  submissionDetails(submissionId: ' + idLiteral + ') {',
    '    statusCode code lang { name } user { username } question { titleSlug }',
    '    runtimeDisplay memoryDisplay',
    '  }',
    questionFields,
    '}'
  ].join('\n');
  const historyQuery = [
    'query questionSubmissionList($titleSlug: String!) {',
    '  userStatus { isSignedIn username }',
    '  questionSubmissionList(questionSlug: $titleSlug, offset: 0, limit: 20) {',
    '    submissions { id statusDisplay runtime memory }',
    '  }',
    questionFields,
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

  async function graphql(operationName, query, slug) {
    const headers = {'Content-Type': 'application/json'};
    const cookie = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
    if (cookie) headers['X-CSRFToken'] = decodeURIComponent(cookie);

    const reply = await request('/graphql/', {
      method: 'POST',
      headers,
      body: JSON.stringify({operationName, query, variables: {titleSlug: slug}})
    });
    if (!reply.ok && reply.status !== 400) throw new Error('Submission lookup failed');
    return reply.json();
  }

  function makeEntry(id, slug, question, code, language, runtime, memory) {
    if (question?.titleSlug !== slug || !question.title || !question.questionFrontendId ||
        typeof code !== 'string' || !code.trim() ||
        typeof language !== 'string' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(language)) {
      throw new Error('Invalid submission or problem details');
    }
    return {
      id, slug, number: String(question.questionFrontendId), title: question.title,
      difficulty: question.difficulty,
      topics: (question.topicTags ?? []).map(tag => tag.name),
      code, language, runtime: runtime ?? '', memory: memory ?? ''
    };
  }

  async function readEntry(id, slug) {
    const getDetails = literal => graphql('submissionDetails', detailQuery(literal), slug);
    // Let the schema parse the decimal literal rather than declaring a 32-bit
    // GraphQL Int variable. The ID has already been validated as digits only.
    let {data, errors} = await getDetails(id);
    if (errors?.length && (id.length > 10 || (id.length === 10 && id > '2147483647'))) {
      // Some schemas represent their larger IDs with a string-backed scalar.
      ({data, errors} = await getDetails(JSON.stringify(id)));
    }
    const detail = data?.submissionDetails;
    const question = data?.question;
    const user = data?.userStatus;
    if (errors?.length || !user?.isSignedIn || !user.username ||
        detail?.user?.username !== user.username ||
        detail?.statusCode !== 10 || detail?.question?.titleSlug !== slug) {
      throw new Error('Invalid or inaccessible submission details');
    }
    return makeEntry(id, slug, question, detail.code, detail.lang?.name, detail.runtimeDisplay, detail.memoryDisplay);
  }

  async function readSubmittedEntry(id, slug, submitted) {
    // For a new Submit, use the exact request body if the details query cannot
    // read this ID. Verify the same accepted ID in the signed-in user's history.
    const {data, errors} = await graphql('questionSubmissionList', historyQuery, slug);
    const item = data?.questionSubmissionList?.submissions?.find(row => String(row.id) === id);
    if (errors?.length || !data?.userStatus?.isSignedIn || item?.statusDisplay !== 'Accepted') {
      throw new Error('Submission is missing from the signed-in account history');
    }
    return makeEntry(id, slug, data.question, submitted.code, submitted.language, item.runtime, item.memory);
  }

  async function onSubmission(id, slug, submitted) {
    const capture = await chrome.runtime.sendMessage({type: 'capture', id, slug});
    if (!capture?.ok) return {ok: false, error: 'Verdict Sync could not start the submission check.'};
    if (capture.epoch == null) {
      return {ok: false, error: 'This submission is already queued or synced, or auto-sync is off.'};
    }
    const {epoch} = capture;
    let accepted = false;
    try {
      accepted = await verdict(id);
      if (!accepted) return {ok: false, error: 'This submission was not accepted by LeetCode.'};
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
      if (!entry && submitted && typeof submitted.code === 'string' && submitted.code.length <= 96 * 1024) {
        entry = await readSubmittedEntry(id, slug, submitted);
      }
      if (!entry) throw new Error('Accepted submission details unavailable');
      const queued = await chrome.runtime.sendMessage({type: 'enqueue', epoch, entry});
      if (!queued?.ok) throw new Error('Submission could not be queued');
      if (!queued.queued) return {ok: false, error: 'The submission was not queued. Check Activity for details.'};
      return {ok: true};
    } catch {
      const message = accepted
        ? 'Could not read the accepted submission from LeetCode. Sign in and reload the submission page.'
        : 'Could not confirm the LeetCode verdict. Reload the submission page and try again.';
      await chrome.runtime.sendMessage({type: 'capture-error', epoch, accepted});
      return {ok: false, error: message};
    }
  }

  async function captureSubmission(id, slug, submitted) {
    if (typeof id !== 'string' || !numericId.test(id) ||
        typeof slug !== 'string' || slug.length > 120 || !slugFormat.test(slug)) {
      return {ok: false, error: 'Open a LeetCode submission before syncing.'};
    }
    if (active.has(id) || active.size >= 8) {
      return {ok: false, error: 'Verdict Sync is already checking submissions. Check Activity in a moment.'};
    }
    active.add(id);
    try {
      return await onSubmission(id, slug, submitted);
    } finally {
      active.delete(id);
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== origin || event.data?.kind !== 'verdict-sync:submitted') return;
    const {id, slug, submitted} = event.data;
    // The extension context can disappear during a reload or update.
    void captureSubmission(id, slug, submitted).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== 'sync-open-submission' || sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL('popup.html')) return;
    const [, slug, id] = submissionPath.exec(location.pathname) ?? [];
    captureSubmission(id, slug).then(reply, () => {
      reply({ok: false, error: 'Could not check this submission. Reload the LeetCode tab and try again.'});
    });
    return true;
  });
})();
