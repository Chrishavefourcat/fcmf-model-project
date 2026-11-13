const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const requests = [], alerts = [];
const decode = value => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const classes = value => {
  const names = new Set(value.split(/\s+/));
  return {add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name),
    toggle(name, on) { if (on) names.add(name); else names.delete(name); }};
};
const attributes = html => Object.fromEntries([...html.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value]) => [key,decode(value)]));
let tableRebuilds = 0;
const controls = new Proxy({}, {get(target,id) {
  return target[id] ??= {value:'',textContent:'',innerHTML:'',classList:classes('hidden'),setAttribute(){}};
}});
controls.yearSelect.value = '2025'; controls.reportSelect.value = '12-31';
controls.fieldRows = {children:[],set innerHTML(value) {this.children = []; tableRebuilds++;},
  appendChild(row) {this.children.push(row);}};
function createRow() {
  return {dataset:{},inputs:[],cells:[],html:'',set innerHTML(html) {
    this.html = html;
    this.inputs = [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => {
      const attrs = attributes(tag), td = {classList:classes('')};
      return {value:attrs.value,dataset:{companyId:attrs['data-company-id'],fieldId:attrs['data-field-id'],period:attrs['data-period']},
        classList:classes(attrs.class),closest:()=>td,selectionStart:2,selectionEnd:2};
    });
    this.cells = [...html.matchAll(/<td class="indicator-column"([^>]*)>([^<]*)<\/td>/g)].map(([,attrs,value]) => ({
      dataset:{indicatorId:attributes(attrs)['data-indicator-id']},textContent:decode(value),
    }));
  },querySelectorAll: function() {return this.cells;}};
}
const context = {URL,AbortController,DOMException,setTimeout,clearTimeout,
  NumberFormat:require('../static/number-format.js'),ColumnFilters:require('../static/column-filters.js'),
  window:{location:{origin:'http://127.0.0.1'}},alert:message=>alerts.push(message),
  document:{getElementById:id=>controls[id],createElement:createRow,
    querySelectorAll:selector => selector === '#fieldRows tr[data-company-id]' ? controls.fieldRows.children
      : selector === '#fieldRows .source-value-input' ? controls.fieldRows.children.flatMap(row=>row.inputs) : []},
  fetch:(url,options)=>new Promise(resolve=>requests.push({url,payload:JSON.parse(options.body),resolve})),
};
const source = fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
vm.runInNewContext(source + `
  updateStepNavigation = renderSummaryPanels = () => {};
  state.database='test'; state.sourceId='chosen-file'; state.showIndicators=true;
  state.samples=[{company_id:'co',company_name:'甲主体'},{company_id:'other',company_name:'乙主体'}];
  state.fieldMatrix={fields:[
    {field_id:'ratio',label:'调整后资产负债率',value_type:'number'},
    {field_id:'rating',label:'外部评级',value_type:'文本'}],
    columns:[{kind:'source',field_id:'ratio',label:'调整后资产负债率',value_type:'number'},
      {kind:'source',field_id:'rating',label:'外部评级',value_type:'文本'},
      {kind:'indicator',indicator_id:'A',label:'相关指标',expression:'ratio * 2'},
      {kind:'indicator',indicator_id:'B',label:'其他指标',expression:'other_metric'}],
    rows:state.samples.map(company=>({company,values:{ratio:'1.123456789',rating:'AA-'},indicator_values:{A:2,B:4}}))};
  this.page=state; this.jobs=checkEditJobs;
  this.h={renderFieldTable,openFieldModal,queueCheckEdit,cancelCheckEdits,checksReady,exportFieldsExcel,savePageCheckScore};
`, context);
const result = (value,score=Number(value)*2) => ({period_end:'2025-12-31',details:[
  {indicator_id:'A',field_id:'computed',input_value:value,raw_value:score,score,weight:1},
  {indicator_id:'B',field_id:'other_metric',raw_value:4,score:4,weight:1}],
  check_fields:[{field_id:'derived_check',value,score:Number(value)}]});
