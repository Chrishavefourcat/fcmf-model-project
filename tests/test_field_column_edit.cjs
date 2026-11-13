const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const NumberFormat=require('../static/number-format.js');
let inputs=[],fail=false,deferred=null,requests=[],focusCount=0;
const buttons=[{disabled:false},{disabled:false}];
const fieldButton={dataset:{fieldId:'metric'},focus(){focusCount++;}};
const decode=value=>value.replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const rows={html:'',set innerHTML(value){this.html=value;inputs=[...value.matchAll(/data-company-id="([^"]*)"[^>]*value="([^"]*)"/g)]
  .map(match=>({dataset:{companyId:decode(match[1])},value:decode(match[2]),disabled:false}));},get innerHTML(){return this.html;},querySelectorAll(){return inputs;}};
const controls={yearSelect:{value:'2025'},reportSelect:{value:'12-31'},fieldColumnTitle:{},fieldColumnHelp:{},fieldColumnValueHead:{},fieldColumnStatus:{},
  fieldColumnRows:rows,fieldColumnForm:{querySelectorAll(){return [...inputs,...buttons];}},
  fieldColumnModal:{open:false,showModal(){this.open=true;},close(){this.open=false;}}};
const preview=payload=>({results:Object.fromEntries(payload.company_ids.map(id=>[id,{period_end:payload.period,
  details:[{indicator_id:'A',field_id:'metric',raw_value:Number(payload.overrides[id].metric),score:Number(payload.overrides[id].metric)*4},
    {indicator_id:'B',field_id:'other',raw_value:2,score:Number(payload.overrides[id].metric)+1},
    {indicator_id:'C',field_id:'fixed',raw_value:4,score:4}],
  check_fields:[{field_id:'check',value:payload.overrides[id].check??'',score:1}]}])),
  field_matrix:{rows:payload.company_ids.map(id=>({company:{company_id:id},values:{metric:'database',fixed:'4'},indicator_values:{}}))}});
