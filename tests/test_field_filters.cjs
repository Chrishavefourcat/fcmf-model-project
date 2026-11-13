const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const NumberFormat=require('../static/number-format.js'),ColumnFilters=require('../static/column-filters.js');
const rows=[
 {id:'a',number:'10',city:'郑州'}, {id:'b',number:'2',city:'洛阳'}, {id:'c',number:'',city:'郑州'},
 {id:'d',number:'0',city:'郑州'}, {id:'e',number:'-3.5',city:'洛阳'},
];
const read=(row,key)=>({value:row[key],label:key==='number'?NumberFormat.fmt(row[key]):row[key],numeric:key==='number'});
const ids=items=>items.map(row=>row.id);
const original=JSON.stringify(rows);
assert.deepEqual(ids(ColumnFilters.apply(rows,{}, {key:'number',direction:'asc'},read)),['e','d','b','a','c']);
assert.deepEqual(ids(ColumnFilters.apply(rows,{}, {key:'number',direction:'desc'},read)),['a','b','d','e','c']);
assert.deepEqual(ids(ColumnFilters.apply(rows,{city:['郑州']},{key:'number',direction:'asc'},read)),['d','a','c']);
assert.deepEqual(ids(ColumnFilters.apply(rows,{city:['郑州'],number:['0.0000','']},null,read)),['c','d']);
assert.deepEqual(ids(ColumnFilters.apply(rows,{number:[]},null,read)),[]);
const facet=ColumnFilters.options(ColumnFilters.apply(rows,{city:['郑州'],number:['0.0000']},null,read,'number'),'number',read);
assert.deepEqual(facet.map(item=>[item.key,item.count]),[['0.0000',1],['10.0000',1],['',1]]);
assert.deepEqual(ColumnFilters.options(rows,'city',read).map(item=>item.count).sort(),[2,3]);
assert.deepEqual(ColumnFilters.search(facet,'空白').map(item=>item.key),['']);
assert.equal(ColumnFilters.search(ColumnFilters.options(rows,'city',read),'郑 洛').length,2);
assert.equal(JSON.stringify(rows),original);
const exact=[{id:'larger',number:'9007199254740992.000000002'},{id:'smaller',number:'9007199254740992.000000001'}];
assert.deepEqual(ids(ColumnFilters.apply(exact,{}, {key:'number',direction:'asc'},read)),['smaller','larger']);
assert.equal(NumberFormat.compareNumbers('1e-8','0.000000010'),0);
assert.equal(NumberFormat.compareNumbers('','0'),null);
assert.equal(NumberFormat.compareNumbers('-1.000000001','-1'),-1);
const tied=[{id:'first',number:'2'},{id:'second',number:'2'}];
assert.deepEqual(ids(ColumnFilters.apply(tied,{}, {key:'number',direction:'desc'},read)),['first','second']);

const controls={yearSelect:{value:'2025'},reportSelect:{value:'12-31'},fieldFilterSearch:{value:''},fieldFilterPopover:{
 open:false,matches(){return this.open;},hidePopover(){this.open=false;}}};
