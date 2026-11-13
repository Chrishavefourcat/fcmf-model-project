const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const controls = new Proxy({}, {get(target, id) {
  assert.notEqual(id, 'indicatorCalculationWarning', 'The removed warning must never be accessed.');
  return target[id] ??= {textContent:'', innerHTML:'', value:'', disabled:false,
    classList:{toggle(){}}, setAttribute(){}, children:[], appendChild(row){this.children.push(row);}};
}});
controls.yearSelect.value = '2025';
controls.reportSelect.value = '12-31';
const context = {AbortController, document:{getElementById:id=>controls[id],
  querySelectorAll:()=>[], createElement:()=>({innerHTML:'',dataset:{}})}};
context.NumberFormat = require('../static/number-format.js');
const source = fs.readFileSync('static/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '');
vm.runInNewContext(source + `
  state.samples=[{company_id:'a',company_name:'测试主体'}];
  state.fieldMatrix={
    fields:[{field_id:'adj_debt_to_asset_ratio',label:'调整后资产负债率',value_type:'number'}],
    field_labels:{adj_debt_to_asset_ratio:'调整后资产负债率',total_assets:'总资产',risky_field:'<总资产 & "权益">'},
    columns:[
      {kind:'source',field_id:'adj_debt_to_asset_ratio',label:'调整后资产负债率',value_type:'number'},
      {kind:'indicator',indicator_id:'A',label:'指标A',expression:'safe_divide(adj_debt_to_asset_ratio, total_assets(Y-1)) + adj_debt_to_asset_ratio_extra'},
      {kind:'indicator',indicator_id:'B',label:'指标B',field_id:'adj_debt_to_asset_ratio',expression:''},
      {kind:'indicator',indicator_id:'C',label:'指标C',expression:'risky_field + adj_debt_to_asset_ratio'},
    ],
    rows:[{company:{company_id:'a',company_name:'测试主体'},values:{adj_debt_to_asset_ratio:'0.5'},indicator_values:{A:null,B:0,C:2}}],
  };
  state.results.a={period_end:'2025-12-31',details:[{indicator_id:'A',label:'资产负债率',score:null}]};
  this.page=state; this.render=renderFieldTable; this.format=formulaDisplayText;
`, context);
const page = context.page;
const before = JSON.stringify({matrix:page.fieldMatrix,results:page.results});
const html = fs.readFileSync('static/index.html', 'utf8');
assert(!html.includes('indicatorCalculationWarning'));
assert(!html.includes('indicator-calculation-warning'));

context.render();
const headerText = controls.fieldHead.innerHTML.replace(/<[^>]*>/g, '');
assert(headerText.includes('调整后资产负债率'));
assert(!headerText.includes('adj_debt_to_asset_ratio'));
assert(controls.fieldHead.innerHTML.includes('data-field-id="adj_debt_to_asset_ratio"'));
assert.equal(controls.toggleIndicatorsBtn.textContent, '展示指标');
assert(!controls.fieldHead.innerHTML.includes('data-column-kind="indicator"'));

page.showIndicators = true;
controls.fieldRows.children = [];
context.render();
assert.equal(controls.toggleIndicatorsBtn.textContent, '隐藏指标');
const decode = text=>text.replace(/&#10;/g,'\n').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const tooltip = (html,id)=>decode(html.match(new RegExp(`data-indicator-id="${id}" title="([^"]*)"`))[1]);
const expected = 'safe_divide(调整后资产负债率, 总资产(Y-1)) + adj_debt_to_asset_ratio_extra';
assert.equal(tooltip(controls.fieldHead.innerHTML,'A'), '指标A\n' + expected);
assert.equal(tooltip(controls.fieldRows.children[0].innerHTML,'A'), expected);
assert.equal(tooltip(controls.fieldHead.innerHTML,'B'), '指标B\n调整后资产负债率');
assert.equal(tooltip(controls.fieldHead.innerHTML,'C'), '指标C\n<总资产 & "权益"> + 调整后资产负债率');
assert(!controls.fieldHead.innerHTML.includes('<总资产'));
assert(controls.fieldRows.children[0].innerHTML.includes('data-field-id="adj_debt_to_asset_ratio"'));

const labels = new Map([['metric','中文指标'],['metric2','另一个指标'],['e6','不得替换科学记数'],['literal','常量字段']]);
assert.equal(context.format('metric + metric2 + metric_extra',labels), '中文指标 + 另一个指标 + metric_extra');
assert.equal(context.format('case(metric="literal", metric2, else, 1e6)',labels), 'case(中文指标="literal", 另一个指标, else, 1e6)');
assert.equal(context.format("metric + 'metric' + \"escaped \\\"metric\\\"\"",labels), "中文指标 + 'metric' + \"escaped \\\"metric\\\"\"");
assert.equal(context.format('constructor + unknown',labels), 'constructor + unknown');
assert.equal(JSON.stringify({matrix:page.fieldMatrix,results:page.results}), before);
page.showIndicators = false;
context.render();
assert.equal(controls.toggleIndicatorsBtn.textContent, '展示指标');
console.log('Indicator display passed: no warning, hidden field IDs, Chinese formula tooltips, complete tokens, constants, HTML escaping and unchanged source formulas.');