const context={NumberFormat,URL,AbortController,DOMException,window:{location:{origin:'http://127.0.0.1'}},alert:message=>{throw Error(message);},
  document:{getElementById:id=>controls[id],querySelectorAll:selector=>selector==='.field-column-edit'?[fieldButton]:[]},
  fetch:async(url,options)=>{
    assert.equal(url.pathname,'/api/rules-preview');
    const payload=JSON.parse(options.body);requests.push(payload);
    assert.equal(payload.rules.A.expression,'metric * 4');
    if(deferred)return new Promise(resolve=>{deferred.resolve=resolve;deferred.payload=payload;});
    return new Response(JSON.stringify(fail?{error:'preview failed'}:preview(payload)),{status:fail?500:200});
  },
};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
vm.runInNewContext(source+`
 renderFieldTable=renderInitialMatrix=renderCheckMatrix=renderSummaryPanels=()=>{};
 state.database='test';state.ruleOverrides={A:{expression:'metric * 4'}};
 state.samples=[{company_id:'a',company_name:'A<&"'},{company_id:'b',company_name:'B'},{company_id:'c',company_name:'C'}];
 state.fieldMatrix={fields:[{field_id:'metric',label:'测试字段',value_type:'number'}, {field_id:'check',label:'排查字段',field_type:'排查项'}],
  rows:state.samples.map((company,i)=>({company,values:{metric:['1.23456789','0',''][i],check:'1',fixed:'4'}}))};
 state.results=Object.fromEntries(state.samples.map(company=>[company.company_id,{period_end:'2025-12-31',details:[
  {indicator_id:'A',field_id:'metric',raw_value:0,score:0},{indicator_id:'B',field_id:'other',raw_value:2,score:1},
  {indicator_id:'C',field_id:'fixed',raw_value:4,score:4}],check_fields:[]}]));
 this.page=state;this.h={openFieldColumnModal,closeFieldColumnModal,saveFieldColumn};
`,context);
(async()=>{
 const h=context.h,page=context.page;
 h.openFieldColumnModal('metric');
 assert.equal(controls.fieldColumnModal.open,true);assert.equal(inputs.length,3);
 assert.equal(inputs[0].value,'1.2346');assert.equal(inputs[1].value,'0.0000');assert.equal(inputs[2].value,'');
 assert.ok(rows.innerHTML.includes('A&lt;&amp;&quot;'));assert.ok(controls.fieldColumnHelp.textContent.includes('3 家公司'));
 inputs[0].value='99';h.closeFieldColumnModal();assert.equal(page.overrides.a,undefined);assert.equal(requests.length,0);
 h.openFieldColumnModal('metric');await h.saveFieldColumn();assert.equal(requests.length,0);assert.equal(controls.fieldColumnModal.open,false);
 page.overrides.b={other_field:'12'};
 page.checkValues.b={'2025-12-31':{check:'7'}};page.checkScores.b={'2025-12-31':{check:'9'}};
 page.indicatorScores.b={A:{score:99},B:{score:88},C:{score:9}};
 h.openFieldColumnModal('metric');inputs[1].value='3.5';inputs[2].value='0';
 await h.saveFieldColumn();
 assert.deepEqual(requests[0].company_ids,['b','c']);assert.equal(requests[0].overrides.b.other_field,'12');assert.equal(requests[0].overrides.b.check,'7');
 assert.equal(page.overrides.b.metric,'3.5');assert.equal(page.overrides.c.metric,'0');assert.equal(page.overrides.a,undefined);
 assert.equal(page.fieldMatrix.rows[0].values.metric,'1.23456789');assert.equal(page.fieldMatrix.rows[1].values.metric,'3.5');
 assert.equal(page.results.b.details[0].score,14);assert.equal(page.indicatorScores.b.A,undefined);assert.equal(page.indicatorScores.b.B,undefined);
 assert.equal(page.indicatorScores.b.C.score,9);assert.equal(page.checkScores.b['2025-12-31'].check,'9');
 assert.equal(controls.fieldColumnModal.open,false);assert.ok(focusCount>0);
 h.openFieldColumnModal('metric');inputs[1].value='';await h.saveFieldColumn();assert.equal(page.overrides.b.metric,'');
 h.openFieldColumnModal('metric');inputs[1].value='6';fail=true;await h.saveFieldColumn();
 assert.equal(controls.fieldColumnModal.open,true);assert.equal(inputs[1].value,'6');assert.equal(page.overrides.b.metric,'');
 assert.ok(controls.fieldColumnStatus.textContent.includes('保存失败'));assert.ok(inputs.every(input=>!input.disabled));
 fail=false;await h.saveFieldColumn();assert.equal(page.overrides.b.metric,'6');
 h.openFieldColumnModal('check');inputs[1].value='5';await h.saveFieldColumn();
 assert.equal(page.overrides.b.check,'5');assert.equal(page.checkValues.b['2025-12-31'].check,undefined);assert.equal(page.checkScores.b['2025-12-31'].check,undefined);
 h.openFieldColumnModal('metric');inputs[0].value='20';deferred={};const save=h.saveFieldColumn();
 assert.ok(inputs.every(input=>input.disabled));h.closeFieldColumnModal();assert.equal(controls.fieldColumnModal.open,true);
 controls.yearSelect.value='2024';deferred.resolve(new Response(JSON.stringify(preview(deferred.payload))));await save;
 assert.equal(page.overrides.a,undefined);assert.equal(controls.fieldColumnModal.open,false);deferred=null;
 controls.yearSelect.value='2025';h.openFieldColumnModal('metric');inputs[0].value='21';deferred={};const modelSave=h.saveFieldColumn();
 vm.runInNewContext('modelController=new AbortController();',context);
 deferred.resolve(new Response(JSON.stringify(preview(deferred.payload))));await modelSave;
 assert.equal(page.overrides.a,undefined);
 const html=fs.readFileSync('static/index.html','utf8');assert.ok(html.includes('id="fieldColumnModal"'));assert.ok(source.includes('field-column-edit'));
 console.log('Column editing passed: selected company scope, per-company values, cancellation, unchanged precision, blanks/zero, formula refresh, manual scores, failure retry and stale model/date isolation.');
})().catch(error=>{console.error(error);process.exitCode=1;});