const context={NumberFormat,ColumnFilters,AbortController,document:{getElementById:id=>controls[id],querySelectorAll:()=>[]}};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
vm.runInNewContext(source+`
 renderFieldTable=()=>{};
 state.samples=[{company_id:'a'},{company_id:'b'},{company_id:'c'}];
 state.fieldMatrix={fields:[{field_id:'metric',label:'数值',value_type:'number'}],columns:[
  {kind:'source',field_id:'metric',label:'数值',value_type:'number'},
  {kind:'source',field_id:'code',label:'代码',value_type:'文本'},
  {kind:'indicator',indicator_id:'metric',label:'计算指标'}],rows:[
  {company:{company_id:'a',company_name:'甲'},values:{metric:'1.23456789',code:'001'}},
  {company:{company_id:'b',company_name:'乙'},values:{metric:'0',code:'01'}},
  {company:{company_id:'c',company_name:'丙'},values:{metric:'',code:'1'}},
  {company:{company_id:'unselected',company_name:'不显示'},values:{metric:'99',code:'9'}}]};
 state.results={a:{details:[{indicator_id:'metric',score:'10'}]},b:{details:[{indicator_id:'metric',score:'2'}]},c:{details:[{indicator_id:'metric',score:'0'}]}};
 this.page=state;this.h={fieldTableReader,fieldTableDisplayRows,fieldColumnKey,applyFieldFilter,sortFieldTable,clearFieldTableView,chooseFieldFilterValues};
 this.setDraft=(key,selected,changed=true)=>{fieldFilterDraft={key,selected:new Set(selected),allValues:new Set(['1.2346','0.0000','']),
  options:[{key:'1.2346',count:2},{key:'0.0000',count:1},{key:'',count:1}],controller:modelController,period:periodValue(),changed};};
 renderFieldFilterOptions=()=>{};
`,context);
const h=context.h,page=context.page;
const appRead=h.fieldTableReader();
assert.equal(appRead(page.fieldMatrix.rows[0],'source:metric').label,'1.2346');
assert.equal(appRead(page.fieldMatrix.rows[0],'source:code').label,'001');
assert.equal(appRead(page.fieldMatrix.rows[0],'indicator:metric').label,'10.0000');
assert.equal(appRead(page.fieldMatrix.rows[1],'source:metric').label,'0.0000');
assert.equal(appRead(page.fieldMatrix.rows[2],'source:metric').label,'');
assert.equal(appRead(page.fieldMatrix.rows[0],'company:company_name').numeric,false);
page.fieldView.sort={key:'indicator:metric',direction:'asc'};
assert.deepEqual(Array.from(h.fieldTableDisplayRows(),row=>row.company.company_id),['c','b','a']);
page.fieldView.filters={'source:metric':['0.0000']};
assert.deepEqual(Array.from(h.fieldTableDisplayRows(),row=>row.company.company_id),['b']);
const before=JSON.stringify({samples:page.samples,values:page.fieldMatrix.rows,overrides:page.overrides});
h.clearFieldTableView();assert.equal(h.fieldTableDisplayRows().length,3);
context.setDraft('source:metric',['1.2346','0.0000',''],false);h.applyFieldFilter();assert.equal(Object.keys(page.fieldView.filters).length,0);
context.setDraft('source:metric',['1.2346','0.0000','']);controls.fieldFilterSearch.value='0.0000';h.applyFieldFilter();
assert.deepEqual(Array.from(page.fieldView.filters['source:metric']),['0.0000']);
assert.equal(h.fieldTableDisplayRows().length,1);
controls.fieldFilterSearch.value='';context.setDraft('source:metric',[]);h.applyFieldFilter();assert.equal(h.fieldTableDisplayRows().length,0);
context.setDraft('source:metric',['1.2346','0.0000','']);h.applyFieldFilter();assert.equal(Object.keys(page.fieldView.filters).length,0);
context.setDraft('source:metric',[]);h.chooseFieldFilterValues('duplicates');h.applyFieldFilter();assert.deepEqual(Array.from(page.fieldView.filters['source:metric']),['1.2346']);
context.setDraft('source:metric',[]);h.chooseFieldFilterValues('unique');h.applyFieldFilter();assert.deepEqual(Array.from(page.fieldView.filters['source:metric']),['0.0000','']);
context.setDraft('source:metric',['0.0000']);h.chooseFieldFilterValues('invert');h.applyFieldFilter();assert.deepEqual(Array.from(page.fieldView.filters['source:metric']),['1.2346','']);
context.setDraft('source:metric',['0.0000']);controls.yearSelect.value='2024';h.applyFieldFilter();assert.deepEqual(Array.from(page.fieldView.filters['source:metric']),['1.2346','']);
controls.yearSelect.value='2025';context.setDraft('source:metric',[]);h.sortFieldTable('desc');assert.equal(page.fieldView.sort.direction,'desc');
h.clearFieldTableView();assert.equal(page.fieldView.sort,null);
assert.equal(JSON.stringify({samples:page.samples,values:page.fieldMatrix.rows,overrides:page.overrides}),before);
assert.ok(fs.readFileSync('static/index.html','utf8').includes('/column-filters.js'));
console.log('Column filters passed: exact numeric sorting, stable rows, blank/zero/code distinctions, multi-column facets, counts/search, checkbox commands, calculated columns and display-only state.');
