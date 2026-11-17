import { captureIdentity, normalizeEntry, validProblemFolder } from './model.js';

// Keep each whole-index read and commit bounded.
const MAX_INDEX_BYTES = 750_000;
const RECENT_LIMIT = 10;
const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
const LANGUAGE_FORMAT = /^[a-z0-9][a-z0-9-]{0,30}$/;
const INDEX_ERROR = 'The Verdict Sync index in this repository is invalid. Restore .verdict-sync/index.json from a working commit.';
const INDEX_SIZE_ERROR = 'The Verdict Sync index reached its 750 KB limit. Connect a new repository to continue syncing.';
const encoder = new TextEncoder();

function verifySize(text) {
  if (text.length > MAX_INDEX_BYTES || encoder.encode(text).length > MAX_INDEX_BYTES) {
    throw new Error(INDEX_SIZE_ERROR);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textField(value, limit, optional = false) {
  return typeof value === 'string' && value.length <= limit &&
    (optional || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
}

export function readLedger(text) {
  const ledger = { version: 1, problems: Object.create(null), accepted: Object.create(null), recent: [] };
  if (text === null) return ledger;
  if (typeof text !== 'string') throw new Error(INDEX_ERROR);
  verifySize(text);

  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error(INDEX_ERROR);
  }
  if (input?.version !== 1 || !isRecord(input.problems) || !isRecord(input.accepted) ||
      !Array.isArray(input.recent) || input.recent.length > RECENT_LIMIT) {
    throw new Error(INDEX_ERROR);
  }

  for (const [slug, problem] of Object.entries(input.problems)) {
    if (!isRecord(problem) || !captureIdentity('1', slug) ||
        !validProblemFolder(problem.folder, slug) || !DIFFICULTIES.includes(problem.difficulty) ||
        !textField(problem.title, 150) || !textField(problem.number, 20) ||
        !Array.isArray(problem.topics) || problem.topics.length > 25 ||
        !problem.topics.every(topic => textField(topic, 70))) {
      throw new Error(INDEX_ERROR);
    }
    ledger.problems[slug] = {
      folder: problem.folder, title: problem.title, number: problem.number,
      difficulty: problem.difficulty, topics: [...new Set(problem.topics)]
    };
  }

  const tracked = new Set();
  for (const [id, row] of Object.entries(input.accepted)) {
    if (!Array.isArray(row) || row.length !== 2) throw new Error(INDEX_ERROR);
    const [slug, language] = row;
    if (!captureIdentity(id, slug) || !Object.hasOwn(ledger.problems, slug) ||
        typeof language !== 'string' || !LANGUAGE_FORMAT.test(language)) {
      throw new Error(INDEX_ERROR);
    }
    ledger.accepted[id] = [slug, language];
    tracked.add(slug);
  }
  if (tracked.size !== Object.keys(ledger.problems).length) throw new Error(INDEX_ERROR);

  const recentIds = new Set();
  for (const receipt of input.recent) {
    if (!isRecord(receipt) || typeof receipt.id !== 'string' ||
        !Object.hasOwn(ledger.accepted, receipt.id) || recentIds.has(receipt.id) ||
        !Number.isSafeInteger(receipt.at) || receipt.at < 0 || receipt.at > 253_402_300_799_999 ||
        !textField(receipt.runtime, 40, true) || !textField(receipt.memory, 40, true)) {
      throw new Error(INDEX_ERROR);
    }
    const { id, at, runtime, memory } = receipt;
    ledger.recent.push({ id, at, runtime, memory });
    recentIds.add(id);
  }
  return ledger;
}

function escapeCell(value) {
  return value.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])
    .replace(/[\\*_{}\[\]|\x60]/g, '\\$&');
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function countRows(counts) {
  return [...counts].sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB, 'en'))
    .map(([name, count]) => '| ' + escapeCell(name) + ' | ' + count + ' |');
}

function renderStats(ledger) {
  const problems = Object.values(ledger.problems);
  const accepted = Object.values(ledger.accepted);
  const difficulty = new Map();
  const topics = new Map();
  const languages = new Map();
  for (const problem of problems) {
    increment(difficulty, problem.difficulty);
    for (const topic of problem.topics) increment(topics, topic);
  }
  for (const [, language] of accepted) increment(languages, language);

  const recentRows = ledger.recent.map(({ id, at, runtime, memory }) => {
    const [slug, language] = ledger.accepted[id];
    const { title, number } = ledger.problems[slug];
    const time = new Date(at).toISOString().replace('T', ' ').slice(0, 16);
    const source = 'https://leetcode.com/problems/' + slug + '/submissions/' + id + '/';
    return '| ' + time + ' | ' + escapeCell(number + '. ' + title) + ' | ' + escapeCell(language) +
      ' | ' + (escapeCell(runtime) || '—') + ' | ' + (escapeCell(memory) || '—') +
      ' | [' + id + '](' + source + ') |';
  });

  return [
    '# LeetCode stats',
    '',
    'Accepted submissions synced to this repository by Verdict Sync.',
    '',
    '| Tracked problems | Accepted submissions |',
    '| ---: | ---: |',
    '| ' + problems.length + ' | ' + accepted.length + ' |',
    '',
    '## Problems by difficulty',
    '',
    '| Difficulty | Problems |',
    '| --- | ---: |',
    ...DIFFICULTIES.map(name => '| ' + name + ' | ' + (difficulty.get(name) ?? 0) + ' |'),
    '',
    '## Problems by topic',
    '',
    'A problem is counted under each of its LeetCode topic tags.',
    '',
    '| Topic | Problems |',
    '| --- | ---: |',
    ...(topics.size ? countRows(topics) : ['| No tagged problems | 0 |']),
    '',
    '## Accepted submissions by language',
    '',
    '| Language | Accepted submissions |',
    '| --- | ---: |',
    ...countRows(languages),
    '',
    '## Recent accepted submissions',
    '',
    '| Synced (UTC) | Problem | Language | Runtime | Memory | LeetCode submission |',
    '| --- | --- | --- | ---: | ---: | --- |',
    ...recentRows,
    ''
  ].join('\n');
}

export function recordSubmission(ledger, input, folder) {
  const entry = normalizeEntry(input);
  if (Object.hasOwn(ledger.accepted, entry.id)) return null;
  const current = ledger.problems[entry.slug];
  if (!validProblemFolder(folder, entry.slug) ||
      (Object.hasOwn(ledger.problems, entry.slug) && current.folder !== folder)) {
    throw new Error(INDEX_ERROR);
  }

  const { id, slug, title, number, difficulty, language, runtime, memory } = entry;
  const next = {
    version: 1,
    problems: {
      ...ledger.problems,
      [slug]: { folder, title, number, difficulty, topics: [...new Set(entry.topics)] }
    },
    accepted: { ...ledger.accepted, [id]: [slug, language] },
    recent: [{ id, at: Date.now(), runtime, memory }, ...ledger.recent].slice(0, RECENT_LIMIT)
  };
  const index = JSON.stringify(next) + '\n';
  verifySize(index);
  return { stats: renderStats(next), index };
}
