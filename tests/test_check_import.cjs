const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const controls = {yearSelect:{value:'2025'},reportSelect:{value:'12-31'},
  checkTransferStatus:{textContent:''},importChecksInput:{value:'file'}};
const requests = [];
let imported, delayedImport;
const formula = 'case(external_lending>{0.3,0.2}, {3,2}, else, 0)';
const result = (value = '0.2', period = '2025-12-31') => ({period_end:period,details:[],check_fields:[
  {field_id:'external_lending',label:'Lending',value,score:Number(value)>0.3?3:Number(value)>0.2?2:0,expression:formula},
  {field_id:'other_check',label:'Other',value:'1',score:1,expression:'other_check'},
]});
const context = {URL,AbortController,DOMException,Blob,setTimeout,clearTimeout,
  window:{location:{origin:'http://127.0.0.1'}},
  document:{getElementById:id=>controls[id]},
  fetch:async (url, options) => {
    requests.push({url,options});
    if (url.pathname === '/api/import-checks') {
      if (delayedImport) return new Promise(resolve => { delayedImport.resolve=resolve; });
      return new Response(JSON.stringify(imported));
    }
    assert.equal(url.pathname,'/api/score-preview');
    const payload=JSON.parse(options.body);
    assert.equal(payload.rules.lending.expression,formula); // Current page formulas accompany the preview.
    return new Response(JSON.stringify(result(payload.overrides.external_lending,payload.period)));
  },
};
context.NumberFormat=require('../static/number-format.js');
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
vm.runInNewContext(source+`
  updateStepNavigation = renderCheckMatrix = renderSummaryPanels = () => {};
  state.database='test';
  state.samples=[{company_id:'co',company_name:'Company'}];
  state.ruleOverrides={lending:{expression:${JSON.stringify(formula)}}};
  this.page=state;
  this.h={importChecksExcel,savePageCheckScore,checkPageData,checkTotalText};
`,context);

(async()=>{
  const h=context.h,page=context.page,file=new Blob(['workbook']);
  page.results.co=result();
  h.savePageCheckScore('co','other_check','9');
  imported={overrides:{co:{external_lending:'0.31'},unselected:{external_lending:'99'}},
    scores:{co:{external_lending:'999'}},score_overrides:{co:{external_lending:false}}};
  await h.importChecksExcel(file);
  let checks=h.checkPageData().rows[0].checks;
  assert.equal(checks.external_lending.value,'0.31');
  assert.equal(checks.external_lending.score,'3'); // Formula result replaces a stale calculated Excel score.
  assert.equal(checks.external_lending.score_overridden,false);
  assert.equal(checks.other_check.score,'9'); // A partial template preserves unrelated manual scores.
  assert.equal(h.checkTotalText('co'),'12.0000');
  assert.equal(page.results.unselected,undefined);

  imported={overrides:{co:{external_lending:'0.3'}},scores:{co:{external_lending:'7.12345'}},
    score_overrides:{co:{external_lending:true}}};
  await h.importChecksExcel(file);
  checks=h.checkPageData().rows[0].checks;
  assert.equal(checks.external_lending.value,'0.3');
  assert.equal(checks.external_lending.score,'7.12345');
  assert.equal(checks.external_lending.score_overridden,true);
  assert.equal(h.checkTotalText('co'),'16.1235');

  imported={overrides:{co:{external_lending:'0.2'}},scores:{co:{external_lending:0}},
    score_overrides:{co:{external_lending:false}}};
  await h.importChecksExcel(file);
  assert.equal(h.checkPageData().rows[0].checks.external_lending.score,'0');
  assert.equal(h.checkPageData().rows[0].checks.external_lending.score_overridden,false);

  // Score-only workbooks keep the existing page source values.
  imported={overrides:{},scores:{co:{other_check:'6'}},score_overrides:{co:{other_check:true}}};
  await h.importChecksExcel(file);
  assert.equal(h.checkPageData().rows[0].checks.external_lending.value,'0.2');
  assert.equal(h.checkTotalText('co'),'6.0000');

  // Legacy three-column workbooks only provide source overrides and optional notes.
  imported={overrides:{co:{external_lending:'0.3'}}};
  await h.importChecksExcel(file);
  assert.equal(h.checkPageData().rows[0].checks.external_lending.score,'2');
  assert.equal(h.checkPageData().rows[0].checks.other_check.score,'6');

  imported={overrides:{},scores:{co:{external_lending:null}},score_overrides:{co:{external_lending:true}}};
  await h.importChecksExcel(file);
  assert.equal(h.checkPageData().rows[0].checks.external_lending.score,null);
  assert.equal(h.checkTotalText('co'),null); // Explicit blank scores stay invalid instead of exporting stale totals.
  assert.equal(controls.importChecksInput.value,'');

  const before=JSON.stringify(page.checkValues);
  delayedImport={};
  const pending=h.importChecksExcel(file);
  await new Promise(resolve=>setImmediate(resolve));
  controls.yearSelect.value='2024';
  delayedImport.resolve(new Response(JSON.stringify({overrides:{co:{external_lending:'99'}}})));
  await pending;
  assert.equal(JSON.stringify(page.checkValues),before);
  assert.ok(requests.every(request=>['/api/import-checks','/api/score-preview'].includes(request.url.pathname)));
  console.log('Check import passed: recalculated scores, explicit overrides, partial/legacy templates, blank errors and date isolation.');
})().catch(error=>{console.error(error);process.exitCode=1;});
