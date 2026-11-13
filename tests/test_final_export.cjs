const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const GradeRules=require('../static/grade-rules.js');
const controls={yearSelect:{value:'2025'},reportSelect:{value:'12-31'},finalRows:{innerHTML:''},
  exportFinalBtn:{disabled:false},finalExportStatus:{textContent:''}};
let filename, request;
class LocalURL extends URL { static createObjectURL(){return 'blob:test';} static revokeObjectURL(){} }
const context={AbortController,GradeRules,URL:LocalURL,Blob,alert:()=>{},document:{getElementById:id=>controls[id],
  body:{appendChild(){}},createElement:()=>({click(){filename=this.download;},remove(){}})}};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source+`
  state.samples=[{company_id:'co',company_name:'Company',bond_id:'001.IB'}];
  state.model={grades:[]};
  state.gradeRules={grades:['Low','High'],boundaries:[-99999,6,99999]};
  state.ruleOverrides={A:{weight:0.2,expression:'metric*2'}};
  state.results.co={period_end:'2025-12-31',original_grade:'R4',check_fields:[
    {field_id:'c1',label:'One',value:'0',score:'1.23451',expression:'formula'},
    {field_id:'c2',label:'Two',value:'0',score:'0.00001',expression:'formula'}],
    details:[{indicator_id:'A',raw_value:10,score:20,weight:0.2,field_type:'打分项'}]};
  state.results.unselected={details:[]};
  state.fieldMatrix.rows=[{company:state.samples[0],values:{metric:'10'}}];
  state.overrides.co={metric:'0'};
  state.importedIndicatorValues.co={A:'77.25'};
  state.indicatorScores.co={A:{score:25,weighted:5}};
  state.checkValues.co={'2025-12-31':{c1:'1.23451',c2:'0.00001'}};
  this.page=state; this.h={finalPageData,finalSummaryRows,renderSummaryPanels,exportFinalExcel};
  this.jobs=checkEditJobs;
`,context);
vm.runInNewContext(`postDownload=async(url,payload)=>{
  this.request={url,payload};
  return {blob:new Blob(['xlsx']),filename:'模型评级计算最终定级_2025-12-31_20261021_173012.xlsx'};
};`,context);
(async()=>{
  const page=context.h.finalPageData(), row=page.rows[0];
  assert.equal(page.rows.length,1);
  assert.equal(row.source_values.metric,'0');
  assert.equal(row.indicator_values.A,'77.2500');
  assert.equal(row.indicators.A.weighted,'5.0000');
  assert.equal(row.check_score,'1.2346');
  assert.equal(row.checks.c1.value,'1.23451');
  assert.equal(row.checks.c1.score,'1.23451');
  assert.equal(row.checks.c1.score_overridden,false);
  assert.equal(row.base_grade,'Low');
  assert.equal(row.final_grade,'High');
  assert.equal(row.original_grade,'R4');
  context.h.renderSummaryPanels();
  assert.ok(controls.finalRows.innerHTML.includes('<td>1.2346</td>'));
  assert.ok(controls.finalRows.innerHTML.includes('<td>High</td>'));
  await context.h.exportFinalExcel();
  assert.equal(context.request.url,'/api/export-final');
  assert.equal(context.request.payload.rules.A.expression,'metric*2');
  assert.equal(context.request.payload.page_data.rows.length,1);
  assert.equal(filename,'模型评级计算最终定级_2025-12-31_20261021_173012.xlsx');
  assert.equal(controls.exportFinalBtn.disabled,false);
  assert.ok(controls.finalExportStatus.textContent.includes('7 个工作表'));
  const previous=context.request;
  context.jobs.set('co',{});
  await context.h.exportFinalExcel();
  assert.equal(context.request,previous);
  console.log('Final export passed: current page scope, source/indicator edits, manual scores, four decimals, grade rules and timestamped download.');
})().catch(error=>{console.error(error);process.exitCode=1;});
