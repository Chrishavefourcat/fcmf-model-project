const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const NumberFormat = require('../static/number-format.js');
const requests = [];
const controls = {yearSelect:{value:'2025'},reportSelect:{value:'12-31'},initialValueStatus:{textContent:''},checkTransferStatus:{textContent:''},exportChecksBtn:{}};
const input = (indicatorId,fieldId='metric') => ({value:'',dataset:{companyId:'co',indicatorId,fieldId,period:'2025-12-31'},classList:{add(){},toggle(){}}});
const raw = input('A'), sharedRaw = input('B'), assign = input('A'), weighted = input('A');
const context = {NumberFormat,URL,AbortController,DOMException,setTimeout,clearTimeout,
  window:{location:{origin:'http://127.0.0.1'}},
  document:{getElementById:id=>controls[id],querySelectorAll:selector=>({
    '.indicator-value-input':[raw,sharedRaw],
    '#initialRows .indicator-value-input':[raw,sharedRaw],
    '#initialRows .assign-input':[assign],
    '#initialRows .weighted-input':[weighted],
  }[selector] || [])},
  fetch:(url,options)=>new Promise(resolve=>requests.push({url,payload:JSON.parse(options.body),resolve})),
};
const source = fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
vm.runInNewContext(source+`
  updateStepNavigation = applyOverridesToFieldMatrix = renderFieldTable = renderSummaryPanels = () => {};
  state.database='test'; state.samples=[{company_id:'co'},{company_id:'other'}];
  state.results.other={period_end:'2025-12-31',details:[],check_fields:[]};
  this.page=state; this.jobs=checkEditJobs;
  this.h={bindInitialInputs,indicatorRawDisplay,indicatorScore,indicatorWeightedExact,queueCheckEdit,
    saveInitialValue,setIndicatorScore,cancelCheckEdits,checkValue,checksReady};
`,context);
const details = (value,score) => [
  {indicator_id:'A',field_id:'metric',label:'Metric A',input_value:value,raw_value:value===''?0:Number(value),score,weight:0.2,field_type:'打分项'},
  {indicator_id:'B',field_id:'metric',label:'Shared field',input_value:value,raw_value:value===''?0:Number(value),score,weight:1,field_type:'打分项'},
  {indicator_id:'C',field_id:'other_metric',input_value:'4',raw_value:4,score:4,weight:1,field_type:'打分项'},
];
const result = (value,score,period='2025-12-31')=>({period_end:period,details:details(value,score),check_fields:[]});
const wait=()=>new Promise(resolve=>setTimeout(resolve,20));
(async()=>{
 const h=context.h,page=context.page;
 page.results.co=result('',0);
 assert.equal(h.indicatorRawDisplay(page.results.co.details[0]),'');
 assert.equal(h.indicatorRawDisplay({...page.results.co.details[0],input_value:'0'}),'0.0000');
 assert.equal(h.indicatorRawDisplay({...page.results.co.details[0],input_value:'AA-'}),'AA-');
 assert.equal(h.checkValue('co',{field_id:'check',value:'',default_value:'12'}),'');
 assert.equal(h.checkValue('co',{field_id:'check',value:'0',default_value:'12'}),'0');
 h.bindInitialInputs();
 h.setIndicatorScore('co','A',8,1.6);
 h.setIndicatorScore('co','C',9,9);
 raw.value='2.123456';context.document.activeElement=raw;raw.oninput();
 assert.equal(raw.value,'2.123456'); // Typing keeps focus and full input precision.
 assert.equal(page.overrides.co.metric,'2.123456');
 assert.equal(page.indicatorScores.co.A,undefined);
 assert.equal(page.indicatorScores.co.C.score,9); // Unrelated manual score survives.
 raw.onchange();await wait();
 assert.equal(requests.at(-1).url.pathname,'/api/score-preview');
 assert.equal(requests.at(-1).payload.overrides.metric,'2.123456');
 assert.equal(h.checksReady(),false);
 context.document.activeElement=assign; // Tab into the automatic assignment while waiting.
 requests.at(-1).resolve(new Response(JSON.stringify(result('2.123456',4))));await wait();
 assert.equal(assign.value,'4.0000');
 assert.equal(weighted.value,'0.8000');
 assert.equal(sharedRaw.value,'2.1235');
 assert.equal(page.indicatorScores.co.C.score,9);
 assert.equal(h.checksReady(),true);
 assert.ok(controls.initialValueStatus.textContent.includes('已更新'));
 raw.value='3';raw.oninput();raw.onchange();await wait();
 h.setIndicatorScore('co','A',7,1.4);assign.value='7.';context.document.activeElement=assign;
 requests.at(-1).resolve(new Response(JSON.stringify(result('3',6))));await wait();
 assert.equal(assign.value,'7.'); // A manual score entered during preview takes priority.
 assert.equal(h.indicatorScore('co',page.results.co.details[0]).score,7);
 assert.equal(weighted.value,'1.4000');
 raw.value='';raw.oninput();raw.onchange();await wait();
 requests.at(-1).resolve(new Response(JSON.stringify(result('',0))));await wait();
 assert.equal(raw.value,'');assert.equal(sharedRaw.value,'');assert.equal(page.overrides.co.metric,'');
 raw.value='0';raw.oninput();raw.onchange();await wait();
 requests.at(-1).resolve(new Response(JSON.stringify(result('0',0))));await wait();
 assert.equal(sharedRaw.value,'0.0000');
 raw.value='5';raw.oninput();raw.onchange();await wait();const stale=requests.at(-1);
 raw.value='6';raw.oninput();raw.onchange();await wait();
 requests.at(-1).resolve(new Response(JSON.stringify(result('6',12))));await wait();
 stale.resolve(new Response(JSON.stringify(result('5',10))));await wait();
 assert.equal(page.results.co.details[0].score,12);
 assert.equal(page.results.other.details.length,0);
 raw.value='9';raw.oninput();raw.onchange();await wait();
 controls.yearSelect.value='2024';h.cancelCheckEdits();
 requests.at(-1).resolve(new Response(JSON.stringify(result('9',18))));await wait();
 assert.equal(page.results.co.details[0].score,12);
 assert.equal(context.jobs.size,0);
 console.log('Initial values passed: editable field inputs, live scores, blanks versus real zeros, focus, shared fields, manual scores, stale responses and date isolation.');
})().catch(error=>{console.error(error);process.exitCode=1;});
