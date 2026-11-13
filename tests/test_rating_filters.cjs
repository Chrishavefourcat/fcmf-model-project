const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const NumberFormat = require('../static/number-format.js');
const ColumnFilters = require('../static/column-filters.js');
const GradeRules = require('../static/grade-rules.js');
const controls = new Proxy({}, { get(target, id) {
  return target[id] ??= { innerHTML:'', textContent:'', value:'', disabled:false,
    classList:{toggle(){}}, querySelectorAll:()=>[], contains:()=>false,
    matches:()=>false, hidePopover(){} };
} });
controls.yearSelect.value = '2025';
controls.reportSelect.value = '12-31';
const context = { NumberFormat, ColumnFilters, GradeRules, AbortController,
  document:{getElementById:id=>controls[id], querySelectorAll:()=>[]} };
const source = fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
vm.runInNewContext(source + `
  this.page=state;
  this.h={initialTableData,checkTableData,finalTableData,tableDisplayRows,tableFilterContext,
    fieldFilterButton,applyFieldFilter,sortFieldTable,clearFieldTableView,resetTableViews,
    renderInitialMatrix,renderCheckMatrix,renderSummaryPanels,finalPageData,checkPageData,
    setIndicatorScore,saveInitialValue,savePageChecks,savePageCheckScore,refreshRatingTableView};
  this.draft=(table,key)=>{
    const data=tableFilterContext(table), options=ColumnFilters.options(data.rows,key,data.read);
    fieldFilterDraft={table,key,options,allValues:new Set(options.map(x=>x.key)),selected:new Set(options.map(x=>x.key)),
      controller:modelController,period:periodValue(),changed:true};
    return fieldFilterDraft;
  };
`,context);
const {page,h} = context;
page.gradeRules = {grades:['低','高'],boundaries:[-99999,4,99999]};
page.samples = [
  {company_id:'a',company_name:'甲公司',bond_id:'001.IB'},
  {company_id:'b',company_name:'乙公司',bond_id:'01.IB'},
  {company_id:'c',company_name:'丙公司',bond_id:''},
  {company_id:'d',company_name:'丁公司',bond_id:'1.IB'},
];
page.fieldMatrix.fields = [{field_id:'metric',value_type:'数字'},{field_id:'rating',value_type:'文本'}];
for (const [index,company] of page.samples.entries()) {
  const value = ['1.000000002','1.000000001','','0'][index];
  page.results[company.company_id] = { period_end:'2025-12-31', details:[
    {indicator_id:'A',field_id:'metric',label:'指标 A',input_value:value,raw_value:value||0,score:[10,2,0,0][index],weight:0.5,field_type:'打分项'},
    {indicator_id:'B',field_id:'rating',label:'信用等级',value_type:'文本',input_value:['AA+','AA','001','01'][index],score:0,weight:0.1,field_type:'打分项'},
  ],check_fields:[
    {field_id:'lending',label:'对外借款',value_type:'数字',value,score:[3,2,0,0][index],expression:'case(...)'},
    {field_id:'rating',label:'信用等级',value_type:'文本',value:['AA+','AA','001','01'][index],score:0,expression:'case(...)'},
  ] };
}
page.fieldMatrix.rows = page.samples.map(company=>({company,values:{metric:page.results[company.company_id].details[0].input_value}}));
const ids = rows => Array.from(rows,row=>row.company?.company_id || row.company_id);
const display = table => h.tableDisplayRows(table,h.tableFilterContext(table));
const original = JSON.stringify({samples:page.samples,results:page.results,fields:page.fieldMatrix});

let data=h.initialTableData();
assert.equal(data.columns.length,9); // Company + totals + three subcolumns for each indicator.
assert.equal(data.read(data.rows[0],'indicator-value:A').label,'1.0001');
assert.equal(data.read(data.rows[1],'indicator-value:A').label,'1.0001');
page.initialView.sort={key:'indicator-value:A',direction:'asc'};
assert.deepEqual(ids(display('initial')),['d','b','a','c']); // Sort by original precision, blanks last.
page.initialView.sort.direction='desc';
assert.deepEqual(ids(display('initial')),['a','b','d','c']);
page.initialView.filters={'indicator-value:A':['']};
assert.deepEqual(ids(display('initial')),['c']);
page.initialView.filters={'indicator-value:A':['0.0000']};
assert.deepEqual(ids(display('initial')),['d']);
page.initialView.filters={'summary:base_grade':['高'],'indicator-score:A':['10.0000']};
assert.deepEqual(ids(display('initial')),['a']);
assert.equal(display('check').length,4); // Same-company filters in another step stay independent.
page.initialView.filters={'indicator-value:B':['001']};
assert.deepEqual(ids(display('initial')),['c']);
assert.equal(h.initialTableData().read(data.rows[2],'indicator-value:B').numeric,false);
page.initialView.filters={};
page.initialView.sort={key:'indicator-weighted:A',direction:'desc'};
assert.deepEqual(ids(display('initial')),['a','b','c','d']);

