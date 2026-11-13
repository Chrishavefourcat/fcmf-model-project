const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const requests = [];
let weights = [], inputs = [], summaryUpdates = 0;
const attrs = html=>Object.fromEntries([...html.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,value]));
const classes = text=>({contains:name=>text.split(' ').includes(name),toggle(){},add(){}});
const controls = new Proxy({}, {get(target,id) {
  return target[id] ??= {value:'',textContent:'',innerHTML:'',classList:classes(''),setAttribute(){}};
}});
controls.yearSelect.value='2025';controls.reportSelect.value='12-31';
const parse = html=>[...html.matchAll(/<input\b[^>]*>/g)].map(([tag])=>{
  const a=attrs(tag);
  const input={value:a.value,dataset:{companyId:a['data-company-id'],indicatorId:a['data-indicator-id'],
    fieldId:a['data-field-id'],weight:a['data-weight'],period:a['data-period']},classList:classes(a.class),attributes:a,
    setAttribute(name,value){this.attributes[name]=value;}};
  input.closest=()=>({nextElementSibling:{querySelector:()=>inputs.find(item=>item.dataset.companyId===input.dataset.companyId && item.dataset.indicatorId===input.dataset.indicatorId && item.classList.contains('weighted-input'))},
    previousElementSibling:{querySelector:()=>inputs.find(item=>item.dataset.companyId===input.dataset.companyId && item.dataset.indicatorId===input.dataset.indicatorId && item.classList.contains('assign-input'))}});
  return input;
});
controls.initialHead={html:'',set innerHTML(html){this.html=html;weights=parse(html);},get innerHTML(){return this.html;},contains:element=>weights.includes(element)};
controls.initialRows={set innerHTML(html){inputs=parse(html);},contains:element=>inputs.includes(element)};
const context={URL,AbortController,DOMException,setTimeout,clearTimeout,CSS:{escape:value=>value},
  NumberFormat:require('../static/number-format.js'),ColumnFilters:require('../static/column-filters.js'),GradeRules:require('../static/grade-rules.js'),
  window:{location:{origin:'http://127.0.0.1'}},document:{getElementById:id=>controls[id],querySelectorAll:selector=>{
    if(selector==='.indicator-weight-input') return weights;
    const name=selector.match(/\.(indicator-value-input|assign-input|weighted-input)$/)?.[1];
    return name?inputs.filter(input=>input.classList.contains(name)):[];
  }},fetch:async(url,options)=>{requests.push({url,payload:JSON.parse(options.body)});return new Response('{}');}};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
