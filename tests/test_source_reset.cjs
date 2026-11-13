const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const controls = new Proxy({}, {get(target, id) {
  return target[id] ??= {textContent: '', value: '', options: [], disabled: false,
    classList: {add() {}}, replaceChildren(...options) {this.options = options;},
    showModal() {this.open = true;}, close() {this.open = false;}, focus() {}, setAttribute() {},
    add(option) {this.options.push(option);}};
}});
const folderA = {source_id: 'A', directory: 'E:\\A', models: [
  {database: 'shared', model_name: '同名模型', file_name: 'shared.db', database_path: 'E:\\A\\shared.db', base_year: 2025},
  {database: 'onlyA', model_name: '旧模型', file_name: 'onlyA.db', database_path: 'E:\\A\\onlyA.db', base_year: 2025},
]};
const folderB = {source_id: 'B', directory: 'E:\\B', models: [
  {database: 'shared', model_name: '新模型', file_name: 'shared.db', database_path: 'E:\\B\\shared.db', base_year: 2026},
]};
let selected = folderA, pendingModels, selectionRequests = 0, failedSelection = false;
const context = {URL, AbortController, Option: function(text, value) {this.textContent = text; this.value = value;},
  clearTimeout, document: {getElementById: id => controls[id]},
  window: {location: {origin: 'http://localhost'}},
  fetch: async (url, options) => {
    if (url === '/api/models') return new Promise(resolve => {pendingModels = resolve;});
    if (url === '/api/data-source/select') {
      selectionRequests++;
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(JSON.parse(options.body).directory, controls.dataSourceDirectory.value.trim());
      assert.equal(controls.dataSourceSubmit.disabled, true);
      assert.equal(controls.dataSourceDirectory.disabled, true);
      assert.equal(controls.dataSourceCancel.disabled, true);
      return failedSelection ? new Response(JSON.stringify({error: '目录不存在'}), {status: 400}) : new Response(JSON.stringify(selected));
    }
    assert.equal(url.pathname, '/api/model');
    assert.equal(options.headers['X-Data-Source'], selected.source_id);
    return new Response(JSON.stringify(selected.models.find(model => model.database === url.searchParams.get('database'))));
  }};
const source = fs.readFileSync('static/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '');
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source + `
  cancelCheckEdits = cancelBulkSelection = renderSamples = renderFieldTable = renderInitialMatrix = renderCheckMatrix =
    setStep = updateStepNavigation = syncSelectControls = () => {};
  this.page = state;
  this.h = {loadModels, applyDataSource, selectDataSource, submitDataSource};
`, context);

(async () => {
  const {h, page} = context;
  await h.applyDataSource(folderA);
  Object.assign(page, {samples: [{company_id: 'old'}], companies: [{company_id: 'old'}],
    results: {old: {}}, fieldMatrix: {fields: [{}], rows: [{}]}, overrides: {old: {}},
    importedIndicatorValues: {old: {}}, indicatorScores: {old: {}}, ruleOverrides: {old: {}},
    gradeRules: {grades: ['Old']}, checkValues: {old: {}}, checkScores: {old: {}}, checkNotes: {old: {}},
    unlockedStep: 4, showIndicators: true, modalCompanyId: 'old', checkModalCompanyId: 'old'});
  const oldRequest = h.loadModels();
  selected = folderB;
  h.selectDataSource();
  assert.equal(controls.dataSourceModal.open, true);
  assert.equal(controls.dataSourceDirectory.value, folderA.directory);
  assert.equal(selectionRequests, 0); // Opening and cancelling never call the server.
  controls.dataSourceModal.close();
  assert.equal(page.sourceId, 'A');
  assert.equal(page.samples.length, 1);
  h.selectDataSource();
  controls.dataSourceDirectory.value = '  E:\\B  ';
  await h.submitDataSource();
  assert.equal(page.sourceId, 'B');
  assert.equal(page.sourceDirectory, 'E:\\B');
  assert.equal(page.model.model_name, '新模型');
  assert.equal(controls.currentDatabase.title, 'E:\\B\\shared.db');
  assert.equal(controls.modelSelect.options.length, 2);
  assert.equal(controls.modelSelect.options[1].title, 'E:\\B\\shared.db');
  for (const key of ['samples', 'companies']) assert.equal(page[key].length, 0, key);
  for (const key of ['results', 'overrides', 'importedIndicatorValues', 'indicatorScores', 'ruleOverrides', 'checkValues', 'checkScores', 'checkNotes']) {
    assert.equal(Object.keys(page[key]).length, 0, key);
  }
  assert.equal(page.fieldMatrix.fields.length, 0);
  assert.equal(page.fieldMatrix.rows.length, 0);
  assert.equal(page.gradeRules, null);
  assert.equal(page.unlockedStep, 0);
  assert.equal(page.showIndicators, false);
  assert.equal(controls.dataSourceModal.open, false);
  assert.equal(controls.dataSourceSubmit.disabled, false);
  assert.equal(controls.dataSourceDirectory.disabled, false);
  assert.equal(controls.dataSourceCancel.disabled, false);
  pendingModels(new Response(JSON.stringify(folderA)));
  await oldRequest;
  assert.equal(page.sourceId, 'B'); // A slower old list cannot restore the previous folder.
  assert.equal(controls.modelSelect.options.length, 2);
  page.samples = [{company_id: 'keep'}];
  page.overrides.keep = {metric: 123};
  const savedStatus = controls.modelStatus.textContent;
  failedSelection = true;
  h.selectDataSource();
  controls.dataSourceDirectory.value = 'E:\\missing';
  await h.submitDataSource();
  assert.equal(page.sourceId, 'B');
  assert.equal(page.model.model_name, '新模型');
  assert.equal(page.samples[0].company_id, 'keep');
  assert.equal(page.overrides.keep.metric, 123);
  assert.equal(controls.modelStatus.textContent, savedStatus);
  assert.equal(controls.dataSourceModal.open, true);
  assert.match(controls.dataSourceStatus.textContent, /目录不存在/);
  const requestCount = selectionRequests;
  controls.dataSourceDirectory.value = '   ';
  await h.submitDataSource();
  assert.equal(selectionRequests, requestCount);
  assert.match(controls.dataSourceStatus.textContent, /完整路径/);
  failedSelection = false;
  selected = {cancelled: true};
  controls.dataSourceDirectory.value = folderB.directory;
  await h.submitDataSource();
  assert.equal(page.sourceId, 'B');
  assert.equal(page.samples[0].company_id, 'keep');
  selected = {source_id: 'empty', directory: 'E:\\empty', models: []};
  h.selectDataSource();
  controls.dataSourceDirectory.value = selected.directory;
  await h.submitDataSource();
  assert.equal(page.model, null);
  assert.equal(page.database, '');
  assert.equal(controls.modelSelect.options.length, 1);
  assert.equal(controls.modelSelect.disabled, true);
  console.log('Browser source selection passed: path prefill and JSON request, source reset, stale lists ignored, cancellation and failure retain data, empty folders disable models.');
})().catch(error => {console.error(error); process.exitCode = 1;});
