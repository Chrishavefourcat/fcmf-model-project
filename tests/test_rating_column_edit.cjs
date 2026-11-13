const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const NumberFormat=require('../static/number-format.js');
let inputs=[],requests=[],failed=false,deferred=null,timerId=0;
const timers=new Map(),buttons=[{disabled:false}],controls={};
const decode=value=>value.replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
for(const id of ['ratingColumnTitle','ratingColumnHelp','ratingColumnHead','ratingColumnStatus']) controls[id]={classList:{toggle(){}}};
controls.yearSelect={value:'2025'};controls.reportSelect={value:'12-31'};
controls.ratingColumnModal={open:false,dataset:{},showModal(){this.open=true;},close(){this.open=false;}};
controls.ratingColumnRows={html:'',set innerHTML(value){this.html=value;inputs=[...value.matchAll(/data-company-id="([^"]*)" data-edit-kind="([^"]*)"[^>]*value="([^"]*)"/g)].map(match=>({
  dataset:{companyId:decode(match[1]),editKind:match[2]},value:decode(match[3]),disabled:false,classList:{toggle(){}},focus(){}}));},get innerHTML(){return this.html;},querySelectorAll:()=>inputs};
controls.ratingColumnForm={querySelectorAll:()=>[...inputs,...buttons]};
const context={NumberFormat,URL,AbortController,DOMException,alert:message=>{throw Error(message);},
  setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
  document:{getElementById:id=>controls[id],querySelectorAll:()=>[]},window:{location:{origin:'http://localhost'}},
  fetch:async(url,options)=>{
    const payload=JSON.parse(options.body);requests.push({path:url.pathname,payload});
    const data=url.pathname==='/api/score-preview'?result(payload.company_id,payload.overrides):{
      results:Object.fromEntries(payload.company_ids.map(id=>[id,result(id,payload.overrides[id])])),
      field_matrix:{rows:payload.company_ids.map(id=>({company:{company_id:id},values:{...values[id],...payload.overrides[id]}}))},
    };
    if(deferred)return new Promise(resolve=>{deferred.resolve=()=>resolve(new Response(JSON.stringify(data)));});
    return new Response(JSON.stringify(failed?{error:'preview failed'}:data),{status:failed?500:200});
  }};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
