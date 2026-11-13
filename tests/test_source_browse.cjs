const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const controls = new Proxy({}, {get(target, id) {
  return target[id] ??= {textContent: '', value: '', options: [], disabled: false, hidden: true,
    attributes: {}, listeners: {}, classList: {add() {}},
    setAttribute(name, value) {this.attributes[name] = value;},
    addEventListener(name, handler) {this.listeners[name] = handler;},
    replaceChildren(...options) {this.options = options;}, add(option) {this.options.push(option);},
    showModal() {this.open = true;}, close() {this.open = false;}, focus() {this.focused = true;}};
}});
const documentListeners = {};
let browseRequests = [], selectionRequests = [], resolveBrowse;
const fileModel = {database: '单个模型', model_name: '所选文件模型', file_name: '单个模型.DB',
  database_path: 'E:\\数据\\单个模型.DB', base_year: 2026};
const fileSource = {source_id: 'file', source_kind: 'file', directory: fileModel.database_path, models: [fileModel]};
const context = {URL, AbortController, clearTimeout,
  Option: function(text, value) {this.textContent = text; this.value = value;},
  document: {getElementById: id => controls[id], querySelectorAll: () => [],
    addEventListener(name, handler) {documentListeners[name] = handler;}},
  window: {location: {origin: 'http://localhost'}, addEventListener() {}},
  fetch: async (url, options) => {
    if (url === '/api/data-source/browse') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      for (const id of ['selectDataSourceBtn', 'dataSourceDirectory', 'dataSourceCancel', 'dataSourceSubmit',
        'dataSourceBrowse', 'dataSourceBrowseDirectory', 'dataSourceBrowseFile']) assert.equal(controls[id].disabled, true, id);
      browseRequests.push(JSON.parse(options.body));
      return new Promise(resolve => {resolveBrowse = resolve;});
    }
    if (url === '/api/data-source/select') {
      selectionRequests.push(JSON.parse(options.body));
      return new Response(JSON.stringify(fileSource));
    }
    assert.equal(url.pathname, '/api/model');
    return new Response(JSON.stringify(fileModel));
  }};
context.NumberFormat = require('../static/number-format.js');
const source = fs.readFileSync('static/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '');
vm.runInNewContext(source + `
  cancelCheckEdits = cancelBulkSelection = renderSamples = renderFieldTable = renderInitialMatrix = renderCheckMatrix =
    setStep = updateStepNavigation = syncSelectControls = () => {};
  wireEvents();
  this.page = state;
  this.h = {selectDataSource, browseDataSource, submitDataSource};
`, context);

function escapeModal() {
  let prevented = false;
  controls.dataSourceModal.listeners.cancel({preventDefault() {prevented = true;}});
  return prevented;
}

(async () => {
  const {h, page} = context;
  Object.assign(page, {sourceId: 'old', sourceDirectory: 'E:\\原目录', samples: [{company_id: 'keep'}],
    overrides: {keep: {metric: 123}}, model: {model_name: '原模型'}});
  h.selectDataSource();
  assert.equal(controls.dataSourceDirectory.value, page.sourceDirectory);
  controls.dataSourceBrowse.onclick();
  assert.equal(controls.dataSourceBrowseOptions.hidden, false);
  assert.equal(controls.dataSourceBrowse.attributes['aria-expanded'], 'true');
  assert.equal(controls.dataSourceBrowseDirectory.focused, true);
  assert.equal(escapeModal(), true); // Escape closes the menu before the enclosing dialog.
  assert.equal(controls.dataSourceBrowseOptions.hidden, true);
  assert.equal(escapeModal(), false);
  controls.dataSourceBrowse.onclick();
  documentListeners.click({target: {closest: () => null}});
  assert.equal(controls.dataSourceBrowseOptions.hidden, true);

  controls.dataSourceDirectory.value = '  E:\\原目录  ';
  const browsing = controls.dataSourceBrowseDirectory.onclick();
  assert.deepEqual(browseRequests[0], {kind: 'directory', initial_path: 'E:\\原目录'});
  assert.equal(escapeModal(), true);
  controls.dataSourceCancel.onclick();
  assert.equal(controls.dataSourceModal.open, true);
  await h.browseDataSource('file');
  await h.submitDataSource();
  h.selectDataSource();
  assert.equal(browseRequests.length, 1);
  assert.equal(selectionRequests.length, 0);
  assert.equal(controls.dataSourceDirectory.value, '  E:\\原目录  ');
  resolveBrowse(new Response(JSON.stringify({path: 'E:\\新目录', kind: 'directory'})));
  await browsing;
  assert.equal(controls.dataSourceDirectory.value, 'E:\\新目录');
  assert.equal(page.sourceId, 'old');
  assert.equal(page.model.model_name, '原模型');
  assert.equal(page.samples[0].company_id, 'keep');
  assert.equal(page.overrides.keep.metric, 123);
  assert.equal(controls.dataSourceModal.open, true);
  assert.match(controls.dataSourceStatus.textContent, /确认加载/);
  for (const id of ['selectDataSourceBtn', 'dataSourceDirectory', 'dataSourceCancel', 'dataSourceSubmit',
    'dataSourceBrowse', 'dataSourceBrowseDirectory', 'dataSourceBrowseFile']) assert.equal(controls[id].disabled, false, id);

  const cancelled = controls.dataSourceBrowseFile.onclick();
  assert.deepEqual(browseRequests[1], {kind: 'file', initial_path: 'E:\\新目录'});
  resolveBrowse(new Response(JSON.stringify({cancelled: true})));
  await cancelled;
  assert.equal(controls.dataSourceDirectory.value, 'E:\\新目录');
  assert.equal(page.samples[0].company_id, 'keep');
  assert.equal(page.overrides.keep.metric, 123);
  assert.equal(selectionRequests.length, 0);

  const failed = h.browseDataSource('file');
  resolveBrowse(new Response(JSON.stringify({error: '选择窗口不可用'}), {status: 500}));
  await failed;
  assert.equal(controls.dataSourceDirectory.value, 'E:\\新目录');
  assert.match(controls.dataSourceStatus.textContent, /选择窗口不可用/);
  assert.equal(page.sourceId, 'old');
  assert.equal(page.samples[0].company_id, 'keep');
  const invalid = h.browseDataSource('file');
  resolveBrowse(new Response(JSON.stringify({path: ''})));
  await invalid;
  assert.equal(controls.dataSourceDirectory.value, 'E:\\新目录');
  assert.match(controls.dataSourceStatus.textContent, /有效.*路径/);

  const selected = controls.dataSourceBrowseFile.onclick();
  resolveBrowse(new Response(JSON.stringify({path: fileModel.database_path, kind: 'file'})));
  await selected;
  assert.equal(controls.dataSourceDirectory.value, fileModel.database_path);
  assert.equal(selectionRequests.length, 0);
  assert.equal(page.samples[0].company_id, 'keep');
  await h.submitDataSource();
  assert.deepEqual(selectionRequests, [{directory: fileModel.database_path}]);
  assert.equal(page.sourceId, 'file');
  assert.equal(page.sourceDirectory, fileModel.database_path);
  assert.equal(page.model.model_name, fileModel.model_name);
  assert.equal(page.models.length, 1);
  assert.equal(page.samples.length, 0);
  assert.equal(controls.dataSourcePath.textContent, `数据源：${fileModel.database_path}`);
  assert.equal(controls.dataSourceModal.open, false);
  console.log('Source browsing passed: directory/file menus, pending dialog locks, cancelled/error selections retain data, browse only fills the path, single DB loads on confirmation.');
})().catch(error => {console.error(error); process.exitCode = 1;});
