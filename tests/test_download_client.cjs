const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('static/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '');
let header = "attachment; filename=fields_20261021_090507.xlsx; filename*=UTF-8''" + encodeURIComponent('模型数据录入_2025-12-31_20261021_090507.xlsx');
const context = {
  URL, AbortController,
  window: {location: {origin: 'http://127.0.0.1'}},
  fetch: async () => new Response('workbook', {headers: {'Content-Disposition': header}}),
};
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source + '\nstate.database="test"; this.download=postDownload;', context);
(async () => {
  const result = await context.download('/api/export-fields', {});
  assert.equal(result.filename, '模型数据录入_2025-12-31_20261021_090507.xlsx');
  assert.equal(await result.blob.text(), 'workbook');
  header = 'attachment; filename=fields_20261021_090507.xlsx';
  assert.equal((await context.download('/api/export-checks', {})).filename, 'fields_20261021_090507.xlsx');
  console.log('Download client preserves server timestamps and Unicode filenames for both exporters.');
})().catch(error => { console.error(error); process.exitCode = 1; });
