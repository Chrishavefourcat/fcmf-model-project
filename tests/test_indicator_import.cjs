const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const GradeRules = require('../static/grade-rules.js');
const controls = {yearSelect:{value:'2025'},reportSelect:{value:'12-31'},importFieldsInput:{value:'file'}};
const alerts = [], requests = [];
const grades = [{status:'打分映射',inclusive:1,grade:'Low',threshold:0},
                {status:'打分映射',inclusive:1,grade:'High',threshold:40}];
let imported = {overrides:{co:{metric:'3'},unselected:{metric:'9'}},
  indicator_values:{co:{A:'77.25',B:'0',C:'',X:'4'},unselected:{A:'99'}}};
let resolveImport;
const context = {URL,AbortController,DOMException,GradeRules,
  window:{location:{origin:'http://127.0.0.1'}},
  document:{getElementById:id=>controls[id]}, alert:message=>alerts.push(message),
  fetch:async (url, options)=>{
    requests.push({url,options});
    if (url.pathname === '/api/import-fields') {
      if (resolveImport) return new Promise(resolve=>{ resolveImport.resolve=resolve; });
      return new Response(JSON.stringify(imported));
    }
    if (url.pathname === '/api/grades') return new Response(JSON.stringify({grades,database_path:'test.db'}));
    assert.equal(url.pathname,'/api/score-preview');
    const payload = JSON.parse(options.body);
    assert.equal(payload.company_id,'co');
    assert.equal(payload.period,'2025-12-31');
    const input = Number(payload.overrides.metric);
    const rule = payload.rules.A;
    const score = rule?.expression === 'metric * 4' ? input * 4 : input * 2 + 2;
    return new Response(JSON.stringify({period_end:payload.period,
      check_fields:[{field_id:'check',label:'Check',value:payload.overrides.check ?? '7.75',score:payload.overrides.check ?? '7.75'}], details:[
        {indicator_id:'A',score,weight:rule?.weight ?? 0.5,field_type:'打分项',score_min:0,score_max:100},
        {indicator_id:'B',score:20,weight:1,field_type:'打分项'},
        {indicator_id:'C',score:10,weight:1,field_type:'打分项'},
        {indicator_id:'X',score:2,weight:0,field_type:'排查项',score_min:0,score_max:5},
      ]}));
  },
};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source+`
  cancelCheckEdits = applyOverridesToFieldMatrix = renderFieldTable = renderInitialMatrix =
    renderCheckMatrix = renderSamples = renderSummaryPanels = () => {};
  state.database='test'; state.samples=[{company_id:'co'}]; state.step=1;
  state.model={grades:${JSON.stringify(grades)}};
  state.importedIndicatorValues={co:{A:'999',B:'0',C:''},other:{A:'66'}};
  state.indicatorScores.co={A:{score:99,weighted:99}};
  this.page=state;
  this.h={importFieldsExcel,indicatorDisplayValues,baseScore,checkTotal,finalScore,gradeForScore,
    refreshScores,savePageChecks};
`,context);
const previewCount=()=>requests.filter(request=>request.url.pathname==='/api/score-preview').length;
(async()=>{
  const h=context.h, page=context.page, file=new Blob(['same Excel file']);
  await h.importFieldsExcel(file);
  assert.equal(requests[0].url.pathname,'/api/import-fields');
  assert.equal(page.overrides.co.metric,'3');
  assert.equal(page.overrides.unselected,undefined);
  assert.equal(page.importedIndicatorValues.co,undefined);
  assert.equal(page.importedIndicatorValues.other.A,'66');
  assert.equal(page.indicatorScores.co,undefined);
  assert.equal(previewCount(),1);
  const displayed=h.indicatorDisplayValues('co',{indicator_values:{A:123}});
  assert.equal(displayed.A,'8.0000'); // Calculated value wins over stale Excel and matrix values.
  assert.equal(displayed.B,'20.0000');
  assert.equal(displayed.C,'10.0000');
  assert.equal(h.baseScore('co'),34);
  assert.equal(h.checkTotal('co'),7.75);
  assert.equal(h.finalScore('co'),41.75);
  assert.equal(h.gradeForScore(h.baseScore('co')),'Low');
  assert.equal(h.gradeForScore(h.finalScore('co')),'High');
  assert.ok(alerts.at(-1).includes('重新计算指标值'));
  assert.ok(alerts.at(-1).includes('未写入数据库'));
  assert.equal(controls.importFieldsInput.value,''); // The same file can be selected again.

  // Reimporting identical inputs must still issue a fresh calculation.
  page.importedIndicatorValues.co={A:'999'};
  await h.importFieldsExcel(file);
  assert.equal(previewCount(),2);
  assert.equal(h.indicatorDisplayValues('co',{}).A,'8.0000');
  await h.refreshScores(); // Moving between steps keeps page inputs and computed results.
  assert.equal(h.indicatorDisplayValues('co',{}).A,'8.0000');

  imported={overrides:{co:{metric:'5'}},indicator_values:{co:{A:'77.25'}}};
  await h.importFieldsExcel(file);
  assert.equal(h.indicatorDisplayValues('co',{}).A,'12.0000');
  assert.equal(h.baseScore('co'),36);

  // Unchanged source values are also recalculated using the current page formula/weight.
  page.ruleOverrides={A:{expression:'metric * 4',weight:0.25}};
  await h.importFieldsExcel(file);
  assert.equal(h.indicatorDisplayValues('co',{}).A,'20.0000');
  assert.equal(h.baseScore('co'),35);
  const latestPreview=requests.filter(request=>request.url.pathname==='/api/score-preview').at(-1);
  assert.equal(JSON.parse(latestPreview.options.body).rules.A.expression,'metric * 4');

  // An indicator-only file triggers calculation from existing page inputs, not its snapshot.
  h.savePageChecks('co',{check:'2.5'});
  imported={overrides:{},indicator_values:{co:{A:'0'}}};
  const beforeIndicatorOnly=previewCount();
  await h.importFieldsExcel(file);
  assert.equal(previewCount(),beforeIndicatorOnly+1);
  assert.equal(h.indicatorDisplayValues('co',{}).A,'20.0000');
  assert.equal(page.checkValues.co['2025-12-31'].check,'2.5');
  assert.equal(h.checkTotal('co'),2.5);

  // Source zeros and blanks are imported even when the Excel snapshot is nonzero.
  for (const value of ['0','']) {
    imported={overrides:{co:{metric:value}},indicator_values:{co:{A:'999'}}};
    await h.importFieldsExcel(file);
    assert.equal(page.overrides.co.metric,value);
    assert.equal(h.indicatorDisplayValues('co',{}).A,'0.0000');
  }

  const beforeUnmatched=previewCount();
  imported={overrides:{unselected:{metric:'9'}},indicator_values:{unselected:{A:'99'}}};
  await h.importFieldsExcel(file);
  assert.equal(previewCount(),beforeUnmatched);
  assert.equal(page.overrides.unselected,undefined);
  assert.ok(alerts.at(-1).includes('没有匹配'));

  // A response from a previous date cannot change the new page context.
  resolveImport={};
  const pending=h.importFieldsExcel(file);
  await new Promise(resolve=>setImmediate(resolve));
  controls.yearSelect.value='2024';
  page.importedIndicatorValues={};
  resolveImport.resolve(new Response(JSON.stringify({overrides:{co:{metric:'99'}},indicator_values:{co:{A:'99'}}})));
  await pending;
  assert.equal(page.overrides.co.metric,'');
  assert.equal(page.importedIndicatorValues.co,undefined);
  const readOnlyEndpoints=new Set(['/api/import-fields','/api/grades','/api/score-preview']);
  assert.ok(requests.every(request=>readOnlyEndpoints.has(request.url.pathname)));
  assert.ok(requests.every(request=>request.options.cache==='no-store'));
  console.log('Indicator import passed: every import recalculates, unchanged inputs, current page formulas, ignored snapshots, zero/blank inputs, downstream scores, page-only requests and stale response isolation.');
})().catch(error=>{console.error(error);process.exitCode=1;});
