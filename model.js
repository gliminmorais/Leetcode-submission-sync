const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idPattern = /^[1-9]\d{0,18}$/;
const languagePattern = /^[a-z0-9][a-z0-9-]{0,30}$/;
const extensions = {
  c: 'c', cpp: 'cpp', csharp: 'cs', dart: 'dart', elixir: 'ex', erlang: 'erl',
  golang: 'go', java: 'java', javascript: 'js', kotlin: 'kt', mysql: 'sql',
  mssql: 'sql', oraclesql: 'sql', postgresql: 'sql', php: 'php', python: 'py',
  python3: 'py', pandas: 'py', racket: 'rkt', ruby: 'rb', rust: 'rs',
  scala: 'scala', swift: 'swift', typescript: 'ts', bash: 'sh',
  'pythondata': 'py', 'react': 'jsx'
};

export function parseRepository(input) {
  const value = String(input ?? '').trim();
  const match = /^(?:https:\/\/github\.com\/)?([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]{1,100})\/?$/i.exec(value);
  const repository = match?.[2].replace(/\.git$/i, '');
  if (!repository || repository === '.' || repository === '..') {
    throw new Error('Enter a GitHub repository URL or owner/repository.');
  }
  return match[1] + '/' + repository;
}

export function captureIdentity(id, slug) {
  return typeof id === 'string' && idPattern.test(id)
    && typeof slug === 'string' && slug.length <= 120 && slugPattern.test(slug);
}

function plain(value, limit = 150) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}

function markdown(value) {
  return value.replace(/[&<>]/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[ch])
    .replace(/[\\`*_{}\[\]|]/g, '\\$&');
}

export function normalizeEntry(entry) {
  if (!entry || !captureIdentity(entry.id, entry.slug)
      || typeof entry.language !== 'string' || !languagePattern.test(entry.language)
      || typeof entry.code !== 'string' || !entry.code.trim()
      || new TextEncoder().encode(entry.code).length > 96 * 1024) {
    throw new Error('LeetCode returned incomplete or unsupported submission data.');
  }
  const title = plain(entry.title);
  const number = plain(entry.number, 20);
  if (!title || !/^[a-z\d][a-z\d ._-]{0,19}$/i.test(number)
      || !['Easy', 'Medium', 'Hard'].includes(entry.difficulty)) {
    throw new Error('LeetCode returned incomplete problem details.');
  }
  return {
    id: entry.id, slug: entry.slug, language: entry.language, code: entry.code,
    title, number, difficulty: entry.difficulty,
    topics: Array.isArray(entry.topics) ? entry.topics.slice(0, 25).map(topic => plain(topic, 70)).filter(Boolean) : [],
    runtime: plain(entry.runtime, 40), memory: plain(entry.memory, 40)
  };
}

export function validProblemFolder(folder, slug) {
  if (typeof folder !== 'string' || !captureIdentity('1', slug)) return false;
  const parts = folder.split('/');
  return parts.length === 3 && parts[0].length <= 70 && slugPattern.test(parts[0])
    && ['easy', 'medium', 'hard'].includes(parts[1])
    && parts[2].endsWith('-' + slug) && parts[2].length <= 150 && slugPattern.test(parts[2]);
}

function slugify(text) {
  return text.toLowerCase().normalize('NFKD').replace(/\p{Mark}/gu, '')
    .replace(/[^a-z\d]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildCommit(input, savedFolder) {
  const entry = normalizeEntry(input);
  const number = /^\d+$/.test(entry.number)
    ? entry.number.padStart(4, '0')
    : slugify(entry.number);
  const topic = slugify(entry.topics[0] ?? '').slice(0, 70).replace(/-+$/, '') || 'uncategorized';
  const folder = savedFolder ?? [topic, entry.difficulty.toLowerCase(), number + '-' + entry.slug].join('/');
  if (!validProblemFolder(folder, entry.slug)) {
    throw new Error('The saved problem folder is invalid.');
  }
  const extension = Object.hasOwn(extensions, entry.language) ? extensions[entry.language] : 'txt';
  const problem = 'https://leetcode.com/problems/' + entry.slug + '/';
  const submission = problem + 'submissions/' + entry.id + '/';
  const readme = [
    '# ' + markdown(entry.number) + '. ' + markdown(entry.title),
    '',
    '- **Difficulty:** ' + entry.difficulty,
    ...(entry.topics.length ? ['- **Topics:** ' + entry.topics.map(markdown).join(', ')] : []),
    '- **Problem:** [View on LeetCode](' + problem + ')',
    ''
  ].join('\n');
  const message = [
    'Solve ' + entry.number + '. ' + entry.title + ' (' + entry.language + ')',
    '',
    'LeetCode submission: ' + submission,
    ...(entry.runtime ? ['Runtime: ' + entry.runtime] : []),
    ...(entry.memory ? ['Memory: ' + entry.memory] : [])
  ].join('\n');
  return {
    folder,
    message,
    files: {
      [folder + '/README.md']: readme,
      [folder + '/' + entry.language + '-' + entry.id + '.' + extension]: entry.code
    }
  };
}
