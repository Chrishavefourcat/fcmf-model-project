const assert = require('node:assert/strict');
const rules = require('../static/grade-rules.js');

const source = [
  {status: '打分映射', inclusive: 1, grade: 'R2', threshold: 20},
  {status: '打分映射', inclusive: '1', grade: 'R1', threshold: 10},
  {status: '打分映射', inclusive: 1, grade: 'R0', threshold: null},
  {status: '打分映射', inclusive: 0, grade: 'excluded', threshold: 5},
  {status: '其他', inclusive: 1, grade: 'other', threshold: 6},
];
const original = JSON.stringify(source);
const model = rules.fromGrades(source);
assert.deepEqual(model, {grades: ['R0', 'R1', 'R2'], boundaries: [-99999, 10, 20, 99999]});
assert.equal(JSON.stringify(source), original);

const example = {grades: ['R1', 'R2'], boundaries: [10, 20, 30]};
assert.deepEqual(rules.withBounds(example, 0, 10, 25).boundaries, [10, 25, 30]);
assert.deepEqual(rules.withBounds(example, 1, 15, 30).boundaries, [10, 15, 30]);
for (const bounds of [[0, 10, 35], [1, 5, 30], [0, 10, 30], [1, 10, 30], [0, '', 20], [0, 10, Infinity]]) {
  assert.throws(() => rules.withBounds(example, ...bounds));
}
assert.deepEqual(example.boundaries, [10, 20, 30]);
assert.equal(rules.gradeForScore(example, 10), 'R1');
assert.equal(rules.gradeForScore(example, 20), 'R2');
assert.equal(rules.gradeForScore(example, 30), 'R2');
assert.equal(rules.gradeForScore(example, 31), null);
assert.equal(rules.gradeForScore(model, 150), 'R2');

const deleting = {grades: ['R1', 'R2', 'R3'], boundaries: [-99999, 10, 20, 99999]};
assert.deepEqual(rules.remove(deleting, 0), {grades: ['R2', 'R3'], boundaries: [-99999, 20, 99999]});
assert.deepEqual(rules.remove(deleting, 1), {grades: ['R1', 'R3'], boundaries: [-99999, 20, 99999]});
assert.deepEqual(rules.remove(deleting, 2), {grades: ['R1', 'R2'], boundaries: [-99999, 10, 99999]});
assert.throws(() => rules.remove(rules.remove(rules.remove(deleting, 0), 0), 0));
assert.deepEqual(deleting.boundaries, [-99999, 10, 20, 99999]);
console.log('Grade rules passed: filtering, sorting, sentinels, shared edges, invalid edits, deletion, scoring and isolation.');
