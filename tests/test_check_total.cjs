const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const GradeRules = require('../static/grade-rules.js');
const controls = {yearSelect:{value:'2025'},reportSelect:{value:'12-31'},finalRows:{innerHTML:''},exportFinalBtn:{disabled:false}};
const context = {AbortController,GradeRules,document:{getElementById:id=>controls[id]}};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source+`
  state.samples=[{company_id:'co',company_name:'Company'}];
  state.model={grades:[{status:'打分映射',inclusive:1,grade:'Low',threshold:0},
                       {status:'打分映射',inclusive:1,grade:'High',threshold:15}]};
  this.page=state;
  this.h={sumRoundUp4,checkTotal,checkTotalText,checkPageData,savePageChecks,savePageCheckScore,finalScore,gradeForScore,renderSummaryPanels,checksReady};
`,context);
const h=context.h, page=context.page;
for (const [values, expected] of [
  [['1.23451'],'1.2346'],[['-1.23451'],'-1.2346'],
  [['1.23450'],'1.2345'],[['-1.23450'],'-1.2345'],
  [['0.00001','0.00001'],'0.0001'],[['0.00001','-0.00001'],'0.0000'],
  [[0.1,0.2],'0.3000'],[['1.0001','2.0002'],'3.0003'],
  [['.00001'],'0.0001'],[['1e-7'],'0.0001'],[['1.23451e2'],'123.4510'],
  [['1,000.12501','-1.12501'],'999.0000'],
  [[null,undefined,'','AA+','not-a-score',Infinity,NaN],'0.0000'],
]) assert.equal(h.sumRoundUp4(values),expected,JSON.stringify(values));

page.results.co={period_end:'2025-12-31',check_fields:[
  {field_id:'check',label:'Check',value:'0.31',score:'3.23451',expression:'formula',indicator_id:'different'},
  {field_id:'text',label:'Rating',value:'AA+',score:'0',expression:'rating formula'},
  {field_id:'unbound',label:'Without indicator',value:'',default_value:'2.00001',score:'2.00001'},
  {field_id:'empty',label:'Missing',value:'',score:0},
],details:[
  {indicator_id:'base',field_type:'打分项',score:10,weight:1},
  {indicator_id:'different',field_type:'排查项',score:99,weight:0.5,score_max:5},
]};
page.importedIndicatorValues.co={different:'999'};
assert.equal(h.checkTotalText('co'),'5.2346'); // Sum formula scores, ignoring raw values, weight and clamps.
assert.equal(h.checkTotal('co'),5.2346);
assert.equal(h.finalScore('co'),15.2346);
assert.equal(h.gradeForScore(h.finalScore('co')),'High');
assert.equal(h.checkPageData().rows[0].checks.unbound.value,''); // Calculation defaults never fill an empty input.
h.savePageCheckScore('co','check','3.00001');
assert.equal(h.checkTotalText('co'),'5.0001');
assert.equal(h.finalScore('co'),15.0001);
assert.equal(h.gradeForScore(h.finalScore('co')),'High');
h.renderSummaryPanels();
assert.ok(controls.finalRows.innerHTML.includes('<td>5.0001</td>'));
assert.equal(h.checkPageData().rows[0].checks.check.score_overridden,true);
assert.equal(h.checkPageData().rows[0].checks.check.value,'0.31'); // Editing score leaves the source value intact.
h.savePageCheckScore('co','text','1');
h.savePageChecks('co',{check:'0.2'});
assert.equal(h.checkPageData().rows[0].checks.check.score_overridden,false);
assert.equal(h.checkPageData().rows[0].checks.text.score_overridden,true); // Other manual scores are preserved.
page.results.co.check_fields[0].score=0; // Read-only server preview after changing the input.
assert.equal(h.checkTotalText('co'),'3.0001');
controls.yearSelect.value='2024';
assert.equal(h.checkTotalText('co'),'0.0000'); // No data from the stale date.
page.results.co={...page.results.co,period_end:'2024-12-31',check_fields:[{field_id:'check',label:'Check',value:'8',score:'2'}]};
h.savePageCheckScore('co','check','7');
assert.equal(h.checkTotalText('co'),'7.0000');
controls.yearSelect.value='2025';
page.results.co={...page.results.co,period_end:'2025-12-31'};
h.savePageCheckScore('co','check','3');
assert.equal(h.checkTotalText('co'),'3.0000');
controls.yearSelect.value='2024';
page.results.co.period_end='2024-12-31';
assert.equal(h.checkTotalText('co'),'7.0000'); // Manual scores are isolated by date and retained on return.
page.checkValues={}; page.checkScores={}; // Reset restores the computed database snapshot.
assert.equal(h.checkTotalText('co'),'2.0000');
page.results.co.check_fields[0].score=null;
assert.equal(h.checkTotalText('co'),null); // Formula failures cannot silently become zero or stale scores.
assert.equal(h.finalScore('co'),null);
assert.equal(h.checksReady(),false);
h.renderSummaryPanels();
assert.ok(controls.finalRows.innerHTML.includes('排查计算异常'));
assert.equal(controls.exportFinalBtn.disabled,true);
h.savePageCheckScore('co','check','0');
assert.equal(h.checksReady(),true); // An explicit zero override resolves the failed formula.
for (const invalid of ['0x10','0b10','0o10','Infinity','NaN','AA+','']) {
  h.savePageCheckScore('co','check',invalid);
  assert.equal(h.checkTotalText('co'),null,invalid);
}
h.savePageCheckScore('co','check','1.2e-3');
assert.equal(h.checkTotalText('co'),'0.0012');
console.log('Step-five totals passed: formula scores, manual overrides, field/date isolation, errors, exact decimals and final grade.');
