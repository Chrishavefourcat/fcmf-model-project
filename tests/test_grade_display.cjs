const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const GradeRules = require('../static/grade-rules.js');
const source = fs.readFileSync('static/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '');
const context = {AbortController, GradeRules};
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source + '\nthis.page=state; this.match=gradeForScore; this.markup=gradeMarkup; this.indicatorValues=indicatorDisplayValues;', context);
// Regression: never opening/saving the editor must still enforce both bounds.
context.page.model = {grades:[
  {status:'打分映射',grade:'R2',threshold:20,inclusive:1},
  {status:'打分映射',grade:'R1',threshold:10,inclusive:'1'},
  {status:'打分映射',grade:'excluded',threshold:5,inclusive:0},
  {status:'人工定位',grade:'other',threshold:null,inclusive:1},
]};
assert.equal(context.page.gradeRules, null);
assert.equal(context.match(9), null);
assert.equal(context.match(10), 'R1');
assert.equal(context.match(19.9999), 'R1');
assert.equal(context.match(20), 'R2');
assert.equal(context.match('99999'), 'R2');
assert.equal(context.match(100000), null);
for (const score of [9,100000,null,undefined,'',NaN,Infinity]) {
  assert.ok(context.markup(score).includes('class="grade-error">等级匹配异常'));
}
assert.equal(context.markup(10), 'R1');
context.page.gradeRules = {grades:['R2'],boundaries:[20,30]};
assert.equal(context.match(10), null);
assert.equal(context.match(25), 'R2');
assert.equal(context.markup(25), 'R2');
// Refresh/reset clears page overrides and must restore strict database intervals.
context.page.gradeRules = null;
assert.equal(context.match(9), null);
assert.equal(context.match(10), 'R1');
assert.equal(context.match(25), 'R2');
context.page.model = {grades:[{status:'打分映射',grade:'R0',threshold:null,inclusive:1}]};
assert.equal(context.match(-99999), 'R0');
assert.equal(context.match(-100000), null);
context.page.model = {grades:[]};
assert.equal(context.match(10), null);
context.page.results.co = {details:[{indicator_id:'A',raw_value:10,score:12.345678}]};
assert.equal(context.indicatorValues('co', {indicator_values:{A:99,B:4}}).A, '12.3457');
assert.equal(context.indicatorValues('co', {indicator_values:{A:99,B:4}}).B, '4.0000');
console.log('Grade error display and page indicator snapshot values passed.');
