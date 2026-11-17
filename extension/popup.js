const element = id => document.getElementById(id);
let view;
let busy = false;
let version = 0;
let refreshAfterAction = false;

function showError(message) {
  element('error').textContent = message;
  element('error').hidden = !message;
}

function setBusy(value) {
  busy = value;
  element('app').setAttribute('aria-busy', String(value));
  for (const control of document.querySelectorAll('button, input')) control.disabled = value;
  element('connect').textContent = value && !view?.connection ? 'Connecting…' : 'Connect GitHub';
}

function render(next) {
  view = next;
  const { connection, enabled, pending, activity, issue } = next;
  element('loading').hidden = true;
  element('setup').hidden = Boolean(connection);
  element('connected').hidden = !connection;
  if (!connection) {
    element('update-form').hidden = true;
    element('disconnect-confirmation').hidden = true;
    return;
  }

  element('repo-link').textContent = connection.repo;
  element('repo-link').href = 'https://github.com/' + connection.repo;
  element('branch').textContent = connection.branch;
  element('account').textContent = '@' + connection.username;
  element('enabled').checked = enabled;

  const count = pending === 1 ? '1 submission' : pending + ' submissions';
  let summary = 'Waiting for your first accepted submission.';
  if (activity?.kind === 'synced') summary = 'Synced ' + activity.title + '.';
  if (activity?.kind === 'error') summary = activity.title;
  if (!enabled) summary = pending ? count + ' waiting. Auto-sync is off.' : 'Auto-sync is off.';
  if (enabled && pending) {
    const detail = issue || (activity?.kind === 'error' ? activity.title : '');
    summary = count + ' waiting to sync.' + (detail ? ' ' + detail : '');
  }
  element('activity').textContent = summary;

  const commitLink = element('commit-link');
  const commitUrl = activity?.kind === 'synced' && activity.url;
  commitLink.hidden = !commitUrl;
  if (commitUrl) commitLink.href = commitUrl;
  else commitLink.removeAttribute('href');
  const lastSync = element('last-sync');
  lastSync.hidden = !commitUrl;
  if (commitUrl) {
    const date = new Date(activity.at);
    lastSync.dateTime = date.toISOString();
    lastSync.textContent = new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(date);
  }
  element('recovery').hidden = !issue;
  element('retry').disabled = busy || !enabled;
  element('sync-open').disabled = busy || !enabled;
}

async function send(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error || 'Verdict Sync could not reach its background worker.');
  return response;
}

async function syncOpenSubmission() {
  let result;
  try {
    const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (activeTab?.id != null) {
      result = await chrome.tabs.sendMessage(activeTab.id, {type: 'sync-open-submission'}, {frameId: 0});
    }
  } catch {
    throw new Error('Open the accepted submission on leetcode.com and refresh the tab before syncing.');
  }
  if (!result?.ok) throw new Error(result?.error || 'Open a LeetCode submission before syncing.');
  return send('status');
}

async function refresh() {
  const request = ++version;
  try {
    const response = await send('status');
    if (request !== version || busy) return;
    setBusy(false);
    render(response);
  } catch (error) {
    if (request === version && !busy) {
      element('loading').hidden = true;
      setBusy(false);
      showError(error.message);
    }
  }
}

async function perform(type, fields, onSuccess) {
  if (busy) return;
  ++version;
  setBusy(true);
  showError('');
  try {
    const response = type === 'sync-open' ? await syncOpenSubmission() : await send(type, fields);
    setBusy(false);
    render(response);
    onSuccess?.();
  } catch (error) {
    setBusy(false);
    if (view) render(view);
    showError(error.message);
  } finally {
    if (refreshAfterAction) {
      refreshAfterAction = false;
      void refresh();
    }
  }
}

element('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform('connect', { repo: element('repo').value, token: element('token').value }, () => {
    element('connect-form').reset();
    element('enabled').focus();
  });
});
element('enabled').addEventListener('change', event => {
  void perform('toggle', { enabled: event.target.checked });
});
element('retry').addEventListener('click', () => { void perform('retry'); });
element('sync-open').addEventListener('click', () => { void perform('sync-open'); });
element('update-token').addEventListener('click', () => {
  element('update-form').hidden = false;
  element('new-token').focus();
});
element('cancel-token').addEventListener('click', () => {
  element('update-form').reset();
  element('update-form').hidden = true;
  element('update-token').focus();
});
element('update-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform('update-token', { token: element('new-token').value }, () => {
    element('update-form').reset();
    element('update-form').hidden = true;
    element('enabled').focus();
  });
});
element('disconnect').addEventListener('click', () => {
  if (view?.pending) {
    element('disconnect-confirmation').hidden = false;
    element('cancel-disconnect').focus();
  } else {
    void perform('disconnect', {}, () => element('repo').focus());
  }
});
element('cancel-disconnect').addEventListener('click', () => {
  element('disconnect-confirmation').hidden = true;
  element('disconnect').focus();
});
element('confirm-disconnect').addEventListener('click', () => {
  void perform('disconnect', { discardPending: true }, () => element('repo').focus());
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.verdictSync) return;
  if (busy) refreshAfterAction = true;
  else void refresh();
});
void refresh();
