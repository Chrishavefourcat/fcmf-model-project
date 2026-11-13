const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const GradeRules = require('../static/grade-rules.js');
const hidden = new Set(['hidden']);
const warning = {textContent:'',classList:{
  toggle(name,on){if(on)hidden.add(name);else hidden.delete(name);},
}};
const controls = {
  yearSelect:{value:'2025'}, reportSelect:{value:'12-31'},
  indicatorCalculationWarning:warning,
  toggleIndicatorsBtn:{disabled:false,textContent:'',setAttribute(){}},
  fieldHead:{innerHTML:''}, fieldRows:{innerHTML:'',appendChild(){}},
};
const context = {AbortController,GradeRules,document:{
  getElementById:id=>controls[id], querySelectorAll:()=>[], createElement:()=>({innerHTML:''}),
}};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source+`
  state.samples=[{company_id:'a'},{company_id:'b'}];
  state.fieldMatrix={columns:[{kind:'indicator',indicator_id:'A',label:'指标A'}],rows:[]};
  this.page=state; this.render=renderFieldTable;
`,context);
const page=context.page;
const result=details=>({period_end:'2025-12-31',details});
page.results.a=result([
  {indicator_id:'A',label:'资产负债率',score:null},
  {indicator_id:'B',label:'指标B',score:0},
  {indicator_id:'C',label:'指标C',score:'0'},
  {indicator_id:'D',label:'指标D',score:12.3456},
]);
page.results.b=result([{indicator_id:'A',label:'资产负债率',score:null}]);
page.results.unselected=result([{indicator_id:'ignored',label:'未选样本指标',score:null}]);
context.render();
assert.equal(warning.textContent,'(指标：资产负债率 公式无法计算)');
assert.equal(hidden.has('hidden'),false);
assert.equal(controls.toggleIndicatorsBtn.textContent,'展示指标');

// The warning stays beside the button with indicator columns shown or hidden.
page.showIndicators=true;
context.render();
assert.equal(controls.toggleIndicatorsBtn.textContent,'隐藏指标');
assert.equal(warning.textContent,'(指标：资产负债率 公式无法计算)');
page.showIndicators=false;
context.render();
assert.equal(hidden.has('hidden'),false);

// Recovering one company must not hide the same indicator's error in another.
page.results.a.details[0].score=0;
context.render();
assert.equal(warning.textContent,'(指标：资产负债率 公式无法计算)');
page.samples=[{company_id:'a'}];
context.render();
assert.equal(warning.textContent,'');
assert.equal(hidden.has('hidden'),true);

// Empty, nonnumeric and nonfinite results are failures; names fall back to IDs.
page.results.a=result([
  {indicator_id:'missing',label:'缺少数据',score:undefined},
  {indicator_id:'blank',label:'空白指标',score:' '},
  {indicator_id:'text',label:'文本结果',score:'not numeric'},
  {indicator_id:'infinite',score:Infinity},
  {indicator_id:'nan',score:NaN},
]);
context.render();
assert.equal(warning.textContent,'(指标：缺少数据、空白指标、文本结果、infinite、nan 公式无法计算)');

// A previous period/model must never leave a warning in the current context.
controls.yearSelect.value='2024';
context.render();
assert.equal(warning.textContent,'');
assert.equal(hidden.has('hidden'),true);
page.results.a={period_end:'2024-12-31',details:[{indicator_id:'A',label:'当前日期指标',score:null}]};
context.render();
assert.equal(warning.textContent,'(指标：当前日期指标 公式无法计算)');
page.results.a.details[0].score=8;
context.render();
assert.equal(warning.textContent,'');
page.results={};
context.render();
assert.equal(hidden.has('hidden'),true);
page.samples=[];
context.render();
assert.equal(warning.textContent,'');
console.log('Indicator warnings passed: toolbar placement, hidden columns, duplicate companies, selected scope/date, zero values, invalid values and automatic recovery.');
