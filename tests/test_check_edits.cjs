const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const controls = {yearSelect: {value: '2025'}, reportSelect: {value: '12-31'}, checkTransferStatus: {textContent: ''},exportChecksBtn:{disabled:false}};
const scoreInput = {value:'',dataset:{companyId:'co',fieldId:'check',period:'2024-12-31'},
  classList:{toggle(){}},setAttribute(){}};
const pending = [];
const context = {URL, AbortController, DOMException, setTimeout, clearTimeout,
  window: {location: {origin: 'http://127.0.0.1'}}, document: {getElementById: id => controls[id],
    querySelectorAll: selector => selector === '#checkRows .check-score-edit-input' ? [scoreInput] : []},
  fetch: (url, options) => new Promise(resolve => pending.push({url, payload: JSON.parse(options.body), resolve})),
};
const source = fs.readFileSync('static/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '');
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source + `
  updateStepNavigation = applyOverridesToFieldMatrix = renderFieldTable = renderInitialMatrix = renderSummaryPanels = () => {};
  state.database = 'test'; state.samples = [{company_id:'co',company_name:'Company'}];
  this.page = state;
  this.helpers = {savePageChecks, savePageCheckScore, checkValue, checkNote, checkFields, checkOverridesFromValues, checkPageData, queueCheckEdit, cancelCheckEdits,checkTotalText,checksReady};
`, context);
const wait = () => new Promise(resolve => setTimeout(resolve, 15));
const h = context.helpers;
const response = (value, period = '2024-12-31') => new Response(JSON.stringify({period_end: period, marker: value,
  check_fields: [{field_id:'check',label:'Check',value,score:Number(value)>0.3 ? 3 : Number(value)>0.2 ? 2 : 0,
    expression:'case(external_lending>{0.3,0.2}, {3,2}, else, 0)'}],details:[]}));
(async () => {
  context.page.results.co = {period_end:'2025-12-31',check_fields:[{field_id:'check',label:'Check',value:'database'}]};
  h.savePageChecks('co', {check:'AA+'}, {check:'note25'});
  assert.equal(h.checkValue('co', {field_id:'check',value:'database'}), 'AA+');
  controls.yearSelect.value = '2024';
  assert.equal(h.checkFields('co').length, 0); // Stale responses cannot populate a different period.
  assert.equal(h.checkValue('co', {field_id:'check',value:'2024 database'}), '2024 database');
  h.savePageChecks('co', {check:'7'}, {check:'note24'});
  h.queueCheckEdit('co', 0); await wait();
  assert.equal(h.checkTotalText('co'),null); // Pending requests must not export the previous score.
  assert.equal(h.checksReady(),false);
  h.savePageChecks('co', {check:'8'});
  h.queueCheckEdit('co', 0); await wait();
  assert.equal(pending[1].payload.period, '2024-12-31');
  assert.equal(pending[1].payload.overrides.check, '8');
  assert.ok(pending.every(r => r.url.pathname === '/api/score-preview'));
  context.document.activeElement=scoreInput;
  scoreInput.value='9.';
  h.savePageCheckScore('co','check','9'); // A manual score entered while the preview is pending survives it.
  pending[1].resolve(response('8')); await wait();
  pending[0].resolve(response('7')); await wait();
  assert.equal(context.page.results.co.marker, '8');
  assert.equal(h.checkPageData().rows[0].checks.check.value, '8');
  assert.equal(h.checkPageData().rows[0].checks.check.score, '9');
  assert.equal(h.checkTotalText('co'),'9.0000');
  assert.equal(scoreInput.value,'9.'); // Focused manual input keeps the user's unformatted text.
  for (const [value,score] of [['0.31','3'],['0.3','2'],['0.2','0']]) {
    h.savePageChecks('co',{check:value});
    h.queueCheckEdit('co',0); await wait();
    assert.equal(h.checkPageData().rows[0].checks.check.score_overridden,false);
    pending.at(-1).resolve(response(value)); await wait();
    assert.equal(h.checkPageData().rows[0].checks.check.score,score);
    assert.equal(h.checkPageData().rows[0].checks.check.value,value);
    assert.equal(scoreInput.value,context.NumberFormat.fmt(score)); // Tabbing into an automatic score still allows preview updates.
  }
  h.queueCheckEdit('co', 0); await wait();
  controls.yearSelect.value = '2025'; h.cancelCheckEdits();
  pending.at(-1).resolve(response('late')); await wait();
  assert.equal(context.page.results.co.marker, '0.2');
  assert.equal(h.checkOverridesFromValues('co').check, 'AA+');
  assert.equal(h.checkNote('co', {field_id:'check'}), 'note25');
  h.savePageChecks('co', {check:''});
  assert.equal(h.checkValue('co', {field_id:'check',value:'database',default_value:'3'}), '');
  assert.equal(h.checkValue('co', {field_id:'check',value:'',default_value:''}), '');
  // A response from a previous model controller cannot replace the new model's result.
  h.queueCheckEdit('co',0); await wait();
  vm.runInNewContext('modelController = new AbortController(); state.database="other";',context);
  pending.at(-1).resolve(response('model-late','2025-12-31')); await wait();
  assert.equal(context.page.results.co.marker,'0.2');
  h.cancelCheckEdits();
  console.log('Check edits passed: formula thresholds, focused computed/manual inputs, pending totals, score races, model/date isolation and stale-response rejection.');
})().catch(error => {console.error(error); process.exitCode = 1;});
