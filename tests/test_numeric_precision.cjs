const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const GradeRules=require('../static/grade-rules.js');
const assign={value:'1.23451',dataset:{companyId:'co',indicatorId:'A',weight:'1'}};
const weighted={value:'',dataset:assign.dataset};
const checkInput={value:'',dataset:{companyId:'co',fieldId:'check',period:'2025-12-31'}};
assign.closest=()=>({nextElementSibling:{querySelector:()=>weighted}});
weighted.closest=()=>({previousElementSibling:{querySelector:()=>assign}});
const controls={yearSelect:{value:'2025'},reportSelect:{value:'12-31'}};
const context={AbortController,GradeRules,document:{getElementById:id=>controls[id],
 querySelectorAll:selector=>selector==='.assign-input'?[assign]:selector==='.weighted-input'?[weighted]:selector==='#checkRows .check-edit-input'?[checkInput]:[]}};
const source=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'');
context.NumberFormat = require('../static/number-format.js');
vm.runInNewContext(source+`
  updateTotals=()=>{};
  state.samples=[{company_id:'co'}];
  state.results.co={period_end:'2025-12-31',details:[{indicator_id:'A',field_id:'metric',score:1.23451,weight:1,field_type:'打分项'}]};
  state.model={grades:[{status:'打分映射',inclusive:1,grade:'Low',threshold:0},{status:'打分映射',inclusive:1,grade:'High',threshold:1.23455}]};
  this.page=state; this.h={fmt,fieldDisplay,decimalProduct,baseScore,baseScoreText,finalScoreText,gradeForScore,bindInitialInputs,normalizeCheckInputs};
`,context);
const h=context.h,page=context.page;
for(const [value,expected] of [[1,'1.0000'],[0,'0.0000'],['-0','0.0000'],['1.23451','1.2346'],
 ['-1.23451','-1.2346'],['1.23450','1.2345'],['0.0000001','0.0001'],['-0.00001','-0.0001'],
 ['1,234.56789','1234.5679'],['1.23451e2','123.4510'],['AA+','AA+'],['2025-12-31','2025-12-31']]) assert.equal(h.fmt(value),expected);
assert.equal(h.fieldDisplay('00123',{value_type:'文本'}),'00123');
assert.equal(h.fieldDisplay('2025',{field_id:'report_year'}),'2025');
assert.equal(h.fieldDisplay('1.23451',{field_id:'revenue'}),'1.2346');
assert.equal(h.baseScore('co'),1.23451);
assert.equal(h.baseScoreText('co'),'1.2346');
assert.equal(h.gradeForScore(h.baseScore('co')),'Low'); // Display rounding cannot raise the grade.
h.bindInitialInputs(); assign.oninput();
assert.equal(assign.value,'1.23451'); // Typing must not replace the input after every key.
assert.equal(weighted.value,'1.2346');
assign.onchange();
assert.equal(assign.value,'1.2346');
assert.equal(page.indicatorScores.co.A.score,1.23451);
assert.equal(h.baseScore('co'),1.23451);
assert.equal(h.gradeForScore(h.baseScore('co')),'Low');
page.indicatorScores={};
page.results.co.details=[{indicator_id:'A',score:0.1,weight:0.2,field_type:'打分项'},{indicator_id:'B',score:0.1,weight:0.1,field_type:'打分项'}];
assert.equal(h.baseScore('co'),0.1*0.2+0.1*0.1);
assert.equal(h.baseScoreText('co'),'0.0300'); // No binary-floating-point extra increment.
assert.equal(h.finalScoreText('co'),'0.0300');
page.results.co.check_fields=[{field_id:'check',value:'',default_value:'1.23451'}];
page.checkValues.co={'2025-12-31':{check:''}};
h.normalizeCheckInputs('co');
assert.equal(checkInput.value,'');
assert.equal(page.checkValues.co['2025-12-31'].check,'');
console.log('Four-decimal ROUND_UP passed: signs, zeros, scientific notation, identifiers, decimal products, editable inputs and unchanged live grades/calculations.');