vm.runInNewContext(source+`
  renderSummaryPanels=()=>{ summaryTick(); };
  state.database='test';state.model={grades:[{status:'打分映射',inclusive:1,grade:'低',threshold:0},{status:'打分映射',inclusive:1,grade:'高',threshold:15}]};
  state.samples=[{company_id:'co',company_name:'甲公司'},{company_id:'other',company_name:'乙公司'}];
  state.results=Object.fromEntries(state.samples.map(company=>[company.company_id,{period_end:'2025-12-31',details:[
    {indicator_id:'A',field_id:'metric',label:'指标甲',input_value:'3',score:10,weight:0.2,score_min:0,score_max:100},
    {indicator_id:'B',field_id:'another',label:'指标乙',input_value:'2',score:20,weight:0.1},
    {indicator_id:'C',field_id:'fixed',label:'固定项',input_value:'4',score:4,weight:1}],check_fields:[]}]));
  state.fieldMatrix={fields:[{field_id:'metric',value_type:'number'}],rows:[]};
  state.ruleOverrides={A:{expression:'metric * 2'}};
  state.indicatorScores.co={A:{score:7,weighted:1.4,weighted_exact:'1.4'},C:{score:9,weighted:9,weighted_exact:'9'}};
  this.page=state;this.jobs=checkEditJobs;
  this.h={renderInitialMatrix,applyInitialWeight,bindInitialWeights,baseScore,gradeForScore,indicatorWeightedExact,postJson,updateStepNavigation};
`,Object.assign(context,{summaryTick:()=>{summaryUpdates++;}}));
const page=context.page,h=context.h;
const weighted=(company='co',id='A')=>inputs.find(input=>input.dataset.companyId===company && input.dataset.indicatorId===id && input.classList.contains('weighted-input'));
(async()=>{
  h.renderInitialMatrix();
  const header=controls.initialHead.innerHTML;
  assert.equal((header.match(/rowspan="3"/g)||[]).length,4);
  assert(header.includes('<span>%</span>'));
  assert.equal(weights[0].attributes.type,'number');
  assert.equal(weights[0].value,'20.0000');assert(!weights[0].value.includes('%'));
  const a=weights[0],sourceBefore=JSON.stringify(page.fieldMatrix);
  context.document.activeElement=a;a.value='50.';a.oninput();
  assert.equal(weights[0],a);assert.equal(a.value,'50.'); // Typing keeps the header input and caret.
  assert.equal(page.ruleOverrides.A.weight,0.5);assert.equal(page.ruleOverrides.A.expression,'metric * 2');
  assert.equal(page.results.other.details[0].weight,0.5);
  assert.equal(page.indicatorScores.co.A.score,7);assert.equal(page.indicatorScores.co.A.weighted_exact,'3.5');
  assert.equal(page.indicatorScores.co.C.score,9);assert.equal(page.results.co.details[1].weight,0.1);
  assert.equal(weighted().value,'3.5000');assert.equal(weighted('other').value,'5.0000');
  assert.equal(weighted().dataset.weight,'0.5');assert.equal(h.baseScore('co'),14.5);
  assert.equal(JSON.stringify(page.fieldMatrix),sourceBefore);assert(summaryUpdates>0);
  a.value='100';a.oninput();assert.equal(h.baseScore('co'),18);assert.equal(h.gradeForScore(h.baseScore('co')),'高');

  for(const invalid of ['', '-1', 'NaN', '20%', '1e9999']) {
    a.value=invalid;a.oninput();assert.equal(page.ruleOverrides.A.weight,1);
    assert.equal(a.attributes['aria-invalid'],'true');
  }
  a.onblur();assert.equal(a.value,'100.0000');assert.equal(a.attributes['aria-invalid'],'false');
  a.value='0';a.oninput();assert.equal(page.ruleOverrides.A.weight,0);
  assert.equal(h.indicatorWeightedExact('co',page.results.co.details[0]),'7'); // Existing zero-weight scoring rule.

  a.value='12.3456789';a.oninput();assert.equal(page.ruleOverrides.A.weight,0.123456789);
  a.onblur();assert.equal(a.value,'12.3457');a.onblur();assert.equal(page.ruleOverrides.A.weight,0.123456789);
  await h.postJson('/api/score-preview',{company_id:'co',period:'2025-12-31'});
  assert.equal(requests[0].payload.rules.A.weight,0.123456789);assert.equal(requests[0].payload.rules.A.expression,'metric * 2');

  page.initialView.sort={key:'summary:base_score',direction:'asc'};
  context.document.activeElement=a;a.value='25';a.oninput();assert.equal(weights[0],a);
  context.jobs.set('co',{});h.updateStepNavigation();assert.equal(a.disabled,true);
  const before=page.ruleOverrides.A.weight;a.value='30';a.oninput();assert.equal(page.ruleOverrides.A.weight,before);
  context.jobs.clear();h.updateStepNavigation();assert.equal(a.disabled,false);
  const assigned=inputs.find(input=>input.dataset.companyId==='co' && input.dataset.indicatorId==='A' && input.classList.contains('assign-input'));
  context.document.activeElement=assigned;assigned.value='6';assigned.oninput();
  assert.equal(weighted().value,'1.5000');assert.equal(page.indicatorScores.co.A.score,6);
  controls.yearSelect.value='2024';a.value='90';a.oninput();assert.equal(page.ruleOverrides.A.weight,before);
  controls.yearSelect.value='2025';
  vm.runInNewContext('modelController=new AbortController();',context);a.value='90';a.oninput();assert.equal(page.ruleOverrides.A.weight,before);
  assert(requests.every(request=>request.url.pathname==='/api/score-preview'));
  console.log('Initial weights passed: fixed percent unit, editable values, immediate weighted scores/grades, preserved assignments, zero rule, precision, page-only rules and stale/pending edit guards.');
})().catch(error=>{console.error(error);process.exitCode=1;});
