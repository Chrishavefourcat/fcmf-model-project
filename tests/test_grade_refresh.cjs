const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const GradeRules=require('../static/grade-rules.js');
const classList=()=>{const values=new Set(['hidden']);return {
  contains:value=>values.has(value),add:value=>values.add(value),remove:value=>values.delete(value),
  toggle(value,on){if(on)values.add(value);else values.delete(value);},
};};
const controls=Object.fromEntries(['gradeRulesModal','gradeRulesRows','gradeRulesSource','gradeRulesStatus',
  'gradeRulesSave','gradeRulesReload','modelStatus'].map(id=>[id,{textContent:'',innerHTML:'',disabled:false,classList:classList()}]));
let threshold=10,calls=0,fail=false,pending=null;
const response=()=>new Response(JSON.stringify({grades:[{status:'打分映射',inclusive:1,grade:'R1',threshold}],database_path:'E:\\models\\selected.db'}));
const context={URL,AbortController,GradeRules,window:{location:{origin:'http://localhost'}},
  document:{getElementById:id=>controls[id]},fetch:async(url,options)=>{
    calls++; assert.equal(url.pathname,'/api/grades'); assert.equal(options.cache,'no-store');
    if(pending)return new Promise(resolve=>{pending.resolve=resolve;});
    if(fail)return new Response(JSON.stringify({error:'database unavailable'}),{status:500});
    return response();
  }};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source+`
  state.database='selected'; state.sourceDirectory='E:\\models'; state.samples=[{company_id:'co'}];
  state.model={grades:[{status:'打分映射',inclusive:1,grade:'Old',threshold:0}]};
  renderGradeRules=renderInitialMatrix=renderSummaryPanels=()=>{};
  this.page=state; this.h={openGradeRules,refreshDatabaseGrades,refreshGradesOnFocus,gradeForScore};
  this.close=()=>{gradeOpenVersion++;gradeRuleDraft=null;$('gradeRulesModal').classList.add('hidden');};
`,context);
(async()=>{
  const h=context.h,page=context.page;
  await h.openGradeRules();
  assert.equal(page.model.grades[0].threshold,10);
  assert.equal(h.gradeForScore(5),null);
  assert.ok(controls.gradeRulesSource.textContent.includes('selected.db'));
  context.close(); threshold=20;
  await h.openGradeRules(); // An external DB edit must be visible on reopening the popup.
  assert.equal(page.model.grades[0].threshold,20);
  assert.ok(controls.gradeRulesStatus.textContent.includes('已读取数据库最新规则'));
  const custom={grades:['Page'],boundaries:[0,100]};
  page.gradeRules=custom;
  context.close(); const before=calls; threshold=30;
  await h.openGradeRules();
  assert.equal(calls,before);
  assert.equal(page.gradeRules,custom);
  assert.equal(h.gradeForScore(5),'Page');
  fail=true; await h.openGradeRules(true);
  assert.equal(page.gradeRules,custom); // A failed explicit refresh cannot discard edits.
  assert.ok(controls.gradeRulesStatus.textContent.includes('database unavailable'));
  fail=false; await h.openGradeRules(true);
  assert.equal(page.gradeRules,null);
  assert.equal(page.model.grades[0].threshold,30);
  assert.equal(h.gradeForScore(5),null);
  context.close(); threshold=40; await h.refreshGradesOnFocus();
  assert.equal(page.model.grades[0].threshold,40);
  pending={};
  const p1=h.refreshDatabaseGrades(),p2=h.refreshDatabaseGrades();
  assert.equal(p1,p2); // Concurrent readers share one query.
  threshold=50; pending.resolve(response()); await p1;
  assert.equal(page.model.grades[0].threshold,50);
  pending={}; const stale=h.refreshDatabaseGrades();
  page.gradeRules=custom;
  threshold=60; pending.resolve(response());
  assert.equal(await stale,false);
  assert.equal(page.gradeRules,custom);
  assert.equal(page.model.grades[0].threshold,50);
  assert.equal(controls.gradeRulesReload.disabled,false);
  console.log('Grade refresh passed: external changes, popup reopen, focus, explicit reset, file path, cache control, failure isolation and stale responses.');
})().catch(error=>{console.error(error);process.exitCode=1;});
