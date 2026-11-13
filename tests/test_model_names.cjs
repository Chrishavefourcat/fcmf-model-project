const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const controls = new Proxy({}, {get(target, id) {
  return target[id] ??= {textContent: '', title: '', value: '', options: [],
    addEventListener() {}, replaceChildren(...options) { this.options = options; },
    add(option) { this.options.push(option); }};
}});
const context = {AbortController, Option: function(text, value) { this.textContent = text; this.value = value; },
  document: {getElementById: id => controls[id], querySelectorAll: () => [], addEventListener() {}},
  window: {addEventListener() {}}};
const source = fs.readFileSync('static/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '');
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source + `
  syncSelectControls = () => {};
  switchModel = async (database) => {
    state.database = database;
    const selected = state.models.find(model => model.database === database);
    state.model = selected ? {...selected, model_name: '已选模型信息'} : null;
    updateModelLabels();
  };
  wireEvents();
  this.apply = applyDataSource;
`, context);

(async () => {
  const models = [
    {database: '模型 A', file_name: '模型 A.db', database_path: 'E:\\models\\模型 A.db'},
    {database: '模型 B', file_name: '模型 B.DB', database_path: 'E:\\models\\模型 B.DB'},
  ];
  await context.apply({source_id: 'one', directory: 'E:\\models', models, default_database: '模型 B'});
  const options = controls.modelSelect.options.slice(1);
  assert.equal(options[0].textContent, '模型 A.db');
  assert.equal(options[1].textContent, '模型 B.DB');
  assert.equal(options[0].value, '模型 A');
  assert.equal(options[1].value, '模型 B');
  assert.equal(options[1].title, models[1].database_path);
  assert.equal(controls.currentDatabase.textContent, '模型 B.DB');
  assert.equal(controls.currentDatabase.title, models[1].database_path);
  assert.equal(controls.currentModelName.textContent, '已选模型信息');
  await controls.modelSelect.onchange({target: {value: options[0].value}});
  assert.equal(controls.currentDatabase.textContent, '模型 A.db');
  assert.equal(controls.currentDatabase.title, models[0].database_path);
  const moved = {...models[0], database_path: 'E:\\other\\模型 A.db'};
  await context.apply({source_id: 'two', directory: 'E:\\other', models: [moved]});
  assert.equal(controls.modelSelect.options.length, 2);
  assert.equal(controls.modelSelect.options[1].title, moved.database_path);
  assert.equal(controls.currentDatabase.title, moved.database_path);
  await context.apply({source_id: 'empty', directory: 'E:\\empty', models: []});
  assert.equal(controls.modelSelect.disabled, true);
  assert.equal(controls.currentDatabase.textContent, '未选择');
  assert.equal(controls.currentDatabase.title, '');
  console.log('Model names passed: filename-only options without model_name retain paths and file identifiers through selection and folder changes.');
})().catch(error => {console.error(error); process.exitCode = 1;});
