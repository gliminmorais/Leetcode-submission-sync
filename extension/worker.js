import { captureIdentity, normalizeEntry } from './model.js';
import { connectRepository, commitSubmission, GitHubError } from './github.js';

const STORE = 'verdictSync';
const ALARM = 'verdict-sync-retry';
const QUEUE_LIMIT = 24;
const ACCOUNT_PAGE = chrome.runtime.getURL('popup.html');
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let stateLock = Promise.resolve();
let draining;

async function readState() {
  await storageReady;
  return (await chrome.storage.local.get(STORE))[STORE] ?? {
    connection: null, enabled: false, epoch: '', jobs: [], recent: [], activity: null
  };
}

function updateState(change) {
  const next = stateLock.then(async () => {
    const state = await readState();
    const result = change(state);
    await chrome.storage.local.set({ [STORE]: state });
    return result;
  });
  stateLock = next.catch(() => {});
  return next;
}

function view(state) {
  const { connection, enabled, jobs, activity } = state;
  return {
    connection: connection && {
      repo: connection.repo, branch: connection.branch, username: connection.username
    },
    enabled, pending: jobs.length, activity,
    issue: jobs.find(job => job.error)?.error ?? null
  };
}

async function ensureAlarm() {
  if (!await chrome.alarms.get(ALARM)) {
    await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  }
}

async function sendQueued() {
  await ensureAlarm();
  while (true) {
    const snapshot = await readState();
    if (!snapshot.enabled || !snapshot.connection) return;
    const job = snapshot.jobs.find(item => !item.blocked && item.nextAt <= Date.now());
    if (!job) return;
    const sameConnection = state => state.connection?.key === snapshot.connection.key;
    try {
      const canWrite = async () => {
        const state = await readState();
        return state.enabled && sameConnection(state);
      };
      const result = await commitSubmission(snapshot.connection, job.entry, fetch, canWrite);
      if (!result) return;
      await updateState(state => {
        if (!sameConnection(state)) return;
        state.jobs = state.jobs.filter(item => item.entry.id !== job.entry.id);
        state.recent = [job.entry.id, ...state.recent].slice(0, 250);
        state.activity = { kind: 'synced', title: job.entry.title, url: result.url, at: Date.now() };
      });
    } catch (error) {
      await updateState(state => {
        if (!sameConnection(state)) return;
        const queued = state.jobs.find(item => item.entry.id === job.entry.id);
        if (!queued) return;
        queued.attempts++;
        queued.blocked = !error.retryable;
        const backoffAt = Date.now() + Math.min(60, 2 ** (queued.attempts - 1)) * 60_000;
        queued.nextAt = Math.max(backoffAt, error.retryAt || 0);
        queued.error = error instanceof GitHubError ? error.message : 'Unable to sync. Select Retry to try again.';
      });
    }
  }
}

function kick() {
  draining ??= sendQueued().catch(error => {
    console.error('Verdict Sync could not process its local queue.', error?.name);
  }).finally(() => { draining = undefined; });
}

async function fromPopup(message) {
  switch (message.type) {
    case 'status':
      return view(await readState());
    case 'connect': {
      if ((await readState()).connection) throw new Error('Disconnect before changing the repository.');
      const token = typeof message.token === 'string' ? message.token.trim() : '';
      const details = await connectRepository(message.repo, token);
      return updateState(state => {
        if (state.connection) throw new Error('Disconnect before changing the repository.');
        state.connection = { ...details, token, key: crypto.randomUUID() };
        state.enabled = true;
        state.epoch = crypto.randomUUID();
        return view(state);
      });
    }
    case 'toggle': {
      const result = await updateState(state => {
        if (!state.connection) throw new Error('Connect GitHub first.');
        state.enabled = message.enabled === true;
        state.epoch = crypto.randomUUID();
        return view(state);
      });
      if (result.enabled) kick();
      return result;
    }
    case 'update-token': {
      const { connection } = await readState();
      if (!connection) throw new Error('Connect GitHub first.');
      const token = typeof message.token === 'string' ? message.token.trim() : '';
      const details = await connectRepository(connection.repo, token);
      const result = await updateState(state => {
        if (state.connection?.key !== connection.key || details.repoId !== connection.repoId) {
          throw new Error('The selected repository changed. Reopen the popup.');
        }
        state.connection = { ...state.connection, token, username: details.username, key: crypto.randomUUID() };
        state.epoch = crypto.randomUUID();
        for (const job of state.jobs) {
          job.nextAt = 0;
          job.blocked = false;
          job.error = null;
          job.attempts = 0;
        }
        return view(state);
      });
      if (result.enabled) kick();
      return result;
    }
    case 'retry': {
      const result = await updateState(state => {
        if (!state.enabled) throw new Error('Turn on auto-sync first.');
        for (const job of state.jobs) {
          job.nextAt = 0;
          job.blocked = false;
          job.error = null;
        }
        return view(state);
      });
      kick();
      return result;
    }
    case 'disconnect':
      return updateState(state => {
        if (state.jobs.length && message.discardPending !== true) {
          throw new Error('Confirm disconnecting with unsynced submissions.');
        }
        Object.assign(state, {
          connection: null, enabled: false, epoch: '', jobs: [], recent: [], activity: null
        });
        return view(state);
      });
    default:
      throw new Error('Unsupported request.');
  }
}

async function fromLeetCode(message) {
  if (message.type === 'capture') {
    const state = await readState();
    const valid = captureIdentity(message.id, message.slug) && !state.recent.includes(message.id)
      && !state.jobs.some(job => job.entry.id === message.id);
    return { epoch: valid && state.enabled ? state.epoch : null };
  }
  if (message.type === 'capture-error') {
    await updateState(state => {
      if (state.enabled && state.epoch === message.epoch) state.activity = {
        kind: 'error',
        title: message.accepted === true
          ? 'LeetCode accepted the submission, but Verdict Sync could not read the saved code.'
          : 'Could not confirm the LeetCode verdict. Reload the submission page and try again.',
        at: Date.now()
      };
    });
    return {};
  }
  if (message.type !== 'enqueue') throw new Error('Unsupported request.');
  const entry = normalizeEntry(message.entry);
  const queued = await updateState(state => {
    if (!state.enabled || state.epoch !== message.epoch || state.recent.includes(entry.id)
        || state.jobs.some(job => job.entry.id === entry.id)) return false;
    if (state.jobs.length >= QUEUE_LIMIT) {
      state.activity = {
        kind: 'error', title: 'The sync queue is full. Retry pending submissions, then submit again.', at: Date.now()
      };
      return false;
    }
    state.jobs.push({ entry, nextAt: 0, attempts: 0, blocked: false, error: null });
    return true;
  });
  if (queued) kick();
  return { queued };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== 'string' || sender.id !== chrome.runtime.id) return;
  const fromTrustedPopup = sender.url === ACCOUNT_PAGE;
  const fromLeetCodeTab = sender.frameId === 0 && sender.tab?.id >= 0
    && sender.origin === 'https://leetcode.com';
  if (!fromTrustedPopup && !fromLeetCodeTab) return;
  const action = fromTrustedPopup ? fromPopup(message) : fromLeetCode(message);
  action.then(result => reply({ ok: true, ...result }), error => {
    reply({ ok: false, error: String(error?.message ?? 'Something went wrong.') });
  });
  return true;
});

chrome.runtime.onInstalled.addListener(kick);
chrome.runtime.onStartup.addListener(kick);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) kick(); });