const page = context.page, h = context.h;
page.results.co = result('1'); page.results.other = result('10');
const wait = () => new Promise(resolve=>setTimeout(resolve,25));
const input = (id='co',field='ratio') => controls.fieldRows.children.find(row=>row.dataset.companyId===id).inputs.find(item=>item.dataset.fieldId===field);
const cell = (id='co',indicator='A') => controls.fieldRows.children.find(row=>row.dataset.companyId===id).cells.find(item=>item.dataset.indicatorId===indicator);
const resolveLatest = async value => { requests.at(-1).resolve(new Response(JSON.stringify(result(value)))); await wait(); };
const edit = async value => { const raw=input(); context.document.activeElement=raw; raw.value=value; raw.oninput(); raw.onchange(); await wait(); return raw; };
(async()=>{
  h.renderFieldTable();
  assert.equal(input().value,'1.1235');
  assert.equal(input('co','rating').value,'AA-');
  assert(controls.fieldRows.children[0].html.includes('aria-label="甲主体 调整后资产负债率"'));
  h.openFieldModal('co');
  assert(!controls.modalFields.innerHTML.includes('<em>'));
  assert(controls.modalFields.innerHTML.includes('调整后资产负债率'));
  assert(controls.modalFields.innerHTML.includes('data-field-id="ratio"'));

  const untouched = input(); untouched.onblur(); await wait();
  assert.equal(page.fieldMatrix.rows[0].values.ratio,'1.123456789');
  assert.equal(page.overrides.co,undefined); // Opening/closing an input does not round the stored value.
  assert.equal(requests.length,0);

  page.indicatorScores.co={A:{score:9},B:{score:8}};
  page.importedIndicatorValues.co={A:9,B:8};
  page.checkValues.co={'2025-12-31':{ratio:'older check input'}};
  page.checkScores.co={'2025-12-31':{ratio:'9',derived_check:'9',unrelated:'7'}};
  page.ruleOverrides={A:{expression:'ratio * 2',weight:1}};
  const raw=await edit('2.123456789'), rebuilds=tableRebuilds;
  assert.equal(page.overrides.co.ratio,'2.123456789');
  assert.equal(page.checkValues.co['2025-12-31'].ratio,undefined);
  assert.equal(requests.at(-1).payload.overrides.ratio,'2.123456789');
  assert.equal(requests.at(-1).payload.rules.A.expression,'ratio * 2');
  assert.equal(cell().textContent,'计算中…');
  assert.equal(controls.exportFieldsBtn.disabled,true);
  assert.equal(h.checksReady(),false);
  await h.exportFieldsExcel(); assert.equal(alerts.length,1);
  await resolveLatest('2.123456789');
  assert.equal(tableRebuilds,rebuilds); // Response updates cells without destroying the focused input.
  assert.equal(context.document.activeElement,raw);
  assert.equal(raw.value,'2.123456789'); assert.equal(raw.selectionStart,2);
  assert.equal(cell().textContent,'4.2470');
  assert.equal(page.indicatorScores.co.A,undefined);
  assert.equal(page.importedIndicatorValues.co.A,undefined);
  assert.equal(page.indicatorScores.co.B.score,8);
  assert.equal(page.importedIndicatorValues.co.B,8);
  assert.equal(page.checkScores.co['2025-12-31'].derived_check,undefined);
  assert.equal(page.checkScores.co['2025-12-31'].unrelated,'7');
  assert.equal(page.results.other.details[0].score,20);
  assert.equal(controls.exportFieldsBtn.disabled,false);

  // Typing pauses trigger calculation without waiting for blur or a Save button.
  raw.value='3'; raw.oninput(); await new Promise(resolve=>setTimeout(resolve,280));
  assert.equal(requests.at(-1).payload.overrides.ratio,'3');
  await resolveLatest('3'); assert.equal(cell().textContent,'6.0000');
  for (const value of ['', '0']) {
    await edit(value); await resolveLatest(value);
    assert.equal(page.overrides.co.ratio,value); assert.equal(raw.value,value);
  }
  const text=input('co','rating'); context.document.activeElement=text;
  text.oncompositionstart(); text.value='中文评级'; text.oninput({isComposing:true});
  assert.equal(page.overrides.co.rating,undefined);
  text.oncompositionend(); text.onchange(); await wait();
  assert.equal(requests.at(-1).payload.overrides.rating,'中文评级');
  await resolveLatest('0'); assert.equal(text.value,'中文评级');

  await edit('5'); const stale=requests.at(-1);
  await edit('6'); await resolveLatest('6');
  stale.resolve(new Response(JSON.stringify(result('5')))); await wait();
  assert.equal(cell().textContent,'12.0000');
  await edit('7');
  requests.at(-1).resolve(new Response(JSON.stringify({error:'temporarily unavailable'}),{status:500})); await wait();
  assert.equal(input().value,'7'); assert.equal(page.overrides.co.ratio,'7');
  assert.equal(cell().textContent,'计算失败'); assert.equal(h.checksReady(),false);
  assert(controls.fieldEditStatus.textContent.includes('输入已保留'));
  input().onchange(); await wait(); await resolveLatest('7');
  assert.equal(cell().textContent,'14.0000'); assert.equal(h.checksReady(),true);

  page.fieldView.sort={key:'source:ratio',direction:'desc'};
  assert.equal(controls.fieldRows.children[0].dataset.companyId,'co');
  const sortingInput=await edit('0'); await resolveLatest('0');
  assert.equal(controls.fieldRows.children[0].dataset.companyId,'co');
  context.document.activeElement=null; sortingInput.onblur(); await wait();
  assert.equal(controls.fieldRows.children[0].dataset.companyId,'other');

  await edit('9'); const before=page.results.co;
  controls.yearSelect.value='2024'; h.cancelCheckEdits();
  await resolveLatest('9'); assert.equal(page.results.co,before);
  controls.yearSelect.value='2025';
  h.renderFieldTable(); await edit('10');
  vm.runInNewContext('modelController = new AbortController();',context);
  await resolveLatest('10'); assert.equal(page.results.co,before);
  h.cancelCheckEdits();
  assert(requests.every(request=>request.url.pathname==='/api/score-preview'));
  console.log('Source inline edits passed: hidden popup IDs, editable numbers/text, debounce, precision, blanks/zero, page-only previews, dependent scores, focus, sorting, failure retry and stale responses.');
})().catch(error=>{console.error(error);process.exitCode=1;});