vm.runInNewContext(source+`
  renderFieldTable=renderInitialMatrix=renderCheckMatrix=renderSummaryPanels=()=>{};
  state.database='test';
  this.page=state;
  this.h={openRatingColumnModal,closeRatingColumnModal,editRatingColumnCell,previewRatingColumnRow,saveRatingColumn};
  this.draft=()=>ratingColumnDraft;
`,context);
const values={a:{metric:'1.23456789',lending:'0.31'},b:{metric:'0',lending:''},c:{metric:'',lending:'0'}};
function result(id,overrides={}){
 const data={...values[id],...overrides},v=Number(data.metric||0),l=Number(data.lending||0);
 return {period_end:'2025-12-31',details:[
  {indicator_id:'A',field_id:'metric',label:'指标 A',input_value:data.metric,raw_value:v,score:v*4,weight:0.2,score_min:0,score_max:100},
  {indicator_id:'B',field_id:'metric',label:'共享字段',input_value:data.metric,raw_value:v,score:v+1,weight:0.1},
  {indicator_id:'C',field_id:'fixed',label:'其他指标',input_value:'4',raw_value:4,score:4,weight:1},
 ],check_fields:[{field_id:'lending',label:'对外借款',value:data.lending,score:l>0.3?'3':l>0.2?'2':'0',expression:'case(...)'},
  {field_id:'other',label:'其他排查项',value:'1',score:'1',expression:'other(...)'}]};
}
const {page,h}=context;
page.samples=[{company_id:'a',company_name:'A<&"'},{company_id:'b',company_name:'B'},{company_id:'c',company_name:'C'}];
page.results=Object.fromEntries(page.samples.map(company=>[company.company_id,result(company.company_id)]));
page.fieldMatrix={fields:[{field_id:'metric',value_type:'number'}],rows:page.samples.map(company=>({company,values:{...values[company.company_id]}}))};
page.initialView.filters={'company:company_name':['A']};page.checkView.filters={'company:company_name':['B']};
const snapshot=()=>JSON.stringify({results:page.results,overrides:page.overrides,scores:page.indicatorScores,checks:page.checkValues,checkScores:page.checkScores,matrix:page.fieldMatrix});
const edit=(row,kind,value)=>h.editRatingColumnCell(context.draft(),row,kind,value);
const preview=row=>h.previewRatingColumnRow(context.draft(),row);
const batchCount=()=>requests.filter(request=>request.path==='/api/rules-preview').length;
(async()=>{
 h.openRatingColumnModal('initial','A');let draft=context.draft();
 assert.equal(draft.rows.length,3);assert.equal(inputs.length,9);assert.ok(controls.ratingColumnHead.innerHTML.includes('赋分'));
 assert.equal(draft.rows[0].values.value,'1.2346');assert.equal(draft.rows[1].values.value,'0.0000');assert.equal(draft.rows[2].values.value,'');
 assert.ok(controls.ratingColumnRows.innerHTML.includes('A&lt;&amp;&quot;'));
 const before=snapshot();edit(draft.rows[0],'value','3');await preview(draft.rows[0]);
 assert.equal(draft.rows[0].values.score,'12.0000');assert.equal(draft.rows[0].values.weighted,'2.4000');assert.equal(snapshot(),before);
 h.closeRatingColumnModal();assert.equal(snapshot(),before);assert.equal(controls.ratingColumnModal.open,false);
 h.openRatingColumnModal('initial','A');const noChange=batchCount();await h.saveRatingColumn();assert.equal(batchCount(),noChange);

 page.indicatorScores.b={A:{score:99,weighted:19.8},B:{score:99,weighted:9.9},C:{score:9,weighted:9}};
 page.checkScores.b={'2025-12-31':{other:'8'}};
 h.openRatingColumnModal('initial','A');draft=context.draft();
 edit(draft.rows[0],'weighted','1');assert.equal(draft.rows[0].values.score,'5.0000');
 edit(draft.rows[1],'value','3.5');await preview(draft.rows[1]);assert.equal(draft.rows[1].values.score,'14.0000');
 edit(draft.rows[1],'score','18');assert.equal(draft.rows[1].values.weighted,'3.6000');
 edit(draft.rows[2],'score','10');assert.equal(draft.rows[2].values.weighted,'2.0000');
 await h.saveRatingColumn();
 assert.deepEqual(requests.at(-1).payload.company_ids,['b']);assert.equal(page.overrides.a,undefined);
 assert.equal(page.fieldMatrix.rows[0].values.metric,'1.23456789');assert.equal(page.overrides.b.metric,'3.5');
 assert.equal(page.indicatorScores.a.A.score,5);assert.equal(page.indicatorScores.b.A.score,18);assert.equal(page.indicatorScores.c.A.score,10);
 assert.equal(page.indicatorScores.b.B,undefined);assert.equal(page.indicatorScores.b.C.score,9);assert.equal(page.checkScores.b['2025-12-31'].other,'8');
 assert.equal(controls.ratingColumnModal.open,false);

 h.openRatingColumnModal('initial','A');draft=context.draft();
 edit(draft.rows[0],'score','999');assert.equal(draft.rows[0].values.score,'100.0000');assert.equal(draft.rows[0].values.weighted,'20.0000');
 edit(draft.rows[0],'weighted','-5');assert.equal(draft.rows[0].values.score,'0.0000');
 h.closeRatingColumnModal();
 h.openRatingColumnModal('initial','A');draft=context.draft();
 edit(draft.rows[0],'value','');await preview(draft.rows[0]);await h.saveRatingColumn();
 assert.equal(page.overrides.a.metric,'');assert.equal(page.indicatorScores.a.A,undefined);assert.equal(page.fieldMatrix.rows[0].values.metric,'');

 h.openRatingColumnModal('initial','A');draft=context.draft();
 const reverted= snapshot();edit(draft.rows[1],'value','7');deferred={};const stale=preview(draft.rows[1]);
 edit(draft.rows[1],'value',draft.rows[1].original.value);deferred.resolve();await stale;deferred=null;
 assert.equal(draft.rows[1].values.score,draft.rows[1].original.score);await h.saveRatingColumn();assert.equal(snapshot(),reverted);

 h.openRatingColumnModal('initial','A');draft=context.draft();edit(draft.rows[1],'value','6');
 const failureBefore=snapshot();failed=true;await h.saveRatingColumn();assert.equal(snapshot(),failureBefore);
 assert.equal(controls.ratingColumnModal.open,true);assert.equal(draft.rows[1].values.value,'6');assert.ok(controls.ratingColumnStatus.textContent.includes('保存失败'));
 assert.ok(inputs.every(input=>!input.disabled));failed=false;await h.saveRatingColumn();assert.equal(page.overrides.b.metric,'6');

 h.openRatingColumnModal('check','lending');draft=context.draft();assert.equal(inputs.length,6);assert.ok(!controls.ratingColumnHead.innerHTML.includes('赋分'));
 assert.equal(draft.rows[1].values.value,'');assert.equal(draft.rows[2].values.value,'0.0000');
 const checkBefore=snapshot();edit(draft.rows[1],'value','0.31');deferred={};const pending=preview(draft.rows[1]);
 edit(draft.rows[1],'score','1.23456789');deferred.resolve();await pending;deferred=null;
 assert.equal(draft.rows[1].values.score,'1.2346');assert.equal(snapshot(),checkBefore);
 edit(draft.rows[2],'value','');await preview(draft.rows[2]);await h.saveRatingColumn();
 assert.equal(page.checkValues.b['2025-12-31'].lending,'0.31');assert.equal(page.checkScores.b['2025-12-31'].lending,'1.23456789');
 assert.equal(page.checkScores.b['2025-12-31'].other,'8');assert.equal(page.indicatorScores.b.C.score,9);
 assert.equal(page.checkValues.c['2025-12-31'].lending,'');

 h.openRatingColumnModal('check','lending');draft=context.draft();edit(draft.rows[0],'score','bad');const invalidBefore=snapshot();await h.saveRatingColumn();
 assert.equal(snapshot(),invalidBefore);assert.equal(controls.ratingColumnModal.open,true);assert.ok(controls.ratingColumnStatus.textContent.includes('有效数字'));
 edit(draft.rows[0],'score','2');const manualOnly=batchCount();await h.saveRatingColumn();assert.equal(batchCount(),manualOnly);assert.equal(page.checkScores.a['2025-12-31'].lending,'2');

 h.openRatingColumnModal('check','lending');draft=context.draft();edit(draft.rows[0],'value','0.25');await preview(draft.rows[0]);
 assert.equal(draft.rows[0].values.score,'2.0000');edit(draft.rows[0],'value','0.2');await preview(draft.rows[0]);assert.equal(draft.rows[0].values.score,'0.0000');
 await h.saveRatingColumn();assert.equal(page.checkScores.a['2025-12-31'].lending,undefined);

 h.openRatingColumnModal('initial','A');draft=context.draft();edit(draft.rows[0],'value','22');deferred={};const dateBefore=snapshot(),saving=h.saveRatingColumn();
 assert.ok(inputs.every(input=>input.disabled));h.closeRatingColumnModal();assert.equal(controls.ratingColumnModal.open,true);
 controls.yearSelect.value='2024';deferred.resolve();await saving;deferred=null;assert.equal(snapshot(),dateBefore);assert.equal(controls.ratingColumnModal.open,false);
 controls.yearSelect.value='2025';
 h.openRatingColumnModal('initial','A');draft=context.draft();edit(draft.rows[0],'value','23');deferred={};const modelBefore=snapshot(),modelSaving=h.saveRatingColumn();
 vm.runInNewContext('modelController=new AbortController();',context);deferred.resolve();await modelSaving;deferred=null;assert.equal(snapshot(),modelBefore);
 console.log('Rating column editing passed: whole-sample dialogs, live preview, score/weight linkage, clamps, blanks/zero, manual priority, cancellation, precision, atomic retry and stale model/date rejection.');
})().catch(error=>{console.error(error);process.exitCode=1;});
