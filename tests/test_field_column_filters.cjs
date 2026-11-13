const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const requests = [];
let inputs = [], triggers = [], fail = false;
const decode = value => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attributes = html => Object.fromEntries([...html.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value]) => [key,decode(value)]));
const classList = () => ({toggle(){},add(){},remove(){}});
const parent = id => ({id,children:[],appendChild(node) {
  if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(child=>child!==node);
  this.children.push(node); node.parentNode = this;
}});
const body = parent('body');
const controls = new Proxy({}, {get(target,id) {
  return target[id] ??= {value:'',textContent:'',innerHTML:'',style:{},classList:classList(),
    querySelectorAll:()=>[],setAttribute(){},focus(){context.document.activeElement=this;}};
}});
controls.yearSelect.value = '2025'; controls.reportSelect.value = '12-31';
controls.fieldColumnModal = {...parent('fieldColumnModal'),open:false,showModal(){this.open=true;},close(){this.open=false;}};
controls.fieldColumnRows = {html:'',set innerHTML(html) {
  this.html = html;
  inputs = [...html.matchAll(/<input\b[^>]*>/g)].map(([tag])=>{
    const attrs = attributes(tag);
    return {value:attrs.value,dataset:{companyId:attrs['data-company-id']},classList:classList()};
  });
},get innerHTML(){return this.html;},querySelectorAll:()=>inputs,contains:element=>inputs.includes(element)};
controls.fieldColumnHead = {set innerHTML(html) {
  triggers.forEach(button=>{button.isConnected=false;});
  this.html=html;
  triggers=[...html.matchAll(/<button\b[^>]*>/g)].map(([tag])=>{
    const attrs=attributes(tag);
    return {dataset:{filterKey:attrs['data-filter-key'],filterTable:attrs['data-filter-table']},isConnected:true,
      getBoundingClientRect:()=>({top:100,bottom:125,left:100,right:135}),setAttribute(){},focus(){}};
  });
},get innerHTML(){return this.html;}};
controls.fieldColumnForm = {querySelectorAll:()=>[...inputs,...triggers]};
controls.fieldFilterPopover = {style:{},opened:false,parentNode:null,
  showPopover(){assert.equal(this.parentNode,controls.fieldColumnModal);assert(controls.fieldColumnModal.open);this.opened=true;},
  hidePopover(){this.opened=false;},matches(){return this.opened;},getBoundingClientRect:()=>({width:320,height:400})};