data=h.checkTableData();
assert.equal(data.columns.length,5);
assert.equal(data.read(data.rows[2],'check-value:lending').label,'');
assert.equal(data.read(data.rows[3],'check-value:lending').label,'0.0000');
page.checkView.sort={key:'check-value:lending',direction:'asc'};
assert.deepEqual(ids(display('check')),['d','b','a','c']);
page.checkView.filters={'check-score:lending':['3.0000'],'company:company_name':['甲公司']};
assert.deepEqual(ids(display('check')),['a']);
assert.equal(display('final').length,4);
page.checkView.filters={'check-value:rating':['01']};
assert.deepEqual(ids(display('check')),['d']);
page.checkView.filters={};

data=h.finalTableData();
assert.equal(data.columns.length,9);
assert.equal(data.read(data.rows[0],'summary:bond_id').numeric,false);
page.finalView.sort={key:'summary:final_score',direction:'desc'};
assert.deepEqual(ids(display('final')),['a','b','c','d']);
page.finalView.filters={'summary:base_grade':['低'],'summary:check_score':['2.0000']};
assert.deepEqual(ids(display('final')),['b']);
page.finalView.filters={'summary:final_grade':['高']};
assert.deepEqual(ids(display('final')),['a']);
assert.equal(JSON.stringify({samples:page.samples,results:page.results,fields:page.fieldMatrix}),original);
assert.equal(h.finalPageData().rows.length,4); // Exports keep the full selected sample set and original order.
assert.deepEqual(ids(h.finalPageData().rows),['a','b','c','d']);
assert.equal(h.checkPageData().rows.length,4);

h.setIndicatorScore('b','A',18,9,'9');
assert.equal(h.initialTableData().read(h.initialTableData().rows[1],'indicator-score:A').label,'18.0000');
assert.deepEqual(ids(display('initial')),['b','a','c','d']);
h.saveInitialValue('b','metric','0');
assert.equal(h.initialTableData().read(h.initialTableData().rows[1],'indicator-value:A').label,'0.0000');
assert.equal(page.indicatorScores.b.A,undefined);
h.savePageCheckScore('b','lending','12');
page.checkView.sort={key:'check-score:lending',direction:'desc'};
assert.deepEqual(ids(display('check')),['b','a','c','d']);
assert.equal(h.finalTableData().rows[1].check_score,'12.0000');
h.savePageChecks('b',{lending:''});
assert.equal(h.checkTableData().read(h.checkTableData().rows[1],'check-value:lending').label,'');

h.renderInitialMatrix(); h.renderCheckMatrix(); h.renderSummaryPanels();
assert.equal((controls.initialHead.innerHTML.match(/data-filter-table="initial"/g)||[]).length,9);
assert.equal((controls.checkHead.innerHTML.match(/data-filter-table="check"/g)||[]).length,5);
assert.equal((controls.finalHead.innerHTML.match(/data-filter-table="final"/g)||[]).length,9);
page.initialView.filters={'company:company_name':[]}; h.renderInitialMatrix();
assert.ok(controls.initialRows.innerHTML.includes('暂无符合筛选条件'));
assert.ok(controls.initialViewStatus.textContent.includes('显示 0 / 4'));
page.initialView.filters={'removed:column':['x']}; page.initialView.sort={key:'removed:column',direction:'asc'};
assert.equal(display('initial').length,4); // Model/rule changes cannot leave stale columns hiding every row.
assert.equal(page.initialView.sort,null);

vm.runInNewContext('this.renders=[]; renderTableView=table=>this.renders.push(table||"field");',context);
for (const table of ['initial','check','final']) {
  const draft=context.draft(table,'company:company_name');
  draft.selected=new Set(['甲公司']);
  controls.fieldFilterSearch.value='';
  h.applyFieldFilter();
  assert.deepEqual(ids(display(table)),['a']);
  assert.equal(context.renders.at(-1),table);
  context.draft(table,'company:company_name'); h.sortFieldTable('desc');
  assert.equal(page[table+'View'].sort.direction,'desc');
  h.clearFieldTableView(table);
  assert.equal(Object.keys(page[table+'View'].filters).length,0);
  assert.equal(page[table+'View'].sort,null);
}
const draft=context.draft('initial','company:company_name');draft.selected.clear();
controls.yearSelect.value='2024';h.applyFieldFilter();
assert.equal(Object.keys(page.initialView.filters).length,0); // A previous-period popup cannot commit.
controls.yearSelect.value='2025';
page.initialView.sort={key:'summary:base_score',direction:'desc'};
controls.initialRows.contains=()=>true;
const rendered=context.renders.length;
h.refreshRatingTableView('initial');assert.equal(context.renders.length,rendered); // Preserve active editing focus.
controls.initialRows.contains=()=>false;
h.refreshRatingTableView('initial');assert.equal(context.renders.at(-1),'initial');
h.resetTableViews();
for (const table of ['field','initial','check','final']) {
  assert.equal(Object.keys(page[table+'View'].filters).length,0);
  assert.equal(page[table+'View'].sort,null);
}
console.log('Rating filters passed: all requested columns, exact sorting, blanks/zero, text values, manual edits, independent views, stale contexts, editing focus and full-sample exports.');
