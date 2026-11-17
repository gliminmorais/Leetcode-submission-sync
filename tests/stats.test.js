import assert from 'node:assert/strict';
import test from 'node:test';
import {readLedger, recordSubmission} from '../extension/stats.js';

const twoSum = {
  id: '12345', slug: 'two-sum', title: 'Two Sum', number: '1',
  difficulty: 'Easy', topics: ['Array', 'Hash Table'],
  language: 'python3', code: '# exact solution\n', runtime: '2 ms', memory: '15 MB'
};
const twoSumFolder = 'array/easy/0001-two-sum';
const addNumbers = {
  ...twoSum, id: '12346', slug: 'add-two-numbers', title: 'Add Two Numbers',
  number: '2', difficulty: 'Medium', topics: ['Linked List', 'Math'], language: 'javascript'
};
const addNumbersFolder = 'linked-list/medium/0002-add-two-numbers';

test('distinct accepted IDs increase the count but a repeat solve stays one unique problem', () => {
  const first = recordSubmission(readLedger(null), twoSum, twoSumFolder);
  const second = recordSubmission(readLedger(first.index), addNumbers, addNumbersFolder);
  const latest = recordSubmission(readLedger(second.index),
    {...twoSum, id: '12347', language: 'java'}, twoSumFolder);
  assert.match(latest.stats, /\| 2 \| 3 \|/);
  assert.match(latest.stats, /\| Easy \| 1 \|/);
  assert.match(latest.stats, /\| Medium \| 1 \|/);
  assert.match(latest.stats, /\| python3 \| 1 \|/);
  assert.match(latest.stats, /\| java \| 1 \|/);
  assert.match(latest.stats, /\| Array \| 1 \|/);
  assert.match(latest.stats, /\| Hash Table \| 1 \|/);
  assert.match(latest.stats, /problems\/two-sum\/submissions\/12347\//);
  assert.equal(latest.index.includes(twoSum.code.trim()), false);
  assert.equal(readLedger(latest.index).problems['two-sum'].folder, twoSumFolder);
});

test('the same submission ID is ignored even if it is received again in a different folder', () => {
  const output = recordSubmission(readLedger(null), twoSum, twoSumFolder);
  assert.equal(recordSubmission(readLedger(output.index), {...twoSum, ...addNumbers, id: twoSum.id},
    addNumbersFolder), null);
});

test('an edited ledger cannot redirect file writes or create counts for unknown problems', () => {
  const {index} = recordSubmission(readLedger(null), twoSum, twoSumFolder);
  const badPath = JSON.parse(index);
  badPath.problems['two-sum'].folder = '../.github/workflows';
  assert.throws(() => readLedger(JSON.stringify(badPath)), /index/i);
  const badCount = JSON.parse(index);
  badCount.accepted['12345'][0] = 'unknown-problem';
  assert.throws(() => readLedger(JSON.stringify(badCount)), /index/i);
});

test('recent rows escape Markdown and HTML supplied by LeetCode', () => {
  const output = recordSubmission(readLedger(null),
    {...twoSum, title: 'A | <em>title</em>', runtime: '0 | 2 ms'}, twoSumFolder);
  assert.match(output.stats, /A \\\| &lt;em&gt;title&lt;\/em&gt;/);
  assert.match(output.stats, /0 \\\| 2 ms/);
});

test('the index bounds recent rows without removing the IDs used for deduplication', () => {
  let output = {index: null};
  for (let n = 1; n <= 11; n++) {
    output = recordSubmission(readLedger(output.index), {...twoSum, id: String(n)}, twoSumFolder);
  }
  const ledger = readLedger(output.index);
  assert.equal(ledger.recent.length, 10);
  assert.equal(recordSubmission(ledger, {...twoSum, id: '1'}, twoSumFolder), null);
  assert.match(output.stats, /\| 1 \| 11 \|/);
});
