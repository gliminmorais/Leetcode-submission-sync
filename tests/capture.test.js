import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const origin = 'https://leetcode.com';
const location = new URL(origin + '/problems/two-sum/');
const signal = {source: null, origin, data: {
  kind: 'verdict-sync:submitted', id: '12345', slug: 'two-sum'
}};

async function runScript(name, globals) {
  const path = new URL('../extension/' + name + '.js', import.meta.url);
  vm.runInNewContext(await readFile(path, 'utf8'), {URL, Request, location, ...globals}, {
    filename: name + '.js'
  });
}

test('the request observer identifies Submit and keeps Run and failed requests out', async () => {
  const events = [];
  const XHR = class extends EventTarget {
    open() {}
    send() { this.dispatchEvent(new Event('load')); }
  };
  const originalFetch = async (url) => {
    if (String(url).includes('failed')) return new Response('', {status: 403});
    return Response.json({submission_id: 12345, other_field: 'private'});
  };
  const window = {
    fetch: originalFetch,
    XMLHttpRequest: XHR,
    postMessage: (event, target) => events.push({event, target})
  };
  await runScript('observer', {window});
  const submitted = await window.fetch('./submit/', {method: 'POST'});
  assert.equal((await submitted.json()).submission_id, 12345);
  await window.fetch('./interpret_solution/', {method: 'POST'});
  await window.fetch('./submit/?failed', {method: 'POST'});
  await window.fetch('./submit/', {method: 'GET'});
  await window.fetch('https://example.com/problems/two-sum/submit/', {method: 'POST'});
  const xhr = new XHR();
  xhr.open('POST', './submit/');
  Object.assign(xhr, {
    status: 200, responseType: 'json', response: {submission_id: 67890},
    responseURL: origin + '/problems/two-sum/submit/'
  });
  xhr.send();
  await new Promise(resolve => setTimeout(resolve, 0));
  events.sort((a, b) => a.event.id.localeCompare(b.event.id));
  assert.deepEqual(events.map(value => JSON.parse(JSON.stringify(value))), [
    {target: origin, event: signal.data},
    {target: origin, event: {...signal.data, id: '67890'}}
  ]);
});

async function relay({epoch = 3, verdict = 10, submitter = 'solver', preliminaryChecks = []} = {}) {
  const messages = [];
  const requests = [];
  let listener;
  const window = {addEventListener: (_, callback) => {listener = callback;}};
  let completed;
  const finished = new Promise(resolve => { completed = resolve; });
  const fetch = async (url, options) => {
    requests.push(String(url));
    if (String(url).includes('/check/')) {
      if (preliminaryChecks.length) return preliminaryChecks.shift();
      return Response.json({state: 'SUCCESS', submission_id: 12345, status_code: verdict});
    }
    assert.equal(options.headers['X-CSRFToken'], 'example');
    assert.deepEqual(JSON.parse(options.body).variables, {submissionId: 12345, titleSlug: 'two-sum'});
    return Response.json({data: {
      userStatus: {isSignedIn: true, username: 'solver'},
      submissionDetails: {
        statusCode: 10, code: 'return [0, 1]\n', lang: {name: 'python3'},
        user: {username: submitter}, question: {titleSlug: 'two-sum'},
        runtimeDisplay: '3 ms', memoryDisplay: '14 MB'
      },
      question: {
        titleSlug: 'two-sum', questionFrontendId: '1', title: 'Two Sum',
        difficulty: 'Easy', topicTags: [{name: 'Array'}]
      }
    }});
  };
  const chrome = {runtime: {sendMessage: async message => {
    messages.push(JSON.parse(JSON.stringify(message)));
    if (message.type === 'capture') return {ok: true, epoch};
    completed();
    return {ok: true};
  }}};
  await runScript('relay', {
    window, document: {cookie: 'csrftoken=example'}, chrome, fetch, AbortSignal,
    setTimeout: callback => queueMicrotask(callback)
  });
  listener({...signal, source: window});
  if (epoch !== null && verdict === 10) {
    await Promise.race([finished, new Promise(resolve => setImmediate(resolve))]);
  } else {
    await new Promise(resolve => setImmediate(resolve));
  }
  return {messages, requests};
}

test('accepted submission sync uses the matching stored code and problem metadata', async () => {
  const result = await relay();
  assert.deepEqual(result.messages.at(-1), {
    type: 'enqueue', epoch: 3,
    entry: {
      id: '12345', slug: 'two-sum', number: '1', title: 'Two Sum',
      difficulty: 'Easy', topics: ['Array'], language: 'python3',
      code: 'return [0, 1]\n', runtime: '3 ms', memory: '14 MB'
    }
  });
});

test('paused sync makes no judging or source request', async () => {
  const result = await relay({epoch: null});
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.messages.map(item => item.type), ['capture']);
});

test('a wrong answer stops before the source lookup', async () => {
  const result = await relay({verdict: 11});
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.messages.map(item => item.type), ['capture']);
});

test('a pending check with a success code still waits for the final verdict', async () => {
  const result = await relay({
    verdict: 11, preliminaryChecks: [Response.json({state: 'STARTED', status_code: 10})]
  });
  assert.equal(result.requests.length, 2);
  assert.ok(result.requests.every(path => path.includes('/check/')));
  assert.deepEqual(result.messages.map(item => item.type), ['capture']);
});

test('the check cannot authorize source lookup for a different submission ID', async () => {
  const result = await relay({
    preliminaryChecks: [Response.json({state: 'SUCCESS', submission_id: 99999, status_code: 10})]
  });
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.messages.map(item => item.type), ['capture', 'capture-error']);
});

test('a submission from a different LeetCode account does not sync', async () => {
  const result = await relay({submitter: 'someone-else'});
  assert.deepEqual(result.messages.map(item => item.type), ['capture', 'capture-error']);
});