body.appendChild(controls.fieldFilterPopover); body.appendChild(controls.fieldColumnModal);
const context = {URL,AbortController,DOMException,setTimeout,clearTimeout,
  NumberFormat:require('../static/number-format.js'),ColumnFilters:require('../static/column-filters.js'),
  window:{location:{origin:'http://127.0.0.1'},innerWidth:1100,innerHeight:900},
  document:{body,getElementById:id=>controls[id],querySelectorAll:selector=>selector.includes('field-filter-trigger')?triggers:[]},
  alert:message=>{throw Error(message);},
  fetch:async(url,options)=>{
    assert.equal(url.pathname,'/api/rules-preview');
    const payload=JSON.parse(options.body); requests.push(payload);
    if(fail) return new Response(JSON.stringify({error:'try again'}),{status:500});
    return new Response(JSON.stringify({
      results:Object.fromEntries(payload.company_ids.map(id=>[id,{period_end:payload.period,details:[],check_fields:[]}])),
      field_matrix:{rows:payload.company_ids.map(id=>({company:context.page.samples.find(item=>item.company_id===id),
        values:{...context.page.fieldMatrix.rows.find(row=>row.company.company_id===id).values,...payload.overrides[id]}}))},
    }));
  },
};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
vm.runInNewContext(source+`
  renderFieldTable=renderInitialMatrix=renderCheckMatrix=renderSummaryPanels=()=>{};
  state.database='test';state.samples=['阿坝集团','北京集团','重庆集团','郑州集团','上海集团','长沙集团']
    .map((company_name,index)=>({company_id:String.fromCharCode(97+index),company_name}));
  state.fieldView={filters:{'company:company_name':['北京集团']},sort:{key:'source:metric',direction:'desc'}};
  state.fieldMatrix={fields:[{field_id:'metric',label:'调整后资产负债率',value_type:'number'},
    {field_id:'rating',label:'外部评级',value_type:'文本'}],rows:state.samples.map((company,index)=>({company,
      values:{metric:['10.0000002','2','','0','10.0000001','-3.5'][index],rating:['AA-','AA-','AAA','','BBB','A+'][index]}}))};
  state.results=Object.fromEntries(state.samples.map(company=>[company.company_id,{period_end:'2025-12-31',details:[],check_fields:[]}]));
  this.page=state;this.draft=()=>fieldColumnDraft;this.filter=()=>fieldFilterDraft;
  this.h={openFieldColumnModal,closeFieldColumnModal,saveFieldColumn,openFieldFilterPopover,closeFieldFilterPopover,
    sortFieldTable,applyFieldFilter,chooseFieldFilterValues,clearFieldTableView,refreshRatingTableView};
`,context);
const h=context.h, page=context.page;
const ids=()=>inputs.map(input=>input.dataset.companyId);
const input=id=>inputs.find(item=>item.dataset.companyId===id);
const open=(key='source:metric')=>h.openFieldFilterPopover(key,triggers.find(button=>button.dataset.filterKey===key),'fieldColumn');
const select=values=>{context.filter().selected=new Set(values);context.filter().changed=true;h.applyFieldFilter();};
const reset=()=>h.clearFieldTableView('fieldColumn');
(async()=>{
  const mainView=JSON.stringify(page.fieldView);
  h.openFieldColumnModal('metric');
  assert.equal(inputs.length,6); // Opening the modal includes companies hidden on the parent page.
  assert.equal(controls.fieldColumnViewStatus.textContent,'6 / 6 家公司');
  assert(!controls.fieldColumnRows.innerHTML.includes('<small>'));
  assert(controls.fieldColumnHead.innerHTML.includes('data-filter-table="fieldColumn"'));
  assert.equal(input('a').value,'10.0001');
  open(); assert.equal(controls.fieldFilterPopover.parentNode,controls.fieldColumnModal);
  h.sortFieldTable('asc');
  assert.deepEqual(ids(),['f','d','b','e','a','c']); // Exact original precision, with blanks last.
  assert.equal(controls.fieldFilterPopover.parentNode,body);
  open();h.sortFieldTable('desc');assert.deepEqual(ids(),['a','e','b','d','f','c']);
  open('company:company_name');h.sortFieldTable('asc');
  assert.equal(ids()[0],'a');assert.equal(ids().at(-1),'d');
  assert.equal(page.fieldMatrix.rows[0].values.metric,'10.0000002');
  reset();assert.deepEqual(ids(),['a','b','c','d','e','f']);

  open();h.chooseFieldFilterValues('duplicates');h.applyFieldFilter();assert.deepEqual(ids(),['a','e']);
  assert.equal(controls.fieldColumnViewStatus.textContent,'2 / 6 家公司');
  reset();open();h.chooseFieldFilterValues('unique');h.applyFieldFilter();assert.deepEqual(ids(),['b','c','d','f']);
  reset();open();select(['0.0000']);assert.deepEqual(ids(),['d']);
  reset();open();select(['']);assert.deepEqual(ids(),['c']);
  reset();open('company:company_name');controls.fieldFilterSearch.value='北京 上海';h.applyFieldFilter();
  assert.deepEqual(ids(),['b','e']);
  open();assert.deepEqual(Array.from(context.filter().options,item=>item.key),['2.0000','10.0001']);
  select(['2.0000']);assert.deepEqual(ids(),['b']);
  assert.equal(JSON.stringify(page.fieldView),mainView);assert.equal(requests.length,0);

  reset();const originalSamples=JSON.stringify(page.samples);
  input('a').value='12.123456789';input('a').oninput();
  open();h.sortFieldTable('desc');assert.equal(input('a').value,'12.123456789');
  open('company:company_name');select(['北京集团']);
  input('b').value='0';input('b').oninput();
  // Leaving the table applies existing filters; active editing does not replace the input.
  const focused=input('b');context.document.activeElement=focused;h.refreshRatingTableView('fieldColumn');
  assert.equal(input('b'),focused);context.document.activeElement=null;
  open();select([]);assert.equal(inputs.length,0);
  assert(controls.fieldColumnRows.innerHTML.includes('暂无符合筛选条件'));
  assert.equal(controls.fieldColumnViewStatus.textContent,'0 / 6 家公司');
  await h.saveFieldColumn();
  assert.deepEqual(requests[0].company_ids,['a','b']);
  assert.equal(requests[0].overrides.a.metric,'12.123456789');assert.equal(requests[0].overrides.b.metric,'0');
  assert.equal(page.overrides.a.metric,'12.123456789');assert.equal(page.overrides.b.metric,'0');
  assert.equal(page.overrides.e,undefined);assert.equal(page.fieldMatrix.rows[4].values.metric,'10.0000001');
  assert.equal(JSON.stringify(page.samples),originalSamples);assert.equal(JSON.stringify(page.fieldView),mainView);
  assert.equal(controls.fieldColumnModal.open,false);

  h.openFieldColumnModal('metric');assert.equal(inputs.length,6);assert.equal(context.draft().view.sort,null);
  input('f').value='6';input('f').oninput();
  open('company:company_name');select(['阿坝集团']);fail=true;await h.saveFieldColumn();
  assert.equal(page.overrides.f,undefined);assert(controls.fieldColumnStatus.textContent.includes('保存失败'));
  assert.equal(context.draft().rows.find(row=>row.company_id==='f').value,'6');
  assert.deepEqual(ids(),['a']);reset();assert.equal(input('f').value,'6');
  h.closeFieldColumnModal();assert.equal(page.overrides.f,undefined);fail=false;

  h.openFieldColumnModal('rating');open('source:rating');select(['AA-']);assert.deepEqual(ids(),['a','b']);
  input('b').value='AAA';input('b').oninput();
  open('source:rating');assert(context.filter().options.some(option=>option.key==='AAA'));
  h.closeFieldFilterPopover(true);assert.equal(controls.fieldColumnModal.open,true);
  assert.equal(controls.fieldFilterPopover.parentNode,body);assert.equal(input('b').value,'AAA');
  reset();open('source:rating');h.sortFieldTable('asc');assert.equal(ids().at(-1),'d');
  open('source:rating');h.closeFieldColumnModal();
  assert.equal(controls.fieldFilterPopover.parentNode,body);assert.equal(context.filter(),null);
  assert.equal(page.overrides.b.rating,undefined);

  h.openFieldColumnModal('metric');open();controls.yearSelect.value='2024';h.applyFieldFilter();
  assert.equal(context.filter(),null);assert.equal(Object.keys(context.draft().view.filters).length,0);
  h.closeFieldColumnModal(true);
  assert.equal(controls.fieldFilterPopover.parentNode,body);
  console.log('Column modal filters passed: hidden company IDs, shared filter controls inside the dialog, precise sorting, facets/search/duplicates, isolated views, retained hidden edits, full saves, retry, cancellation and stale dates.');
})().catch(error=>{console.error(error);process.exitCode=1;});
