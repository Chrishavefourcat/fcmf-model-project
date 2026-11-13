const state = {
  models: [],
  database: "",
  model: null,
  sourceId: "",
  sourceDirectory: "",
  companies: [],
  samples: [],
  checkedSamples: new Set(),
  results: {},
  fieldMatrix: { fields: [], rows: [] },
  fieldView: { filters: {}, sort: null },
  initialView: { filters: {}, sort: null },
  checkView: { filters: {}, sort: null },
  finalView: { filters: {}, sort: null },
  showIndicators: false,
  ruleOverrides: {},
  gradeRules: null,
  overrides: {},
  importedIndicatorValues: {},
  indicatorScores: {},
  checkValues: {},
  checkScores: {},
  checkNotes: {},
  modalCompanyId: "",
  checkModalCompanyId: "",
  step: 0,
  unlockedStep: 0,
};

const $ = (id) => document.getElementById(id);
const { decimalProduct, fmt, fieldDisplay, sumRoundUp4 } = NumberFormat;
let modelController = new AbortController();
let searchTimer = null;
let checkScoreTimer = null;
let checkPreviewVersion = 0;
let checkTransfer = null;
const checkEditJobs = new Map();
let bulkSelection = null;
let ruleDraft = null;
let gradeRuleDraft = null;
let gradeReadJob = null;
let gradeOpenVersion = 0;
let ruleRevision = 0;
let modelListVersion = 0;
let dataSourceBusy = false;
let fieldColumnDraft = null;
let ratingColumnDraft = null;
let fieldFilterDraft = null;

function cancelBulkSelection() {
  bulkSelection = null;
  $("sampleSelectionStatus").textContent = "";
  updateStepNavigation();
}

function indicatorRawValue(indicator, companyId = "") {
  const values = state.overrides[companyId] || {};
  return Object.prototype.hasOwnProperty.call(values, indicator.field_id) ? values[indicator.field_id]
    : Object.prototype.hasOwnProperty.call(indicator, "input_value") ? indicator.input_value : indicator.raw_value;
}

function indicatorRawDisplay(indicator, companyId = "") {
  const field = (state.fieldMatrix.fields || []).find((item) => item.field_id === indicator.field_id) || indicator;
  return fieldDisplay(indicatorRawValue(indicator, companyId), field);
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampScore(value, indicator) {
  let result = num(value);
  const min = indicator.score_min === null || indicator.score_min === undefined || indicator.score_min === "" ? null : num(indicator.score_min);
  const max = indicator.score_max === null || indicator.score_max === undefined || indicator.score_max === "" ? null : num(indicator.score_max);
  if (min !== null) result = Math.max(min, result);
  if (max !== null) result = Math.min(max, result);
  return result;
}

function gradeForScore(score) {
  if (score === null || score === undefined || score === "" || !Number.isFinite(Number(score))) return null;
  const rules = state.gradeRules || GradeRules.fromGrades(state.model?.grades || []);
  return GradeRules.gradeForScore(rules, Number(score));
}

function gradeMarkup(score) {
  const grade = gradeForScore(score);
  return grade === null ? '<span class="grade-error">等级匹配异常</span>' : esc(grade);
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function periodValue() {
  return `${$("yearSelect").value}-${$("reportSelect").value}`;
}

async function modelRequest(url, options = {}, format = "json") {
  if (!state.database) throw new Error("请先选择模型。");
  const endpoint = new URL(url, window.location.origin);
  endpoint.searchParams.set("database", state.database);
  const signal = modelController.signal;
  const res = await fetch(endpoint, { cache: "no-store", ...options, headers: { ...options.headers, "X-Data-Source": state.sourceId }, signal });
  let data;
  if (format === "download" && res.ok) {
    const disposition = res.headers.get("Content-Disposition") || "";
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plain = disposition.match(/filename="?([^";]+)"?/i);
    const filename = encoded ? decodeURIComponent(encoded[1]) : plain?.[1];
    if (!filename) throw new Error("导出文件名缺失，请重试。");
    data = { blob: await res.blob(), filename };
  } else data = await res.json();
  signal.throwIfAborted();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function api(url) {
  return modelRequest(url);
}

function postJson(url, payload) {
  if (["/api/score-preview", "/api/rules-preview"].includes(url)) payload = { ...payload, rules: payload.rules ?? state.ruleOverrides };
  return modelRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function postDownload(url, payload) {
  if (url === "/api/export-fields") payload = { ...payload, rules: state.ruleOverrides };
  return modelRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, "download");
}

function updateModelLabels() {
  const name = state.model?.model_name || "未选择";
  const selected = state.model || state.models.find((model) => model.database === state.database);
  $("currentModelName").textContent = name;
  $("finalModelName").textContent = name;
  $("currentDatabase").textContent = selected?.file_name || state.database || "未选择";
  $("currentDatabase").title = selected?.database_path || "";
  syncSelectControls();
}

async function switchModel(database) {
  closeFieldFilterPopover();
  closeFieldColumnModal(true);
  closeRatingColumnModal(true);
  cancelCheckEdits();
  ruleRevision++;
  ruleDraft = null;
  gradeRuleDraft = null;
  gradeOpenVersion++;
  checkTransfer = null;
  cancelBulkSelection();
  modelController.abort();
  modelController = new AbortController();
  clearTimeout(searchTimer);
  clearTimeout(checkScoreTimer);
  Object.assign(state, {
    database, model: null, companies: [], samples: [], results: {},
    checkedSamples: new Set(),
    unlockedStep: 0,
    fieldMatrix: { fields: [], rows: [] }, fieldView: { filters: {}, sort: null }, overrides: {}, importedIndicatorValues: {}, indicatorScores: {},
    checkValues: {}, checkScores: {}, checkNotes: {}, showIndicators: false, ruleOverrides: {}, gradeRules: null, modalCompanyId: "", checkModalCompanyId: "",
  });
  resetTableViews();
  $("modelSelect").value = database;
  $("searchInput").value = "";
  $("sampleFilter").value = "";
  $("searchInput").disabled = true;
  updateStepNavigation();
  $("checkAll").checked = false;
  $("importFieldsInput").value = "";
  $("importChecksInput").value = "";
  $("checkTransferStatus").textContent = "";
  $("companySuggest").classList.add("hidden");
  $("fieldModal").classList.add("hidden");
  $("checkModal").classList.add("hidden");
  $("rulesModal").classList.add("hidden");
  $("gradeRulesModal").classList.add("hidden");
  renderSamples();
  renderFieldTable();
  renderInitialMatrix();
  renderCheckMatrix();
  setStep(0);
  updateModelLabels();
  $("modelStatus").textContent = database ? "正在加载模型数据…" : "请选择模型。";
  if (!database) return;
  try {
    state.model = await api("/api/model");
    const year = state.model.base_year;
    $("yearSelect").replaceChildren(...Array.from({ length: 4 }, (_, i) => new Option(year - i, year - i)));
    $("reportSelect").value = "12-31";
    updateModelLabels();
    $("searchInput").disabled = false;
    updateStepNavigation();
    $("modelStatus").textContent = "切换模型将清空当前样本及页面录入数据。";
  } catch (error) {
    if (error.name === "AbortError") return;
    state.database = "";
    state.model = null;
    $("modelSelect").value = "";
    updateModelLabels();
    $("modelStatus").textContent = `模型加载失败：${error.message}`;
  }
}

async function loadModels() {
  const version = ++modelListVersion;
  try {
    const res = await fetch("/api/models", { cache: "no-store" });
    const data = await res.json();
    if (version !== modelListVersion) return;
    if (!res.ok) throw new Error(data.error || "模型列表加载失败");
    await applyDataSource(data);
  } catch (error) {
    if (version !== modelListVersion) return;
    $("modelSelect").replaceChildren(new Option("模型列表加载失败", ""));
    $("modelSelect").disabled = true;
    $("modelStatus").textContent = error.message;
  }
}

async function applyDataSource(data) {
  state.sourceId = data.source_id;
  state.sourceDirectory = data.directory;
  state.models = data.models;
  $("dataSourcePath").textContent = data.directory ? `数据源：${data.directory}` : "未选择数据源";
  $("dataSourcePath").title = data.directory || "";
  const select = $("modelSelect");
  select.replaceChildren(new Option(!data.directory ? "请先选择数据源" : state.models.length ? "请选择模型" : "暂无可用模型", ""));
  state.models.forEach((model) => {
    const fileName = model.file_name || `${model.database}.db`;
    const option = new Option(fileName, model.database);
    option.title = model.database_path || fileName;
    select.add(option);
  });
  select.disabled = !state.models.length;
  const initial = state.models.find((model) => model.database === data.default_database) || state.models[0];
  await switchModel(initial?.database || "");
  if (!initial) $("modelStatus").textContent = data.directory
    ? (data.source_kind === "file" ? "所选 DB 文件中没有可用模型，请选择 SQLite 模型数据库。" : "文件夹中没有可用模型，请放入 .db 格式的 SQLite 模型数据库。")
    : "请点击“数据源选择”，选择本机文件夹或单个 .db 模型文件。";
}

function setDataSourceBrowseMenu(open) {
  $("dataSourceBrowseOptions").hidden = !open;
  $("dataSourceBrowse").setAttribute("aria-expanded", String(open));
}

function setDataSourceBusy(busy) {
  dataSourceBusy = busy;
  setDataSourceBrowseMenu(false);
  for (const id of ["selectDataSourceBtn", "dataSourceSubmit", "dataSourceDirectory", "dataSourceCancel",
    "dataSourceBrowse", "dataSourceBrowseDirectory", "dataSourceBrowseFile"]) $(id).disabled = busy;
}

function selectDataSource() {
  if (dataSourceBusy) return;
  setDataSourceBrowseMenu(false);
  $("dataSourceDirectory").value = state.sourceDirectory || "";
  $("dataSourceStatus").textContent = "";
  $("dataSourceModal").showModal();
  $("dataSourceDirectory").focus();
}

async function browseDataSource(kind) {
  if (dataSourceBusy || !["directory", "file"].includes(kind)) return;
  const input = $("dataSourceDirectory");
  const initialPath = input.value.trim();
  setDataSourceBusy(true);
  $("dataSourceStatus").textContent = kind === "directory" ? "请在系统窗口中选择文件夹…" : "请在系统窗口中选择 DB 文件…";
  try {
    const res = await fetch("/api/data-source/browse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, initial_path: initialPath }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "无法打开选择窗口");
    if (data.cancelled) {
      $("dataSourceStatus").textContent = "";
    } else {
      if (typeof data.path !== "string" || !data.path.trim()) throw new Error("未获得有效的数据源路径");
      input.value = data.path;
      $("dataSourceStatus").textContent = "已选择路径，点击“使用此数据源”确认加载。";
    }
  } catch (error) {
    $("dataSourceStatus").textContent = `浏览数据源失败：${error.message}`;
  } finally {
    setDataSourceBusy(false);
    input.focus();
  }
}

async function submitDataSource(event) {
  event?.preventDefault();
  if (dataSourceBusy) return;
  const input = $("dataSourceDirectory");
  const directory = input.value.trim();
  if (!directory) {
    $("dataSourceStatus").textContent = "请选择或填写文件夹或 DB 文件的完整路径。";
    input.focus();
    return;
  }
  setDataSourceBusy(true);
  $("dataSourceStatus").textContent = "正在读取数据源…";
  try {
    const res = await fetch("/api/data-source/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "数据源加载失败");
    if (!data.cancelled) {
      modelListVersion++;
      await applyDataSource(data);
    }
    $("dataSourceModal").close();
  } catch (error) {
    $("dataSourceStatus").textContent = `数据源选择失败：${error.message}`;
  } finally {
    setDataSourceBusy(false);
  }
}

function updateStepNavigation() {
  $("scoringRulesBtn").disabled = !state.model || !state.samples.length || !!bulkSelection || !!checkTransfer;
  $("gradeRulesBtn").disabled = $("scoringRulesBtn").disabled;
  document.querySelectorAll(".step").forEach((button) => {
    const index = Number(button.dataset.step);
    button.disabled = index > state.unlockedStep || (index > state.step && checkEditJobs.size > 0) || (index === 4 && !checksReady()) || (index > 0 && !!bulkSelection)
      || (checkTransfer?.kind === "reset" && index !== state.step)
      || (index > state.step && checkTransfer?.kind === "import");
    button.classList.toggle("active", index === state.step);
    button.classList.toggle("completed", index < state.step);
    if (index === state.step) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
    button.title = index > state.unlockedStep ? "请先点击“下一步”按顺序进入此步骤" : "";
  });
  $("prevBtn").disabled = state.step === 0 || checkTransfer?.kind === "reset";
  $("nextBtn").disabled = !state.model || !!bulkSelection || checkEditJobs.size > 0 || (state.step === 3 && !checksReady()) || state.step === 4 || ["import", "reset"].includes(checkTransfer?.kind);
}

function ensureCurrentStepVisible() {
  const steps = $("workflowSteps");
  if (!steps || steps.scrollWidth <= steps.clientWidth) return;
  const current = steps.querySelector?.(".step.active");
  if (!current) return;
  const area = steps.getBoundingClientRect(), button = current.getBoundingClientRect();
  if (button.left < area.left || button.right > area.right) steps.scrollLeft += button.left - area.left - (steps.clientWidth - button.width) / 2;
}

function setStep(step, advance = false) {
  const target = Math.max(0, Math.min(4, step));
  if (checkTransfer?.kind === "reset" && target !== state.step) return;
  if (target > state.step && checkTransfer?.kind === "import") return;
  if (target > state.step && checkEditJobs.size > 0) return;
  if (target === 4 && !checksReady()) return;
  if (target > state.unlockedStep && (!advance || target !== state.step + 1)) return;
  if (target > 0 && bulkSelection) {
    alert("正在添加样本，请等待全选完成后继续。");
    return;
  }
  if (target > 0 && !state.samples.length) {
    alert("请先选择评级样本。");
    return;
  }
  state.step = target;
  closeFieldFilterPopover();
  closeRatingColumnModal(true);
  state.unlockedStep = Math.max(state.unlockedStep, target);
  updateStepNavigation();
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", Number(panel.dataset.panel) !== state.step);
  });
  ensureCurrentStepVisible();
  if (state.step === 1) refreshFieldMatrix();
  if (state.step === 2) refreshScores().then(renderInitialMatrix);
  if (state.step === 3) refreshScores().then(renderCheckMatrix);
  renderSummaryPanels();
}

async function loadCompanies(q = "") {
  if (!state.model) return;
  const query = q.trim();
  try {
    const companies = await api(`/api/companies?q=${encodeURIComponent(query)}`);
    if ($("searchInput").value.trim() !== query || document.activeElement !== $("searchInput")) return;
    state.companies = companies;
    renderCompanySuggest();
  } catch (error) {
    if (error.name === "AbortError") return;
    if ($("searchInput").value.trim() !== query || document.activeElement !== $("searchInput")) return;
    state.companies = [];
    renderCompanySuggest(`公司加载失败：${error.message}`);
  }
}

function renderCompanySuggest(message = "") {
  const box = $("companySuggest");
  box.style.maxHeight = `${Math.min(300, Math.max(120, window.innerHeight - $("searchInput").getBoundingClientRect().bottom - 12))}px`;
  box.innerHTML = "";
  if (message || !state.companies.length) {
    const notice = document.createElement("div");
    notice.className = "suggest-empty";
    notice.textContent = message || ($("searchInput").value.trim() ? "未找到匹配公司，请调整搜索关键词。" : "当前模型没有公司数据。");
    box.appendChild(notice);
    box.classList.remove("hidden");
    return;
  }
  const toolbar = document.createElement("div");
  toolbar.className = "suggest-toolbar";
  const selectAll = document.createElement("button");
  selectAll.type = "button";
  selectAll.className = "primary";
  selectAll.textContent = $("searchInput").value.trim() ? "全选搜索结果" : "全选当前模型";
  selectAll.disabled = !!bulkSelection;
  selectAll.onclick = selectAllSamples;
  const hint = document.createElement("span");
  hint.className = "muted";
  hint.textContent = "已选样本不会重复添加";
  toolbar.append(selectAll, hint);
  box.appendChild(toolbar);
  state.companies.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggest-item";
    btn.innerHTML = `<strong>${esc(item.company_name)}</strong><span>${esc(item.company_id)} · ${esc(item.bond_id || "无债券代码")}</span>`;
    btn.onclick = () => addSample(item.company_id);
    box.appendChild(btn);
  });
  box.classList.remove("hidden");
}

async function selectAllSamples() {
  if (!state.model || bulkSelection) return;
  const job = { controller: modelController, period: periodValue() };
  bulkSelection = job;
  updateStepNavigation();
  const current = () => bulkSelection === job && job.controller === modelController && job.period === periodValue();
  const query = $("searchInput").value.trim();
  const status = $("sampleSelectionStatus");
  $("companySuggest").classList.add("hidden");
  status.textContent = "正在读取全部匹配公司…";
  try {
    const companies = await api(`/api/companies?all=1&q=${encodeURIComponent(query)}`);
    if (!current()) return;
    const pending = companies.filter((company) => !state.samples.some((sample) => sample.company_id === company.company_id));
    let cursor = 0, completed = 0, added = 0, failed = 0;
    async function worker() {
      while (current() && cursor < pending.length) {
        const company = pending[cursor++];
        try {
          await fetchScore(company.company_id);
          if (!current()) return;
          if (!state.samples.some((sample) => sample.company_id === company.company_id)) {
            state.samples.push(company);
            added++;
          }
        } catch (error) {
          if (!current() || error.name === "AbortError") return;
          failed++;
        }
        completed++;
        status.textContent = `正在添加样本：${completed}/${pending.length}`;
        if (completed % 10 === 0) renderSamples();
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
    if (!current()) return;
    renderSamples();
    renderSummaryPanels();
    status.textContent = `匹配 ${companies.length} 家公司，本次添加 ${added} 个样本${failed ? `，${failed} 个评分失败，可单独重试` : ""}。`;
  } catch (error) {
    if (current() && error.name !== "AbortError") status.textContent = `全选失败：${error.message}`;
  } finally {
    if (bulkSelection === job) {
      bulkSelection = null;
      updateStepNavigation();
      if (!$("companySuggest").classList.contains("hidden")) renderCompanySuggest();
    }
  }
}

async function addSample(companyId) {
  try {
    const company = state.companies.find((c) => c.company_id === companyId) || (await api(`/api/companies?q=${encodeURIComponent(companyId)}`))[0];
    if (!company) return;
    await fetchScore(company.company_id);
    if (!state.samples.some((x) => x.company_id === company.company_id)) {
      state.samples.push(company);
    }
    $("searchInput").value = "";
    $("companySuggest").classList.add("hidden");
    renderSamples();
    renderSummaryPanels();
  } catch (error) {
    if (error.name === "AbortError") return;
    renderCompanySuggest(`公司选择失败：${error.message}`);
  }
}

async function fetchScore(companyId) {
  const controller = modelController;
  const revision = ruleRevision;
  const period = periodValue();
  const edits = state.checkValues[companyId]?.[period];
  const sourceValues = state.overrides[companyId];
  const overrides = checkOverridesFromValues(companyId);
  const data = Object.keys(overrides).length || Object.keys(state.ruleOverrides).length
    ? await postJson("/api/score-preview", { company_id: companyId, period, overrides })
    : await api(`/api/score?company_id=${encodeURIComponent(companyId)}&period=${encodeURIComponent(period)}`);
  if (controller !== modelController || period !== periodValue() || revision !== ruleRevision || edits !== state.checkValues[companyId]?.[period] || sourceValues !== state.overrides[companyId]) throw new DOMException("评分上下文已变更", "AbortError");
  state.results[companyId] = data;
  return data;
}

async function refreshScores() {
  await refreshDatabaseGrades();
  await Promise.all(state.samples.map((x) => fetchScore(x.company_id)));
  renderSamples();
  if (state.step === 1) renderFieldTable();
  renderSummaryPanels();
}

async function refreshFieldMatrix() {
  if (!state.samples.length) {
    state.fieldMatrix = { fields: [], columns: [], rows: [] };
    renderFieldTable();
    return;
  }
  const ids = state.samples.map((x) => x.company_id).join(",");
  const period = periodValue();
  const controller = modelController;
  const revision = ruleRevision;
  const matrix = Object.keys(state.ruleOverrides).length
    ? (await postJson("/api/rules-preview", { company_ids: selectedCompanyIds(), period, overrides: pageSourceOverrides() })).field_matrix
    : await api(`/api/field-matrix?company_ids=${encodeURIComponent(ids)}&period=${encodeURIComponent(period)}`);
  if (controller !== modelController || period !== periodValue() || revision !== ruleRevision) return;
  state.fieldMatrix = matrix;
  applyOverridesToFieldMatrix();
  renderFieldTable();
}

function selectedCompanyIds() {
  return state.samples.map((item) => item.company_id);
}

function applyOverridesToFieldMatrix() {
  (state.fieldMatrix.rows || []).forEach((row) => {
    const overrides = checkOverridesFromValues(row.company.company_id);
    Object.keys(overrides).forEach((fieldId) => {
      row.values[fieldId] = overrides[fieldId];
    });
  });
}

function visibleSamples() {
  const query = $("sampleFilter").value.trim().toLowerCase();
  return state.samples.filter((item) => !query || [item.company_name, item.company_id, item.bond_id]
    .some((value) => String(value || "").toLowerCase().includes(query)));
}

function updateSampleChecks() {
  const checks = [...$("sampleRows").querySelectorAll(".sample-check")];
  const count = checks.filter((item) => item.checked).length;
  $("checkAll").checked = checks.length > 0 && count === checks.length;
  $("checkAll").indeterminate = count > 0 && count < checks.length;
  $("checkAll").disabled = !checks.length;
  $("deleteSelectedBtn").disabled = !count;
}

function removeSamples(ids) {
  cancelBulkSelection();
  const removed = new Set(ids);
  state.samples = state.samples.filter((sample) => !removed.has(sample.company_id));
  if (!state.samples.length) resetTableViews();
  removed.forEach((id) => {
    const edit = checkEditJobs.get(id);
    if (edit) clearTimeout(edit.timer);
    checkEditJobs.delete(id);
    state.checkedSamples.delete(id);
    [state.results, state.overrides, state.importedIndicatorValues, state.indicatorScores, state.checkValues, state.checkScores, state.checkNotes].forEach((values) => delete values[id]);
  });
  state.fieldMatrix.rows = state.fieldMatrix.rows.filter((row) => !removed.has(row.company.company_id));
  renderSamples();
  renderFieldTable();
  renderInitialMatrix();
  renderCheckMatrix();
  renderSummaryPanels();
  updateStepNavigation();
  if (!state.samples.length) {
    state.unlockedStep = 0;
    setStep(0);
  }
}

function renderSamples() {
  const tbody = $("sampleRows");
  const visible = visibleSamples();
  const visibleIds = new Set(visible.map((sample) => sample.company_id));
  state.checkedSamples.forEach((id) => { if (!visibleIds.has(id)) state.checkedSamples.delete(id); });
  tbody.innerHTML = "";
  visible.forEach((item, index) => {
    const result = state.results[item.company_id];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td><input type="checkbox" class="sample-check" data-id="${esc(item.company_id)}" aria-label="选择${esc(item.company_name)}" ${state.checkedSamples.has(item.company_id) ? "checked" : ""}></td>
      <td><button class="link-btn" data-id="${esc(item.company_id)}">${esc(item.company_name)}</button></td>
      <td>${esc(result?.original_grade ?? "")}</td>
      <td><button type="button" class="tiny danger remove-sample" data-id="${esc(item.company_id)}" aria-label="删除${esc(item.company_name)}">删除</button></td>
    `;
    tbody.appendChild(tr);
  });
  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">${state.samples.length ? "未找到匹配的已选样本，请调整搜索关键词" : "请在左侧选择公司或全选加入样本"}</td></tr>`;
  }
  $("sampleCount").textContent = `共 ${state.samples.length} 个样本，显示 ${visible.length} 个`;
  updateSampleChecks();
}

function renderIndicatorCalculationWarning() {
  const failed = new Map();
  const period = periodValue();
  state.samples.forEach((company) => {
    const result = state.results[company.company_id];
    if (!result || result.period_end !== period) return;
    (result.details || []).forEach((indicator) => {
      const value = indicator.score;
      if ((typeof value === "number" || typeof value === "string") && String(value).trim() !== "" && Number.isFinite(Number(value))) return;
      const name = indicator.label || indicator.indicator_id || "未命名指标";
      failed.set(indicator.indicator_id || name, name);
    });
  });
  const warning = $("indicatorCalculationWarning");
  warning.textContent = failed.size ? `(指标：${[...failed.values()].join("、")} 公式无法计算)` : "";
  warning.title = warning.textContent;
  warning.classList.toggle("hidden", failed.size === 0);
}

function fieldTableColumns() {
  return state.fieldMatrix.columns || (state.fieldMatrix.fields || []).map((field) => ({ ...field, kind: "source" }));
}

function fieldColumnKey(column) {
  return column.kind === "company" ? "company:company_name" : `${column.kind}:${column.kind === "indicator" ? column.indicator_id : column.field_id}`;
}

function fieldTableBaseRows() {
  const selected = new Set(selectedCompanyIds());
  return (state.fieldMatrix.rows || []).filter((row) => selected.has(row.company.company_id));
}

function fieldTableReader(columns = fieldTableColumns()) {
  const definitions = new Map(columns.map((column) => [fieldColumnKey(column), column]));
  const details = new Map();
  return (row, key) => {
    if (key === "company:company_name") return { value: row.company.company_name, label: row.company.company_name || "", numeric: false };
    const column = definitions.get(key);
    if (!column) return { value: "", label: "", numeric: false };
    if (column.kind !== "indicator") {
      const value = row.values[column.field_id];
      return { value, label: fieldDisplay(value, column), numeric: NumberFormat.numericField(column) };
    }
    const id = row.company.company_id;
    if (!details.has(id)) details.set(id, new Map((state.results[id]?.details || []).map((item) => [item.indicator_id, item])));
    const indicator = details.get(id).get(column.indicator_id);
    const value = indicator ? effectiveIndicatorValue(id, indicator) : row.indicator_values?.[column.indicator_id];
    return { value, label: fmt(value), numeric: true };
  };
}

function fieldTableDisplayRows(read = fieldTableReader()) {
  const rows = fieldTableBaseRows(), view = state.fieldView;
  return !view.sort && !Object.keys(view.filters).length ? rows : ColumnFilters.apply(rows, view.filters, view.sort, read);
}

function tableViewState(table = "field") {
  return state[`${table}View`];
}

function resetTableViews() {
  ["field", "initial", "check", "final"].forEach((table) => { state[`${table}View`] = { filters: {}, sort: null }; });
}

function filterCell(value, numeric = false, label = numeric ? fmt(value) : String(value ?? "")) {
  return { value, label, numeric };
}

function tableColumnReader(columns) {
  const definitions = new Map(columns.map((column) => [column.key, column]));
  return (row, key) => definitions.get(key)?.read(row) || filterCell("");
}

function initialTableData() {
  const indicators = state.samples.length ? nonCheckDetails(state.results[state.samples[0].company_id]) : [];
  const rows = resultRows().map((row) => ({ ...row,
    indicators: new Map(nonCheckDetails(row.result).map((indicator) => [indicator.indicator_id, indicator])),
  }));
  const columns = [
    { key: "company:company_name", label: "主体名称", read: (row) => filterCell(row.company.company_name) },
    { key: "summary:base_score", label: "初评得分", read: (row) => filterCell(row.result ? baseScoreText(row.company.company_id) : "待计算", true) },
    { key: "summary:base_grade", label: "初评等级", read: (row) => filterCell(row.result ? gradeForScore(baseScore(row.company.company_id)) || "等级匹配异常" : "待计算") },
    ...indicators.flatMap((indicator) => ["value", "score", "weighted"].map((kind, index) => ({
      key: `indicator-${kind}:${indicator.indicator_id}`, label: `${indicator.label} · ${["指标值", "赋分", "得分"][index]}`,
      read: (row) => {
        const current = row.indicators.get(indicator.indicator_id), id = row.company.company_id;
        if (!current) return filterCell("");
        if (kind === "value") {
          const field = (state.fieldMatrix.fields || []).find((item) => item.field_id === current.field_id) || current;
          return filterCell(indicatorRawValue(current, id), NumberFormat.numericField(field), indicatorRawDisplay(current, id));
        }
        return filterCell(kind === "score" ? indicatorScore(id, current).score : indicatorWeightedExact(id, current), true);
      },
    }))),
  ];
  return { indicators, columns, rows, read: tableColumnReader(columns) };
}

function checkTableData() {
  const page = checkPageData();
  const definitions = new Map((state.samples.length ? checkFields(state.samples[0].company_id) : []).map((field) => [field.field_id, field]));
  const fields = page.fields.map((field) => ({ ...definitions.get(field.field_id), ...field }));
  const columns = [
    { key: "company:company_name", label: "主体名称", read: (row) => filterCell(row.company_name) },
    ...fields.flatMap((field) => ["value", "score"].map((kind) => ({
      key: `check-${kind}:${field.field_id}`, label: `${field.label} · ${kind === "value" ? "指标值" : "得分"}`,
      read: (row) => {
        const value = row.checks[field.field_id]?.[kind];
        return kind === "score" ? filterCell(value, true)
          : filterCell(value, NumberFormat.numericField(field), fieldDisplay(value, field));
      },
    }))),
  ];
  return { fields, rows: page.rows.map((row, index) => ({ ...row, index })), columns, read: tableColumnReader(columns) };
}

function finalTableData() {
  const columns = [
    ["company_name", "主体名称"], ["bond_id", "债券代码"], ["base_score", "指标得分", true],
    ["check_score", "排查得分", true], ["final_score", "最终得分", true], ["base_grade", "初评等级"],
    ["final_grade", "最终等级"], ["manual", "人工标识"], ["conclusion", "评级说明"],
  ].map(([key, label, numeric = false]) => ({
    key: key === "company_name" ? "company:company_name" : `summary:${key}`, label,
    read: (row) => filterCell(row[key], numeric, String(row[key] ?? "")),
  }));
  return { columns, rows: finalSummaryRows(), read: tableColumnReader(columns) };
}

function tableFilterContext(table = "field") {
  if (table === "initial") return initialTableData();
  if (table === "check") return checkTableData();
  if (table === "final") return finalTableData();
  return { rows: fieldTableBaseRows(), read: fieldTableReader(), columns: [
    { key: "company:company_name", label: "主体名称" },
    ...fieldTableColumns().map((column) => ({ ...column, key: fieldColumnKey(column) })),
  ] };
}

function tableDisplayRows(table, data) {
  const view = tableViewState(table), keys = new Set(data.columns.map((column) => column.key));
  Object.keys(view.filters).forEach((key) => { if (!keys.has(key)) delete view.filters[key]; });
  if (view.sort && !keys.has(view.sort.key)) view.sort = null;
  return !view.sort && !Object.keys(view.filters).length ? data.rows : ColumnFilters.apply(data.rows, view.filters, view.sort, data.read);
}

function renderTableView(table = "field") {
  ({ field: renderFieldTable, initial: renderInitialMatrix, check: renderCheckMatrix, final: renderSummaryPanels })[table]();
}

function renderTableViewStatus(table, count, total) {
  const view = tableViewState(table), filterCount = Object.keys(view.filters).length;
  const status = $(`${table}ViewStatus`), clearButton = $(`clear${table[0].toUpperCase() + table.slice(1)}ViewBtn`);
  if (status) status.textContent = `显示 ${count} / ${total} 家公司${filterCount ? ` · 已筛选 ${filterCount} 列` : ""}${view.sort ? ` · ${view.sort.direction === "asc" ? "升序" : "降序"}` : ""}`;
  if (clearButton) clearButton.classList.toggle("hidden", !filterCount && !view.sort);
}

function closeTableFilterPopover(table) {
  if (fieldFilterDraft && (fieldFilterDraft.table || "field") === table) closeFieldFilterPopover();
}

function bindTableFilterButtons(table) {
  document.querySelectorAll?.(`.field-filter-trigger[data-filter-table="${table}"]`).forEach((button) => {
    button.onclick = (event) => { event.stopPropagation(); openFieldFilterPopover(button.dataset.filterKey, button, table); };
  });
}

function refreshRatingTableView(table) {
  const view = tableViewState(table);
  if (!view.sort && !Object.keys(view.filters).length) return;
  if (fieldFilterDraft?.table === table || $(`${table}Rows`)?.contains?.(document.activeElement)) return;
  renderTableView(table);
}

function fieldFilterButton(key, label, table = "field") {
  const view = tableViewState(table);
  const filtered = Object.prototype.hasOwnProperty.call(view.filters, key);
  const sort = view.sort?.key === key ? view.sort.direction : "";
  const icon = filtered ? '<path d="M2 3h12L9 9v4l-2 1V9z"/>' : '<path d="m4 6 4 4 4-4"/>';
  return `<button type="button" class="field-filter-trigger${filtered || sort ? " active" : ""}" data-filter-table="${table}" data-filter-key="${esc(key)}" aria-label="${esc(label)}的排序和筛选" aria-controls="fieldFilterPopover" aria-expanded="false" title="排序和筛选${filtered ? " · 已筛选" : ""}${sort ? sort === "asc" ? " · 升序" : " · 降序" : ""}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${icon}</svg>${sort ? `<span aria-hidden="true">${sort === "asc" ? "↑" : "↓"}</span>` : ""}</button>`;
}

function closeFieldFilterPopover(focus = false) {
  const draft = fieldFilterDraft;
  fieldFilterDraft = null;
  const popover = $("fieldFilterPopover");
  const open = popover?.matches?.(":popover-open");
  if (!draft && !open) return;
  if (open) popover.hidePopover();
  document.querySelectorAll?.(".field-filter-trigger").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
  if (focus && draft?.button?.isConnected !== false) draft?.button?.focus?.();
}

function positionFieldFilterPopover() {
  const draft = fieldFilterDraft;
  if (!draft) return;
  const popover = $("fieldFilterPopover"), rect = draft.button.getBoundingClientRect();
  const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight, gap = 6, margin = 12;
  if (draft.button.isConnected === false || rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) {
    closeFieldFilterPopover();
    return;
  }
  const below = viewportHeight - rect.bottom - gap - margin, above = rect.top - gap - margin;
  const useBelow = below >= 320 || below >= above;
  const availableHeight = Math.max(0, viewportHeight - margin * 2);
  popover.style.maxHeight = `${Math.min(availableHeight, Math.max(420, useBelow ? below : above))}px`;
  const width = popover.getBoundingClientRect().width, height = popover.getBoundingClientRect().height;
  popover.style.left = `${Math.max(margin, Math.min(rect.right - width, viewportWidth - width - margin))}px`;
  const top = useBelow ? rect.bottom + gap : rect.top - height - gap;
  popover.style.top = `${Math.max(margin, Math.min(top, viewportHeight - height - margin))}px`;
}

function updateFieldFilterSelection() {
  const draft = fieldFilterDraft;
  if (!draft) return;
  const visible = ColumnFilters.search(draft.options, $("fieldFilterSearch").value);
  const count = visible.filter((option) => draft.selected.has(option.key)).length;
  $("fieldFilterAll").checked = visible.length > 0 && count === visible.length;
  $("fieldFilterAll").indeterminate = count > 0 && count < visible.length;
  $("fieldFilterAll").disabled = !visible.length;
  $("fieldFilterCount").textContent = `已选 ${count} / ${visible.length} 项`;
}

function renderFieldFilterOptions() {
  const draft = fieldFilterDraft;
  if (!draft) return;
  const visible = new Set(ColumnFilters.search(draft.options, $("fieldFilterSearch").value).map((option) => option.key));
  $("fieldFilterOptions").innerHTML = draft.options.map((option, index) => visible.has(option.key)
    ? `<label class="field-filter-option"><input type="checkbox" data-filter-option="${index}" ${draft.selected.has(option.key) ? "checked" : ""}><span>${esc(option.key || "（空白）")}</span><small>${option.count}</small></label>` : "").join("")
    || '<p class="field-filter-empty">没有匹配的值</p>';
  $("fieldFilterOptions").querySelectorAll("input").forEach((input) => {
    input.onchange = () => {
      const option = draft.options[Number(input.dataset.filterOption)];
      if (input.checked) draft.selected.add(option.key); else draft.selected.delete(option.key);
      draft.changed = true;
      updateFieldFilterSelection();
    };
  });
  updateFieldFilterSelection();
  positionFieldFilterPopover();
}

function openFieldFilterPopover(key, button, table = "field") {
  if (fieldFilterDraft?.key === key && fieldFilterDraft.table === table) { closeFieldFilterPopover(true); return; }
  closeFieldFilterPopover();
  const { columns, rows, read } = tableFilterContext(table), view = tableViewState(table);
  const column = columns.find((item) => item.key === key);
  if (!column || !state.samples.length) return;
  const options = ColumnFilters.options(ColumnFilters.apply(rows, view.filters, null, read, key), key, read);
  const allValues = new Set(ColumnFilters.options(rows, key, read).map((option) => option.key));
  fieldFilterDraft = { table, key, column, button, options, allValues, selected: new Set(view.filters[key] ?? allValues),
    controller: modelController, period: periodValue(), changed: false };
  $("fieldFilterTitle").textContent = column.label || column.field_id || column.indicator_id;
  $("fieldFilterTitle").title = $("fieldFilterTitle").textContent;
  $("fieldFilterSearch").value = "";
  $("fieldFilterClear").disabled = !Object.prototype.hasOwnProperty.call(view.filters, key);
  document.querySelectorAll("[data-field-sort]").forEach((control) => control.setAttribute("aria-pressed", String(control.dataset.fieldSort === "none"
    ? !view.sort : view.sort?.key === key && view.sort.direction === control.dataset.fieldSort)));
  $("fieldFilterPopover").showPopover();
  button.setAttribute("aria-expanded", "true");
  renderFieldFilterOptions();
  $("fieldFilterSearch").focus();
}

function chooseFieldFilterValues(mode, checked) {
  const draft = fieldFilterDraft;
  if (!draft) return;
  const visible = ColumnFilters.search(draft.options, $("fieldFilterSearch").value);
  if (mode === "duplicates" || mode === "unique") {
    draft.selected = new Set(visible.filter((option) => mode === "duplicates" ? option.count > 1 : option.count === 1).map((option) => option.key));
  } else visible.forEach((option) => {
    const select = mode === "invert" ? !draft.selected.has(option.key) : checked;
    if (select) draft.selected.add(option.key); else draft.selected.delete(option.key);
  });
  draft.changed = true;
  renderFieldFilterOptions();
}

function applyFieldFilter() {
  const draft = fieldFilterDraft;
  if (!draft || draft.controller !== modelController || draft.period !== periodValue()) { closeFieldFilterPopover(); return; }
  const query = $("fieldFilterSearch").value.trim();
  const view = tableViewState(draft.table);
  if (draft.changed || query) {
    const values = query ? ColumnFilters.search(draft.options, query).filter((option) => draft.selected.has(option.key)).map((option) => option.key)
      : [...draft.selected].filter((value) => draft.allValues.has(value));
    if (values.length === draft.allValues.size) delete view.filters[draft.key];
    else view.filters[draft.key] = values;
  }
  closeFieldFilterPopover();
  renderTableView(draft.table);
}

function sortFieldTable(direction) {
  const draft = fieldFilterDraft;
  if (!draft || draft.controller !== modelController || draft.period !== periodValue()) return;
  tableViewState(draft.table).sort = direction === "none" ? null : { key: draft.key, direction };
  closeFieldFilterPopover();
  renderTableView(draft.table);
}

function clearFieldTableView(table = "field") {
  closeFieldFilterPopover();
  state[`${table}View`] = { filters: {}, sort: null };
  renderTableView(table);
}

function renderFieldTable() {
  closeTableFilterPopover("field");
  renderIndicatorCalculationWarning();
  const allColumns = fieldTableColumns();
  const columns = allColumns.filter((column) => column.kind !== "indicator" || state.showIndicators);
  const keys = new Set(["company:company_name", ...allColumns.map(fieldColumnKey)]);
  Object.keys(state.fieldView.filters).forEach((key) => { if (!keys.has(key)) delete state.fieldView.filters[key]; });
  if (state.fieldView.sort && !keys.has(state.fieldView.sort.key)) state.fieldView.sort = null;
  const rows = fieldTableDisplayRows(fieldTableReader(allColumns));
  renderTableViewStatus("field", rows.length, fieldTableBaseRows().length);
  $("toggleIndicatorsBtn").disabled = !allColumns.some((column) => column.kind === "indicator");
  $("toggleIndicatorsBtn").textContent = state.showIndicators ? "隐藏指标" : "展示指标";
  $("toggleIndicatorsBtn").setAttribute("aria-pressed", String(state.showIndicators));
  $("fieldHead").innerHTML = `
    <tr>
      <th class="sticky-col name-col field-filter-header">主体名称${fieldFilterButton("company:company_name", "主体名称")}</th>
      <th class="sticky-col op-col">操作</th>
      ${columns.map((column) => column.kind === "indicator"
        ? `<th class="indicator-column field-filter-header" data-column-kind="indicator" data-indicator-id="${esc(column.indicator_id)}" title="${esc(column.label || column.indicator_id)}&#10;${esc(column.expression || column.field_id || "")}"><span class="field-header-label">${esc(column.label || column.indicator_id)}</span><div class="muted">指标计算值</div>${fieldFilterButton(fieldColumnKey(column), column.label || column.indicator_id)}</th>`
        : `<th class="source-column field-filter-header" data-column-kind="source" data-field-id="${esc(column.field_id)}"><button class="field-column-edit" type="button" data-field-id="${esc(column.field_id)}" title="${esc(column.label || column.field_id)} · 点击修改整列" aria-label="按列修改${esc(column.label || column.field_id)}" ${state.samples.length ? "" : "disabled"}><span class="field-column-label">${esc(column.label || column.field_id)}</span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false"><path d="m10.5 2.5 3 3M3 10l7.5-7.5a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4L6 13l-3.5.5z"/></svg></button><div class="muted" title="${esc(column.field_id)}">${esc(column.field_id)}</div>${fieldFilterButton(fieldColumnKey(column), column.label || column.field_id)}</th>`).join("")}
    </tr>
  `;
  $("fieldRows").innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.dataset.companyId = row.company.company_id;
    const overrides = checkOverridesFromValues(row.company.company_id);
    const displayed = indicatorDisplayValues(row.company.company_id, row);
    tr.innerHTML = `
      <td class="sticky-col name-col" title="${esc(row.company.company_name)}">${esc(row.company.company_name)}</td>
      <td class="sticky-col op-col"><button class="tiny primary inspect-btn" data-id="${esc(row.company.company_id)}">排查</button></td>
      ${columns.map((column) => column.kind === "indicator"
        ? `<td class="indicator-column" data-column-kind="indicator" data-indicator-id="${esc(column.indicator_id)}" title="${esc(column.expression || column.field_id || "")}">${esc(displayed[column.indicator_id] ?? "")}</td>`
        : `<td class="source-column ${Object.prototype.hasOwnProperty.call(overrides, column.field_id) ? "edited-cell" : ""}" data-column-kind="source" data-field-id="${esc(column.field_id)}" title="${esc(fieldDisplay(row.values[column.field_id], column))}">${esc(fieldDisplay(row.values[column.field_id], column))}</td>`).join("")}
    `;
    $("fieldRows").appendChild(tr);
  });
  if (!rows.length) {
    $("fieldRows").innerHTML = `<tr><td colspan="${columns.length + 2}" class="empty">${state.samples.length ? "暂无符合筛选条件的数据，可清除筛选后查看全部公司。" : "请先在第一步选择样本"}</td></tr>`;
  }
  document.querySelectorAll(".inspect-btn").forEach((btn) => {
    btn.onclick = () => openFieldModal(btn.dataset.id);
  });
  document.querySelectorAll(".field-column-edit").forEach((button) => {
    if (button.dataset.fieldId) button.onclick = () => openFieldColumnModal(button.dataset.fieldId);
  });
  bindTableFilterButtons("field");
}

function closeFieldColumnModal(force = false) {
  const draft = fieldColumnDraft;
  if (draft?.saving && !force) return;
  fieldColumnDraft = null;
  const dialog = $("fieldColumnModal");
  if (dialog?.open) dialog.close();
  if (draft && draft.controller === modelController && draft.period === periodValue()) {
    [...document.querySelectorAll(".field-column-edit")].find((button) => button.dataset.fieldId === draft.field.field_id)?.focus();
  }
}

function openFieldColumnModal(fieldId) {
  closeFieldFilterPopover();
  if (fieldColumnDraft?.saving || checkTransfer || checkEditJobs.size) return;
  const field = state.fieldMatrix.fields.find((item) => item.field_id === fieldId);
  if (!field || !state.samples.length) return;
  const matrix = new Map(state.fieldMatrix.rows.map((row) => [row.company.company_id, row]));
  if (state.samples.some((company) => !matrix.has(company.company_id))) {
    alert("数据尚未加载完成，请稍后重试。");
    return;
  }
  const rows = state.samples.map((company) => {
    const values = { ...matrix.get(company.company_id).values, ...checkOverridesFromValues(company.company_id) };
    return { ...company, initialValue: fieldDisplay(values[fieldId], field) };
  });
  fieldColumnDraft = { field, rows, controller: modelController, period: periodValue(), revision: ruleRevision, saving: false };
  $("fieldColumnTitle").textContent = `按列修改：${field.label || fieldId}`;
  $("fieldColumnHelp").textContent = `${periodValue()} · 共 ${rows.length} 家公司，可分别修改下方字段值。`;
  $("fieldColumnValueHead").textContent = field.label || fieldId;
  $("fieldColumnStatus").textContent = "保存后重新计算相关指标，仅当前页面生效。";
  $("fieldColumnRows").innerHTML = rows.map((company, index) => `<tr>
    <td class="column-edit-seq">${index + 1}</td>
    <td class="column-edit-company"><strong>${esc(company.company_name)}</strong><small>${esc(company.company_id)}</small></td>
    <td><input class="field-column-input" type="text" autocomplete="off" data-company-id="${esc(company.company_id)}" aria-label="${esc(company.company_name)} ${esc(field.label || fieldId)}" value="${esc(company.initialValue)}"></td>
  </tr>`).join("");
  $("fieldColumnForm").querySelectorAll("input,button").forEach((control) => { control.disabled = false; });
  $("fieldColumnModal").showModal();
}

async function saveFieldColumn() {
  const draft = fieldColumnDraft;
  if (!draft || draft.saving) return;
  const current = () => fieldColumnDraft === draft && draft.controller === modelController && draft.period === periodValue()
    && draft.revision === ruleRevision && selectedCompanyIds().join("\0") === draft.rows.map((row) => row.company_id).join("\0");
  if (!current()) { closeFieldColumnModal(true); return; }
  const originals = new Map(draft.rows.map((row) => [row.company_id, row.initialValue]));
  const changed = [...$("fieldColumnRows").querySelectorAll("input[data-company-id]")]
    .filter((input) => originals.has(input.dataset.companyId) && input.value !== originals.get(input.dataset.companyId))
    .map((input) => [input.dataset.companyId, input.value]);
  if (!changed.length) { closeFieldColumnModal(); return; }
  draft.saving = true;
  $("fieldColumnForm").querySelectorAll("input,button").forEach((control) => { control.disabled = true; });
  $("fieldColumnStatus").textContent = `正在保存并重新计算 ${changed.length} 家公司的数据…`;
  const fieldId = draft.field.field_id;
  try {
    const data = await postJson("/api/rules-preview", {
      company_ids: changed.map(([id]) => id), period: draft.period,
      overrides: Object.fromEntries(changed.map(([id, value]) => [id, { ...checkOverridesFromValues(id), [fieldId]: value }])),
    });
    if (!current()) { if (fieldColumnDraft === draft) closeFieldColumnModal(true); return; }
    if (changed.some(([id]) => !data.results?.[id]) || !Array.isArray(data.field_matrix?.rows)) throw new Error("计算结果不完整，请重试。");
    changed.forEach(([id, value]) => {
      const previous = new Map((state.results[id]?.details || []).map((indicator) => [indicator.indicator_id, indicator]));
      (data.results[id].details || []).forEach((indicator) => {
        const before = previous.get(indicator.indicator_id);
        if (indicator.field_id !== fieldId && before?.raw_value === indicator.raw_value && before?.score === indicator.score) return;
        delete state.importedIndicatorValues[id]?.[indicator.indicator_id];
        delete state.indicatorScores[id]?.[indicator.indicator_id];
      });
      state.overrides[id] = { ...state.overrides[id], [fieldId]: value };
      delete state.checkValues[id]?.[draft.period]?.[fieldId];
      delete state.checkScores[id]?.[draft.period]?.[fieldId];
      state.results[id] = data.results[id];
    });
    const rows = new Map(data.field_matrix.rows.map((row) => [row.company.company_id, row]));
    state.fieldMatrix.rows = state.fieldMatrix.rows.map((row) => rows.get(row.company.company_id) || row);
    applyOverridesToFieldMatrix();
    renderFieldTable();
    renderInitialMatrix();
    renderCheckMatrix();
    renderSummaryPanels();
    closeFieldColumnModal(true);
  } catch (error) {
    if (current() && error.name !== "AbortError") $("fieldColumnStatus").textContent = `保存失败：${error.message}。修改内容已保留，可重试。`;
    else if (fieldColumnDraft === draft) closeFieldColumnModal(true);
  } finally {
    if (fieldColumnDraft === draft) {
      draft.saving = false;
      $("fieldColumnForm").querySelectorAll("input,button").forEach((control) => { control.disabled = false; });
    }
  }
}

function ratingColumnButton(table, key, label) {
  return `<button class="field-column-edit rating-column-edit" type="button" data-edit-table="${table}" data-edit-key="${esc(key)}" title="${esc(label)} · 点击修改整组数据" aria-label="按列修改${esc(label)}"><span class="field-column-label">${esc(label)}</span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m10.5 2.5 3 3M3 10l7.5-7.5a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4L6 13l-3.5.5z"/></svg></button>`;
}

function ratingColumnCurrent(draft) {
  return ratingColumnDraft === draft && draft.controller === modelController && draft.period === periodValue()
    && draft.revision === ruleRevision && selectedCompanyIds().join("\0") === draft.rows.map((row) => row.company_id).join("\0");
}

function closeRatingColumnModal(force = false) {
  const draft = ratingColumnDraft;
  if (draft?.saving && !force) return;
  ratingColumnDraft = null;
  draft?.rows.forEach((row) => { clearTimeout(row.timer); row.version++; });
  if ($("ratingColumnModal")?.open) $("ratingColumnModal").close();
  if (draft?.controller === modelController && draft.period === periodValue()) {
    document.querySelectorAll(".rating-column-edit").forEach((button) => {
      if (button.dataset.editTable === draft.table && button.dataset.editKey === draft.key) button.focus();
    });
  }
}

function openRatingColumnModal(table, key) {
  closeFieldFilterPopover();
  if (ratingColumnDraft?.saving || checkTransfer || checkEditJobs.size || !state.samples.length) return;
  if (!["initial", "check"].includes(table)) return;
  if (state.samples.some((company) => state.results[company.company_id]?.period_end !== periodValue())) return alert("数据尚未加载完成，请稍后重试。");
  const definitions = state.samples.map((company) => table === "initial"
    ? nonCheckDetails(state.results[company.company_id]).find((indicator) => indicator.indicator_id === key)
    : checkFields(company.company_id).find((field) => field.field_id === key));
  if (definitions.some((definition) => !definition)) return alert("数据尚未加载完成，请稍后重试。");
  const rows = state.samples.map((company, index) => {
    const definition = definitions[index], id = company.company_id;
    const values = table === "initial" ? { value: indicatorRawDisplay(definition, id),
      score: fmt(indicatorScore(id, definition).score), weighted: fmt(indicatorWeightedExact(id, definition)) }
      : { value: fieldDisplay(checkValue(id, definition), definition), score: fmt(effectiveCheckScore(id, definition)) };
    return { ...company, definition, values, original: { ...values }, manual: null, inputs: {}, version: 0, pending: false, error: "" };
  });
  const definition = definitions[0];
  ratingColumnDraft = { table, key, fieldId: definition.field_id, rows, controller: modelController,
    period: periodValue(), revision: ruleRevision, saving: false };
  const draft = ratingColumnDraft;
  $("ratingColumnModal").dataset.table = table;
  $("ratingColumnTitle").textContent = `按列修改：${definition.label || key}`;
  $("ratingColumnHelp").textContent = `${draft.period} · 共 ${rows.length} 家公司。${table === "initial" ? "指标值变化后重新计算，赋分与得分按当前权重联动。" : "指标值变化后按公式计算得分，也可手动修改得分。"}`;
  const columns = table === "initial" ? [["value", "指标值"], ["score", "赋分"], ["weighted", "得分"]] : [["value", "指标值"], ["score", "得分"]];
  $("ratingColumnHead").innerHTML = `<tr><th class="column-edit-seq">序号</th><th>主体名称</th>${columns.map(([, label]) => `<th class="rating-column-value-head">${label}</th>`).join("")}</tr>`;
  $("ratingColumnRows").innerHTML = rows.map((row, index) => `<tr>
    <td class="column-edit-seq">${index + 1}</td><td class="column-edit-company"><strong>${esc(row.company_name)}</strong><small>${esc(row.company_id)}</small></td>
    ${columns.map(([kind, label]) => `<td><input class="field-column-input" type="text" autocomplete="off" data-company-id="${esc(row.company_id)}" data-edit-kind="${kind}" aria-label="${esc(row.company_name)} ${label}" value="${esc(row.values[kind])}"${kind === "value" ? "" : ' inputmode="decimal"'}></td>`).join("")}
  </tr>`).join("");
  const companies = new Map(rows.map((row) => [row.company_id, row]));
  $("ratingColumnRows").querySelectorAll("input").forEach((input) => {
    const row = companies.get(input.dataset.companyId), kind = input.dataset.editKind;
    row.inputs[kind] = input;
    input.oninput = () => editRatingColumnCell(draft, row, kind, input.value);
    input.onchange = () => {
      if (kind !== "value" && row.manual?.score !== null) input.value = row.values[kind];
    };
  });
  $("ratingColumnForm").querySelectorAll("input,button").forEach((control) => { control.disabled = false; });
  updateRatingColumnStatus(draft);
  $("ratingColumnModal").showModal();
}

function updateRatingColumnStatus(draft) {
  if (!ratingColumnCurrent(draft) || draft.saving) return;
  const pending = draft.rows.filter((row) => row.pending).length, errors = draft.rows.filter((row) => row.error).length;
  $("ratingColumnStatus").textContent = pending ? `正在预览 ${pending} 家公司的计算结果…`
    : errors ? "部分数据无法计算，可检查指标值或手动填写评分；确认后统一保存。" : "修改尚未保存，确认后统一更新当前页面及评级结果。";
  $("ratingColumnStatus").classList.toggle("error", !pending && errors > 0);
}

function syncRatingColumnRow(draft, row) {
  Object.entries(row.inputs).forEach(([kind, input]) => {
    if (document.activeElement !== input) input.value = row.values[kind];
    input.classList.toggle("edited-cell", row.values[kind] !== row.original[kind]);
    input.placeholder = kind !== "value" && row.pending && !row.manual ? "计算中…" : "";
    input.title = row.error || "";
  });
  updateRatingColumnStatus(draft);
}

function editRatingColumnCell(draft, row, kind, value) {
  if (!ratingColumnCurrent(draft) || draft.saving) return;
  if (kind === "value") {
    row.values.value = value;
    row.manual = null;
    row.error = "";
    clearTimeout(row.timer);
    row.version++;
    row.pending = value !== row.original.value;
    Object.keys(row.values).filter((key) => key !== "value").forEach((key) => { row.values[key] = row.pending ? "" : row.original[key]; });
    if (row.pending) row.timer = setTimeout(() => previewRatingColumnRow(draft, row), 250);
  } else {
    const number = numericCheckScore(value);
    row.manual = { kind, input: value, score: null };
    row.values[kind] = value;
    row.error = number === null ? "评分请输入有效数字。" : "";
    if (number !== null && draft.table === "initial") {
      const weight = num(row.definition.weight), proposed = kind === "weighted" && weight !== 0 ? Number(number) / weight : Number(number);
      const score = clampScore(proposed, row.definition);
      const exact = kind === "weighted" && score === proposed ? number : weight === 0 ? String(score) : decimalProduct([score, weight]);
      row.manual = { kind, input: value, score, weighted: Number(exact), weighted_exact: exact };
      row.values.score = fmt(score);
      row.values.weighted = fmt(exact);
    } else if (number !== null) {
      row.manual.score = number;
      row.values.score = fmt(number);
    }
  }
  syncRatingColumnRow(draft, row);
}

async function previewRatingColumnRow(draft, row) {
  const version = ++row.version;
  try {
    const result = await postJson("/api/score-preview", { company_id: row.company_id, period: draft.period,
      overrides: { ...checkOverridesFromValues(row.company_id), [draft.fieldId]: row.values.value } });
    if (!ratingColumnCurrent(draft) || draft.saving || row.version !== version) return;
    if (!row.manual) {
      if (draft.table === "initial") {
        const indicator = nonCheckDetails(result).find((item) => item.indicator_id === draft.key);
        if (!indicator) throw new Error("计算结果不完整");
        const score = clampScore(indicator.score, indicator), weight = num(indicator.weight);
        row.values.score = fmt(score);
        row.values.weighted = fmt(weight === 0 ? String(score) : decimalProduct([score, weight]));
      } else {
        const field = (result.check_fields || []).find((item) => item.field_id === draft.fieldId);
        if (!field) throw new Error("计算结果不完整");
        row.values.score = fmt(field.score);
        if (numericCheckScore(field.score) === null) row.error = field.score_error || "公式无法得到有效数值，可手动填写得分。";
      }
    }
  } catch (error) {
    if (ratingColumnCurrent(draft) && !draft.saving && row.version === version && error.name !== "AbortError") row.error = `预览失败：${error.message}`;
  } finally {
    if (ratingColumnCurrent(draft) && !draft.saving && row.version === version) { row.pending = false; syncRatingColumnRow(draft, row); }
  }
}

async function saveRatingColumn() {
  const draft = ratingColumnDraft;
  if (!draft || draft.saving) return;
  if (!ratingColumnCurrent(draft)) { closeRatingColumnModal(true); return; }
  const changed = draft.rows.filter((row) => row.values.value !== row.original.value || (row.manual && row.manual.input !== row.original[row.manual.kind]));
  if (!changed.length) { closeRatingColumnModal(); return; }
  const invalid = changed.find((row) => row.manual?.score === null);
  if (invalid) { $("ratingColumnStatus").textContent = `${invalid.company_name}：评分请输入有效数字。`; invalid.inputs[invalid.manual.kind]?.focus(); return; }
  draft.saving = true;
  draft.rows.forEach((row) => { clearTimeout(row.timer); row.version++; row.pending = false; });
  $("ratingColumnForm").querySelectorAll("input,button").forEach((control) => { control.disabled = true; });
  $("ratingColumnStatus").textContent = `正在保存并计算 ${changed.length} 家公司的数据…`;
  const rawRows = changed.filter((row) => row.values.value !== row.original.value);
  try {
    const data = rawRows.length ? await postJson("/api/rules-preview", { company_ids: rawRows.map((row) => row.company_id), period: draft.period,
      overrides: Object.fromEntries(rawRows.map((row) => [row.company_id, { ...checkOverridesFromValues(row.company_id), [draft.fieldId]: row.values.value }])) }) : null;
    if (!ratingColumnCurrent(draft)) { if (ratingColumnDraft === draft) closeRatingColumnModal(true); return; }
    if (data && (rawRows.some((row) => !data.results?.[row.company_id]) || !Array.isArray(data.field_matrix?.rows))) throw new Error("计算结果不完整，请重试。");
    rawRows.forEach((row) => {
      const id = row.company_id;
      if (draft.table === "initial") {
        const previous = new Map(nonCheckDetails(state.results[id]).map((item) => [item.indicator_id, item]));
        nonCheckDetails(data.results[id]).forEach((indicator) => {
          const before = previous.get(indicator.indicator_id);
          if (indicator.field_id !== draft.fieldId && before?.raw_value === indicator.raw_value && before?.score === indicator.score) return;
          delete state.indicatorScores[id]?.[indicator.indicator_id];
          delete state.importedIndicatorValues[id]?.[indicator.indicator_id];
        });
        state.overrides[id] = { ...state.overrides[id], [draft.fieldId]: row.values.value };
      } else savePageChecks(id, { [draft.fieldId]: row.values.value });
      state.results[id] = data.results[id];
    });
    changed.forEach((row) => {
      if (!row.manual || (row.values.value === row.original.value && row.manual.input === row.original[row.manual.kind])) return;
      if (draft.table === "initial") setIndicatorScore(row.company_id, draft.key, row.manual.score, row.manual.weighted, row.manual.weighted_exact);
      else savePageCheckScore(row.company_id, draft.fieldId, row.manual.score);
    });
    if (data) {
      const matrix = new Map(data.field_matrix.rows.map((row) => [row.company.company_id, row]));
      state.fieldMatrix.rows = state.fieldMatrix.rows.map((row) => matrix.get(row.company.company_id) || row);
    }
    applyOverridesToFieldMatrix();
    renderFieldTable(); renderInitialMatrix(); renderCheckMatrix(); renderSummaryPanels();
    closeRatingColumnModal(true);
  } catch (error) {
    if (ratingColumnCurrent(draft) && error.name !== "AbortError") $("ratingColumnStatus").textContent = `保存失败：${error.message}。修改内容已保留，可重试。`;
    else if (ratingColumnDraft === draft) closeRatingColumnModal(true);
  } finally {
    if (ratingColumnDraft === draft) {
      draft.saving = false;
      $("ratingColumnForm").querySelectorAll("input,button").forEach((control) => { control.disabled = false; });
    }
  }
}

function openFieldModal(companyId) {
  closeFieldFilterPopover();
  state.modalCompanyId = companyId;
  const matrixRow = (state.fieldMatrix.rows || []).find((x) => x.company.company_id === companyId);
  if (!matrixRow) return;
  $("modalTitle").textContent = `字段数据修改：${matrixRow.company.company_name}`;
  $("modalFields").innerHTML = state.fieldMatrix.fields.map((field) => `
    <label class="modal-field">
      <span>${esc(field.label || field.field_id)}<em>${esc(field.field_id)}</em></span>
      <input data-field-id="${esc(field.field_id)}" value="${esc(fieldDisplay(matrixRow.values[field.field_id], field))}">
    </label>
  `).join("");
  $("fieldModal").classList.remove("hidden");
}

async function saveModalFields() {
  cancelCheckEdits();
  const companyId = state.modalCompanyId;
  const inputs = [...$("modalFields").querySelectorAll("input[data-field-id]")];
  const matrixRow = state.fieldMatrix.rows.find((row) => row.company.company_id === companyId);
  state.overrides[companyId] = state.overrides[companyId] || {};
  let changed = false;
  inputs.forEach((input) => {
    const fieldId = input.dataset.fieldId;
    const field = state.fieldMatrix.fields.find((item) => item.field_id === fieldId);
    if (input.value === fieldDisplay(matrixRow?.values[fieldId], field)) return;
    state.overrides[companyId][fieldId] = input.value;
    changed = true;
    delete pageCheckValues(companyId)[fieldId];
  });
  if (changed) {
    delete state.importedIndicatorValues[companyId];
    clearPageCheckScores(companyId);
  }
  applyOverridesToFieldMatrix();
  $("fieldModal").classList.add("hidden");
  await refreshScores();
  renderFieldTable();
}

async function resetToDatabaseValues() {
  if (!confirm("确定重置为数据库初始数据吗？当前页面已修改和导入的数据不会保留。")) return;
  closeFieldColumnModal(true);
  closeRatingColumnModal(true);
  closeFieldFilterPopover();
  resetTableViews();
  cancelCheckEdits();
  state.overrides = {};
  state.importedIndicatorValues = {};
  state.ruleOverrides = {};
  state.gradeRules = null;
  gradeRuleDraft = null;
  gradeOpenVersion++;
  $("gradeRulesModal").classList.add("hidden");
  ruleRevision++;
  state.indicatorScores = {};
  state.checkValues = {};
  state.checkScores = {};
  state.checkNotes = {};
  await refreshFieldMatrix();
  await refreshScores();
  renderInitialMatrix();
  renderCheckMatrix();
}

async function exportFieldsExcel() {
  if (!state.samples.length) {
    alert("请先选择样本。");
    return;
  }
  try {
    const { blob, filename } = await postDownload("/api/export-fields", {
      company_ids: selectedCompanyIds(),
      period: periodValue(),
      overrides: Object.fromEntries(state.samples.map((company) => [company.company_id, checkOverridesFromValues(company.company_id)])),
      indicator_values: Object.fromEntries(state.samples.map((company) => [company.company_id,
        indicatorDisplayValues(company.company_id, state.fieldMatrix.rows.find((row) => row.company.company_id === company.company_id))])),
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    if (error.name === "AbortError") return;
    alert(error.message || "导出失败");
  }
}

function indicatorDisplayValues(companyId, row) {
  return {
    ...Object.fromEntries(Object.entries(row?.indicator_values || {}).map(([id, value]) => [id, fmt(value)])),
    ...Object.fromEntries((state.results[companyId]?.details || []).map((detail) => [detail.indicator_id, fmt(detail.score)])),
    ...Object.fromEntries(Object.entries(state.importedIndicatorValues[companyId] || {}).map(([id, value]) => [id, fmt(value)])),
  };
}

function effectiveIndicatorValue(companyId, indicator) {
  const values = state.importedIndicatorValues[companyId] || {};
  return Object.prototype.hasOwnProperty.call(values, indicator.indicator_id) ? values[indicator.indicator_id] : indicator.score;
}

function clearImportedCheckIndicators(companyId) {
  const values = state.importedIndicatorValues[companyId];
  if (values) checkDetails(state.results[companyId]).forEach((indicator) => { delete values[indicator.indicator_id]; });
}

async function importFieldsExcel(file) {
  if (!file) return;
  if (!state.samples.length) {
    alert("请先选择样本。");
    return;
  }
  const controller = modelController;
  const period = periodValue();
  try {
    const data = await modelRequest("/api/import-fields", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      body: file,
    });
    if (controller !== modelController || period !== periodValue()) return;
    const selected = new Set(selectedCompanyIds());
    cancelCheckEdits();
    let imported = 0;
    const companyIds = new Set([...Object.keys(data.overrides || {}), ...Object.keys(data.indicator_values || {})]);
    companyIds.forEach((companyId) => {
      if (!selected.has(companyId)) return;
      const values = data.overrides?.[companyId] || {};
      state.overrides[companyId] = { ...(state.overrides[companyId] || {}), ...values };
      // Imported indicator columns are snapshots; always recalculate from page inputs.
      delete state.importedIndicatorValues[companyId];
      delete state.indicatorScores[companyId];
      clearPageCheckScores(companyId, period);
      if (state.checkValues[companyId]?.[period]) {
        state.checkValues[companyId][period] = Object.fromEntries(Object.entries(pageCheckValues(companyId, period))
          .filter(([fieldId]) => !Object.prototype.hasOwnProperty.call(values, fieldId)));
      }
      imported += 1;
    });
    if (!imported) {
      alert("Excel中没有匹配当前已选样本的主体。");
      return;
    }
    applyOverridesToFieldMatrix();
    renderFieldTable();
    await refreshScores();
    renderInitialMatrix();
    renderCheckMatrix();
    alert(`导入完成，已更新 ${imported} 个主体的源数据并重新计算指标值，仅当前页面生效，未写入数据库。`);
  } catch (error) {
    if (error.name === "AbortError") return;
    alert(error.message || "导入失败");
  } finally {
    $("importFieldsInput").value = "";
  }
}

function nonCheckDetails(result) {
  return (result?.details || []).filter((ind) => (ind.field_type || "") !== "排查项");
}

function gradeRuleStatus(message, error = false) {
  $("gradeRulesStatus").textContent = message;
  $("gradeRulesStatus").classList.toggle("error", error);
}

function refreshDatabaseGrades(force = false) {
  if (!state.model || (state.gradeRules && !force)) return Promise.resolve(false);
  if (gradeReadJob?.controller === modelController && gradeReadJob.rules === state.gradeRules && gradeReadJob.force === force) return gradeReadJob.promise;
  const job = { controller: modelController, rules: state.gradeRules, force };
  gradeReadJob = job;
  job.promise = (async () => {
    const data = await api("/api/grades");
    if (gradeReadJob !== job || job.controller !== modelController || job.rules !== state.gradeRules) return false;
    state.model = { ...state.model, grades: data.grades, database_path: data.database_path };
    if (force) state.gradeRules = null;
    return true;
  })().finally(() => { if (gradeReadJob === job) gradeReadJob = null; });
  return job.promise;
}

async function refreshGradesOnFocus() {
  if (!state.model || state.gradeRules || gradeRuleDraft || !$("gradeRulesModal").classList.contains("hidden")) return;
  try {
    if (await refreshDatabaseGrades()) { renderInitialMatrix(); renderSummaryPanels(); }
  } catch (error) {
    if (error.name !== "AbortError") $("modelStatus").textContent = `等级规则读取失败：${error.message}`;
  }
}

async function openGradeRules(force = false) {
  if (checkTransfer || !state.model || !state.samples.length) return;
  const version = ++gradeOpenVersion, controller = modelController;
  gradeRuleDraft = null;
  $("gradeRulesRows").innerHTML = "";
  $("gradeRulesSource").textContent = "";
  $("gradeRulesSave").disabled = true;
  $("gradeRulesReload").disabled = true;
  gradeRuleStatus("正在读取等级规则…");
  $("gradeRulesModal").classList.remove("hidden");
  try {
    await refreshDatabaseGrades(force);
    if (version !== gradeOpenVersion || controller !== modelController) return;
    const model = state.gradeRules ? GradeRules.clone(state.gradeRules) : GradeRules.fromGrades(state.model.grades || []);
    gradeRuleDraft = { model, original: GradeRules.clone(model), editing: null, pending: null };
    $("gradeRulesSource").textContent = `数据库文件：${state.model.database_path || `${state.sourceDirectory}\\${state.database}.db`}`;
    gradeRuleStatus(state.gradeRules ? "当前使用页面修改后的等级规则；可点击“读取数据库最新规则”恢复数据库值。" : "已读取数据库最新规则。相邻边界自动同步，区间左闭右开，最后一段包含右边界。");
    renderGradeRules();
    renderInitialMatrix();
    renderSummaryPanels();
  } catch (error) {
    if (version === gradeOpenVersion && error.name !== "AbortError") gradeRuleStatus(`等级规则读取失败：${error.message}`, true);
  } finally {
    if (version === gradeOpenVersion) $("gradeRulesReload").disabled = false;
  }
}

function renderGradeRules() {
  const draft = gradeRuleDraft;
  if (!draft) return;
  $("gradeRulesSave").disabled = !draft.model.grades.length;
  $("gradeRulesRows").innerHTML = draft.model.grades.map((grade, index) => {
    const editing = draft.editing === index;
    const boundary = (side, offset) => editing
      ? `<input class="grade-boundary" data-side="${side}" type="number" step="any" aria-label="${esc(grade)} ${side === "left" ? "左" : "右"}边界值" value="${esc(fmt(draft.pending[side]))}">`
      : `<span data-boundary-index="${index + offset}">${esc(fmt(draft.model.boundaries[index + offset]))}</span>`;
    return `<tr data-grade-index="${index}"><td>${index + 1}</td><td>${esc(grade)}</td>
      <td>${boundary("left", 0)}</td><td>${boundary("right", 1)}</td>
      <td><div class="rule-row-actions">
        <button class="tiny ${editing ? "plain" : "primary"} grade-edit" data-index="${index}" ${draft.editing !== null && !editing ? "disabled" : ""}>${editing ? "取消编辑" : "编辑"}</button>
        ${editing ? `<button class="tiny primary grade-confirm" data-index="${index}">确定</button>` : ""}
        <button class="tiny danger grade-delete" data-index="${index}" ${draft.editing !== null || draft.model.grades.length <= 1 ? "disabled" : ""} title="${draft.model.grades.length <= 1 ? "至少保留一个等级区间" : "删除后自动衔接相邻区间"}">删除</button>
      </div></td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">没有 status 为“打分映射”且 inclusive 为 1 的等级规则</td></tr>`;
  $("gradeRulesRows").querySelectorAll(".grade-edit").forEach((button) => {
    button.onclick = () => {
      const index = Number(button.dataset.index);
      if (draft.editing === index) {
        draft.model = GradeRules.clone(draft.original);
        draft.editing = null;
        draft.pending = null;
      } else {
        draft.editing = index;
        draft.pending = { left: String(draft.model.boundaries[index]), right: String(draft.model.boundaries[index + 1]) };
      }
      gradeRuleStatus("修改后点击该行“确定”保存，取消编辑将恢复本次编辑前的边界。");
      renderGradeRules();
    };
  });
  $("gradeRulesRows").querySelectorAll(".grade-boundary").forEach((input) => {
    input.oninput = () => {
      draft.pending[input.dataset.side] = input.value;
      updateGradeBoundaries();
    };
  });
  $("gradeRulesRows").querySelectorAll(".grade-confirm").forEach((button) => { button.onclick = () => saveGradeRules(false); });
  $("gradeRulesRows").querySelectorAll(".grade-delete").forEach((button) => {
    button.onclick = () => {
      try {
        draft.model = GradeRules.remove(draft.model, Number(button.dataset.index));
        applyGradeRules();
        gradeRuleStatus("已删除该行并衔接相邻区间，仅当前页面生效。");
        renderGradeRules();
      } catch (error) { gradeRuleStatus(error.message, true); }
    };
  });
}

function updateGradeBoundaries() {
  const draft = gradeRuleDraft;
  if (!draft || draft.editing === null) return true;
  try {
    draft.model = GradeRules.withBounds(draft.model, draft.editing, draft.pending.left, draft.pending.right);
    $("gradeRulesRows").querySelectorAll("[data-boundary-index]").forEach((cell) => {
      cell.textContent = fmt(draft.model.boundaries[Number(cell.dataset.boundaryIndex)]);
    });
    $("gradeRulesRows").querySelectorAll(".grade-boundary").forEach((input) => input.removeAttribute("aria-invalid"));
    gradeRuleStatus("相邻边界已同步，点击“确定”后生效。");
    return true;
  } catch (error) {
    $("gradeRulesRows").querySelectorAll(".grade-boundary").forEach((input) => input.setAttribute("aria-invalid", "true"));
    gradeRuleStatus(error.message, true);
    return false;
  }
}

function applyGradeRules() {
  const draft = gradeRuleDraft;
  GradeRules.validate(draft.model);
  state.gradeRules = GradeRules.clone(draft.model);
  draft.original = GradeRules.clone(draft.model);
  renderInitialMatrix();
  renderSummaryPanels();
}

function saveGradeRules(close = true) {
  const draft = gradeRuleDraft;
  if (!draft || !updateGradeBoundaries()) return;
  try {
    if (JSON.stringify(draft.model) !== JSON.stringify(draft.original)) applyGradeRules();
    draft.editing = null;
    draft.pending = null;
    if (close) {
      gradeRuleDraft = null;
      $("gradeRulesModal").classList.add("hidden");
    } else {
      gradeRuleStatus("已保存该行等级规则，仅当前页面生效。");
      renderGradeRules();
    }
  } catch (error) { gradeRuleStatus(error.message, true); }
}

function pageSourceOverrides() {
  return Object.fromEntries(state.samples.map((company) => [company.company_id, checkOverridesFromValues(company.company_id)]));
}

function openScoringRules() {
  if (checkTransfer || !state.samples.length) return;
  const indicators = state.results[state.samples[0].company_id]?.details || [];
  ruleDraft = {
    controller: modelController, period: periodValue(), indicators,
    original: Object.fromEntries(indicators.map((indicator) => [indicator.indicator_id, { weight: String(indicator.weight), expression: indicator.expression || "" }])),
    values: Object.fromEntries(indicators.map((indicator) => [indicator.indicator_id, { weight: String(indicator.weight), expression: indicator.expression || "" }])),
    editing: new Set(),
  };
  $("rulesStatus").textContent = "仅当前页面生效，不写入数据库。权重按原值填写，例如 0.1000 表示 10.0000%。";
  $("rulesSave").disabled = false;
  renderScoringRules();
  $("rulesModal").classList.remove("hidden");
}

function renderScoringRules() {
  const draft = ruleDraft;
  if (!draft) return;
  $("rulesRows").innerHTML = draft.indicators.map((indicator, index) => {
    const id = indicator.indicator_id;
    const value = draft.values[id];
    const editing = draft.editing.has(id);
    return `<tr data-rule-id="${esc(id)}">
      <td>${index + 1}</td><td>${esc(indicator.label)}</td>
      <td>${editing ? `<input class="rule-weight" type="number" min="0" step="any" aria-label="${esc(indicator.label)} 指标权重" value="${esc(fmt(value.weight))}">` : esc(fmt(value.weight))}</td>
      <td>${editing ? `<textarea class="rule-expression" aria-label="${esc(indicator.label)} 指标取值公式">${esc(value.expression)}</textarea>` : `<code>${esc(value.expression)}</code>`}</td>
      <td><div class="rule-row-actions"><button type="button" class="tiny ${editing ? "plain" : "primary"} rule-action" data-id="${esc(id)}">${editing ? "取消编辑" : "编辑"}</button>
        ${editing ? `<button type="button" class="tiny primary rule-confirm" data-id="${esc(id)}">确定</button>` : ""}</div></td>
    </tr>`;
  }).join("");
  $("rulesRows").querySelectorAll(".rule-action").forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.id;
      if (draft.editing.has(id)) {
        draft.values[id] = { ...draft.original[id] };
        draft.editing.delete(id);
      } else draft.editing.add(id);
      renderScoringRules();
    };
  });
  $("rulesRows").querySelectorAll(".rule-weight,.rule-expression").forEach((input) => {
    input.oninput = () => {
      const id = input.closest("tr").dataset.ruleId;
      draft.values[id][input.classList.contains("rule-weight") ? "weight" : "expression"] = input.value;
    };
  });
  $("rulesRows").querySelectorAll(".rule-confirm").forEach((button) => {
    button.onclick = () => saveScoringRules(button.dataset.id);
  });
}

async function saveScoringRules(rowId = null) {
  const draft = ruleDraft;
  if (!draft) return;
  const rules = { ...state.ruleOverrides };
  let changed = false;
  try {
    (rowId ? [rowId] : Object.keys(draft.values)).forEach((id) => {
      const value = draft.values[id];
      const weight = Number(value.weight);
      if (!value.weight.trim() || !Number.isFinite(weight) || weight < 0) throw new Error("指标权重必须为非负数字。");
      if (weight !== Number(draft.original[id].weight) || value.expression !== draft.original[id].expression) {
        changed = true;
        rules[id] = { weight, expression: value.expression };
      }
    });
    if (!changed) {
      if (rowId) {
        draft.editing.delete(rowId);
        renderScoringRules();
      } else {
        $("rulesModal").classList.add("hidden");
        ruleDraft = null;
      }
      return;
    }
    $("rulesSave").disabled = true;
    $("rulesRows").querySelectorAll("input,textarea,button").forEach((control) => { control.disabled = true; });
    $("rulesStatus").textContent = "正在按新规则重新评分…";
    const data = await postJson("/api/rules-preview", { company_ids: selectedCompanyIds(), period: draft.period, overrides: pageSourceOverrides(), rules });
    if (draft !== ruleDraft || draft.controller !== modelController || draft.period !== periodValue()) return;
    cancelCheckEdits();
    ruleRevision++;
    state.ruleOverrides = rules;
    Object.keys(rules).forEach((id) => {
      if (rules[id].expression !== undefined && rules[id].expression !== draft.original[id]?.expression) {
        Object.values(state.importedIndicatorValues).forEach((values) => { delete values[id]; });
      }
    });
    state.results = data.results;
    state.fieldMatrix = data.field_matrix;
    state.indicatorScores = {};
    state.checkScores = {};
    applyOverridesToFieldMatrix();
    renderSamples();
    renderFieldTable();
    renderInitialMatrix();
    renderCheckMatrix();
    renderSummaryPanels();
    if (rowId) {
      const indicator = data.results[state.samples[0].company_id].details.find((item) => item.indicator_id === rowId);
      draft.original[rowId] = { weight: String(indicator.weight), expression: indicator.expression || "" };
      draft.values[rowId] = { ...draft.original[rowId] };
      draft.editing.delete(rowId);
      renderScoringRules();
      $("rulesStatus").textContent = "已保存该行规则。";
    } else {
      $("rulesModal").classList.add("hidden");
      ruleDraft = null;
    }
  } catch (error) {
    if (ruleDraft === draft && error.name !== "AbortError") $("rulesStatus").textContent = `应用失败：${error.message}`;
  } finally {
    if (ruleDraft === draft) {
      $("rulesSave").disabled = false;
      $("rulesRows").querySelectorAll("input,textarea,button").forEach((control) => { control.disabled = false; });
    }
  }
}

function checkDetails(result) {
  return (result?.details || []).filter((ind) => (ind.field_type || "") === "排查项");
}

function findIndicator(companyId, indicatorId) {
  return (state.results[companyId]?.details || []).find((ind) => ind.indicator_id === indicatorId);
}

function indicatorScore(companyId, indicator) {
  const saved = state.indicatorScores[companyId]?.[indicator.indicator_id];
  if (saved) return saved;
  const score = clampScore(effectiveIndicatorValue(companyId, indicator), indicator);
  const weighted = (num(indicator.weight) === 0) ? score : score * num(indicator.weight);
  return {
    score,
    weighted,
  };
}

function setIndicatorScore(companyId, indicatorId, score, weighted, weightedExact = String(weighted)) {
  state.indicatorScores[companyId] = state.indicatorScores[companyId] || {};
  state.indicatorScores[companyId][indicatorId] = { score, weighted, weighted_exact: weightedExact };
}

function indicatorWeightedExact(companyId, indicator) {
  const saved = state.indicatorScores[companyId]?.[indicator.indicator_id];
  if (saved) return saved.weighted_exact ?? String(saved.weighted);
  const score = indicatorScore(companyId, indicator).score;
  return num(indicator.weight) === 0 ? String(score) : decimalProduct([score, indicator.weight]);
}

function baseScoreText(companyId) {
  return sumRoundUp4(nonCheckDetails(state.results[companyId]).map((indicator) => indicatorWeightedExact(companyId, indicator)));
}

function finalScoreText(companyId) {
  const checks = checkTotalText(companyId);
  return checks === null ? null : sumRoundUp4([...nonCheckDetails(state.results[companyId]).map((indicator) => indicatorWeightedExact(companyId, indicator)), checks]);
}

function baseScore(companyId) {
  const result = state.results[companyId];
  return nonCheckDetails(result).reduce((sum, ind) => sum + indicatorScore(companyId, ind).weighted, 0);
}

function checkFields(companyId) {
  const result = state.results[companyId];
  return result?.period_end === periodValue() ? result.check_fields || [] : [];
}

function pageCheckValues(companyId, period = periodValue()) {
  return state.checkValues[companyId]?.[period] || {};
}

function pageCheckNotes(companyId, period = periodValue()) {
  return state.checkNotes[companyId]?.[period] || {};
}

function pageCheckScores(companyId, period = periodValue()) {
  return state.checkScores[companyId]?.[period] || {};
}

function clearPageCheckScores(companyId, period = periodValue()) {
  if (state.checkScores[companyId]) delete state.checkScores[companyId][period];
}

function numericCheckScore(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim().replace(/,/g, "");
  const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?$/i.exec(text);
  return match && Math.abs(Number(match[1] || 0)) <= 1000 && Number.isFinite(Number(text)) ? text : null;
}

function savePageCheckScore(companyId, fieldId, value, period = periodValue()) {
  state.checkScores[companyId] = state.checkScores[companyId] || {};
  state.checkScores[companyId][period] = { ...pageCheckScores(companyId, period), [fieldId]: numericCheckScore(value) };
}

function effectiveCheckScore(companyId, field) {
  const scores = pageCheckScores(companyId);
  if (Object.prototype.hasOwnProperty.call(scores, field.field_id)) return scores[field.field_id];
  if (checkEditJobs.has(companyId)) return null;
  // The server evaluates indicator.expression directly, without weight or score bounds.
  if (Object.prototype.hasOwnProperty.call(field, "score")) return numericCheckScore(field.score);
  return field.expression ? null : numericCheckScore(checkValue(companyId, field));
}

function checkScoreStatus(companyId) {
  const job = checkEditJobs.get(companyId);
  if (job) return job.error ? "排查计算异常" : "排查计算中";
  return Object.values(companyChecks(companyId)).some((check) => check.score === null) ? "排查计算异常" : "";
}

function checksReady() {
  return !checkEditJobs.size && state.samples.every((company) => state.results[company.company_id]?.period_end === periodValue() && !checkScoreStatus(company.company_id));
}

function savePageChecks(companyId, values, notes = null, period = periodValue()) {
  const scores = { ...pageCheckScores(companyId, period) };
  Object.keys(values).forEach((fieldId) => { delete scores[fieldId]; });
  if (Object.keys(values).length) {
    state.checkScores[companyId] = state.checkScores[companyId] || {};
    state.checkScores[companyId][period] = scores;
  }
  if (period === periodValue()) clearImportedCheckIndicators(companyId);
  state.checkValues[companyId] = state.checkValues[companyId] || {};
  state.checkValues[companyId][period] = { ...pageCheckValues(companyId, period), ...values };
  if (notes !== null) {
    state.checkNotes[companyId] = state.checkNotes[companyId] || {};
    state.checkNotes[companyId][period] = { ...pageCheckNotes(companyId, period), ...notes };
  }
}

function cancelCheckEdits() {
  checkEditJobs.forEach((job) => clearTimeout(job.timer));
  checkEditJobs.clear();
  updateInitialValueStatus();
  updateStepNavigation();
}

function queueCheckEdit(companyId, delay = 250, initial = false) {
  const previous = checkEditJobs.get(companyId);
  if (previous) clearTimeout(previous.timer);
  const job = { controller: modelController, period: periodValue(), rules: state.ruleOverrides,
    values: state.checkValues[companyId]?.[periodValue()], sourceValues: state.overrides[companyId],
    initial: initial || previous?.initial, scores: { ...state.indicatorScores[companyId] },
    indicatorValues: { ...state.importedIndicatorValues[companyId] } };
  const current = () => checkEditJobs.get(companyId) === job && modelController === job.controller && periodValue() === job.period;
  checkEditJobs.set(companyId, job);
  updateInitialValueStatus();
  updateStepNavigation();
  $("checkTransferStatus").textContent = "指标值已保存到当前页面，正在计算得分…";
  updateCheckScoreInputs(companyId);
  renderSummaryPanels();
  job.timer = setTimeout(async () => {
    let failed = false;
    try {
      const data = await postJson("/api/score-preview", { company_id: companyId, period: job.period, overrides: checkOverridesFromValues(companyId) });
      if (!current() || state.ruleOverrides !== job.rules || state.checkValues[companyId]?.[job.period] !== job.values || state.overrides[companyId] !== job.sourceValues) return;
      if (job.initial) {
        const previousDetails = new Map(nonCheckDetails(state.results[companyId]).map((item) => [item.indicator_id, item]));
        nonCheckDetails(data).forEach((item) => {
          const before = previousDetails.get(item.indicator_id);
          if (before?.score === item.score && before?.raw_value === item.raw_value) return;
          if (state.indicatorScores[companyId]?.[item.indicator_id] === job.scores[item.indicator_id]) delete state.indicatorScores[companyId]?.[item.indicator_id];
          if (state.importedIndicatorValues[companyId]?.[item.indicator_id] === job.indicatorValues[item.indicator_id]) delete state.importedIndicatorValues[companyId]?.[item.indicator_id];
        });
      }
      state.results[companyId] = data;
      checkEditJobs.delete(companyId);
      normalizeCheckInputs(companyId);
      updateCheckScoreInputs(companyId);
      applyOverridesToFieldMatrix();
      renderFieldTable();
      updateInitialInputs(companyId);
      renderSummaryPanels();
      refreshRatingTableView("initial");
      refreshRatingTableView("check");
    } catch (error) {
      if (current() && error.name !== "AbortError") {
        failed = true;
        job.error = error.message;
        updateCheckScoreInputs(companyId);
        renderSummaryPanels();
        $("checkTransferStatus").textContent = `重新计算失败：${error.message}。请重新编辑后重试，或重置为初始数据。`;
      }
    } finally {
      if (current() || (!failed && modelController === job.controller && periodValue() === job.period && !checkEditJobs.has(companyId))) {
        if (!failed) checkEditJobs.delete(companyId);
        updateInitialValueStatus();
        updateStepNavigation();
        if (!failed && !checkEditJobs.size && !checkTransfer) $("checkTransferStatus").textContent = checkScoreStatus(companyId) ? "部分公式无法计算，请检查指标值或修改得分。" : "指标值与得分已更新，仅当前页面生效。";
      }
    }
  }, delay);
}

function companyChecks(companyId, fields = state.samples.length ? checkFields(state.samples[0].company_id) : []) {
  const currentFields = new Map(checkFields(companyId).map((field) => [field.field_id, field]));
  return Object.fromEntries(fields.map((field) => {
    const currentField = currentFields.get(field.field_id) || { ...field, value: "", note: "" };
    return [field.field_id, {
      value: checkValue(companyId, currentField),
      score: effectiveCheckScore(companyId, currentField),
      score_overridden: Object.prototype.hasOwnProperty.call(pageCheckScores(companyId), field.field_id),
    }];
  }));
}

function checkPageData() {
  const fields = state.samples.length ? checkFields(state.samples[0].company_id) : [];
  return {
    fields: fields.map((field) => ({ field_id: field.field_id, label: field.label, expression: field.expression || "" })),
    rows: state.samples.map((company) => ({
      company_id: company.company_id,
      company_name: company.company_name,
      checks: companyChecks(company.company_id, fields),
    })),
  };
}

async function resetCheckData() {
  if (!state.samples.length || checkTransfer) return;
  cancelCheckEdits();
  const job = { kind: "reset", controller: modelController, period: periodValue() };
  const current = () => checkTransfer === job && modelController === job.controller && periodValue() === job.period;
  const ids = selectedCompanyIds();
  const overrides = Object.fromEntries(ids.map((id) => {
    const values = { ...(state.overrides[id] || {}) };
    checkFields(id).forEach((field) => { delete values[field.field_id]; });
    return [id, values];
  }));
  checkTransfer = job;
  clearTimeout(checkScoreTimer);
  checkPreviewVersion++;
  renderCheckMatrix();
  updateStepNavigation();
  $("checkTransferStatus").textContent = "正在读取数据库中的排查数据…";
  try {
    await api("/api/reload");
    if (!current()) return;
    const data = await postJson("/api/rules-preview", { company_ids: ids, period: job.period, overrides });
    if (!current()) return;
    ruleRevision++;
    ids.forEach((id) => {
      state.overrides[id] = overrides[id];
      if (state.checkValues[id]) delete state.checkValues[id][job.period];
      clearPageCheckScores(id, job.period);
      clearImportedCheckIndicators(id);
      if (state.checkNotes[id]) delete state.checkNotes[id][job.period];
    });
    state.results = data.results;
    state.fieldMatrix = data.field_matrix;
    state.checkView = { filters: {}, sort: null };
    applyOverridesToFieldMatrix();
    renderFieldTable();
    renderInitialMatrix();
    renderCheckMatrix();
    renderSummaryPanels();
    $("importChecksInput").value = "";
    $("checkTransferStatus").textContent = "已还原数据库中的排查数据。";
  } catch (error) {
    if (current() && error.name !== "AbortError") $("checkTransferStatus").textContent = `重置失败：${error.message}`;
  } finally {
    if (checkTransfer === job) {
      checkTransfer = null;
      renderCheckMatrix();
      updateStepNavigation();
    }
  }
}

async function exportChecksExcel() {
  if (!state.samples.length || checkTransfer) return;
  if (!checksReady()) return alert("排查得分尚未计算完成或存在异常，请完成后再导出。");
  const pageData = checkPageData();
  const job = { kind: "export", controller: modelController, period: periodValue() };
  checkTransfer = job;
  renderCheckMatrix();
  $("checkTransferStatus").textContent = "正在生成排查文件…";
  try {
    const { blob, filename } = await postDownload("/api/export-checks", { period: job.period, page_data: pageData });
    if (checkTransfer !== job || job.period !== periodValue()) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    $("checkTransferStatus").textContent = "排查文件已生成。";
  } catch (error) {
    if (checkTransfer === job && error.name !== "AbortError") $("checkTransferStatus").textContent = `导出失败：${error.message}`;
  } finally {
    if (checkTransfer === job) {
      checkTransfer = null;
      renderCheckMatrix();
    }
  }
}

async function importChecksExcel(file) {
  if (!file || !state.samples.length || checkTransfer) return;
  cancelCheckEdits();
  const job = { kind: "import", controller: modelController, period: periodValue() };
  const current = () => checkTransfer === job && modelController === job.controller && periodValue() === job.period;
  checkTransfer = job;
  renderCheckMatrix();
  updateStepNavigation();
  $("checkTransferStatus").textContent = "正在导入排查数据…";
  try {
    const data = await modelRequest(`/api/import-checks?period=${encodeURIComponent(job.period)}`, {
      method: "POST", headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, body: file,
    });
    if (!current()) return;
    const selected = new Set(selectedCompanyIds());
    const ids = new Set([...Object.keys(data.overrides || {}), ...Object.keys(data.scores || {})]);
    const rows = [...ids].filter((id) => selected.has(id)).map((id) => [id, data.overrides?.[id] || {}]);
    if (!rows.length) throw new Error("Excel中没有匹配当前已选样本的主体");
    const results = {};
    let cursor = 0;
    async function worker() {
      while (current() && cursor < rows.length) {
        const [id, values] = rows[cursor++];
        results[id] = await postJson("/api/score-preview", { company_id: id, period: job.period, overrides: checkOverridesFromValues(id, values) });
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    if (!current()) return;
    rows.forEach(([id, values]) => {
      if (!state.samples.some((company) => company.company_id === id)) return;
      savePageChecks(id, values, data.notes?.[id] || {}, job.period);
      state.results[id] = results[id];
      Object.entries(data.scores?.[id] || {}).forEach(([fieldId, score]) => {
        if (data.score_overrides?.[id]?.[fieldId] === true) savePageCheckScore(id, fieldId, score, job.period);
      });
    });
    renderCheckMatrix();
    renderSummaryPanels();
    $("checkTransferStatus").textContent = `导入完成，已回填 ${rows.length} 个主体的指标值与得分，仅当前页面生效，未写入数据库。`;
  } catch (error) {
    if (current() && error.name !== "AbortError") $("checkTransferStatus").textContent = `导入失败：${error.message}`;
  } finally {
    if (checkTransfer === job) {
      checkTransfer = null;
      $("importChecksInput").value = "";
      renderCheckMatrix();
      updateStepNavigation();
    }
  }
}

function checkValue(companyId, field) {
  const saved = pageCheckValues(companyId)[field.field_id];
  const value = saved !== undefined ? saved : field.value;
  return value ?? "";
}

function normalizeCheckInputs(companyId) {
  const fields = new Map(checkFields(companyId).map((field) => [field.field_id, field]));
  document.querySelectorAll("#checkRows .check-edit-input").forEach((input) => {
    if (input.dataset.companyId !== companyId || input.dataset.period !== periodValue() || input.value !== "") return;
    const field = fields.get(input.dataset.fieldId);
    if (!field) return;
    const value = checkValue(companyId, field);
    if (document.activeElement !== input) input.value = fieldDisplay(value, field);
  });
}

function checkNote(companyId, field) {
  return pageCheckNotes(companyId)[field.field_id] ?? field.note ?? "";
}

function checkOverridesFromValues(companyId, values = {}) {
  return { ...(state.overrides[companyId] || {}), ...pageCheckValues(companyId), ...values };
}

function checkTotalText(companyId) {
  if (checkEditJobs.has(companyId)) return null;
  const scores = Object.values(companyChecks(companyId)).map((check) => check.score);
  return scores.some((score) => score === null) ? null : sumRoundUp4(scores);
}

function checkTotal(companyId) {
  const score = checkTotalText(companyId);
  return score === null ? null : Number(score);
}

function finalScore(companyId) {
  const score = checkTotal(companyId);
  return score === null ? null : baseScore(companyId) + score;
}

function updateInitialValueStatus() {
  const status = $("initialValueStatus");
  if (!status) return;
  const jobs = [...checkEditJobs.values()].filter((job) => job.initial);
  if (!jobs.length && !status.textContent) return;
  status.textContent = jobs.some((job) => job.error) ? "计算失败，请重新修改指标值后重试。"
    : jobs.length ? "指标值已保存，正在重新计算赋分和得分…" : "指标值及评分已更新，仅当前页面生效。";
}

function saveInitialValue(companyId, fieldId, value) {
  state.overrides[companyId] = { ...state.overrides[companyId], [fieldId]: value };
  nonCheckDetails(state.results[companyId]).forEach((indicator) => {
    if (indicator.field_id !== fieldId) return;
    delete state.indicatorScores[companyId]?.[indicator.indicator_id];
    delete state.importedIndicatorValues[companyId]?.[indicator.indicator_id];
  });
  applyOverridesToFieldMatrix();
}

function updateInitialInputs(companyId) {
  const details = new Map(nonCheckDetails(state.results[companyId]).map((indicator) => [indicator.indicator_id, indicator]));
  for (const selector of [".indicator-value-input", ".assign-input", ".weighted-input"]) {
    document.querySelectorAll(`#initialRows ${selector}`).forEach((input) => {
      if (input.dataset.companyId !== companyId) return;
      const indicator = details.get(input.dataset.indicatorId);
      if (!indicator) return;
      const manual = Object.prototype.hasOwnProperty.call(state.indicatorScores[companyId] || {}, indicator.indicator_id);
      if (document.activeElement === input && (selector === ".indicator-value-input" || manual)) return;
      input.value = selector === ".indicator-value-input" ? indicatorRawDisplay(indicator, companyId)
        : selector === ".assign-input" ? fmt(indicatorScore(companyId, indicator).score) : fmt(indicatorWeightedExact(companyId, indicator));
    });
  }
  document.querySelectorAll(".base-total").forEach((element) => {
    if (element.dataset.companyId === companyId) element.textContent = baseScoreText(companyId);
  });
  document.querySelectorAll(".base-grade").forEach((element) => {
    if (element.dataset.companyId === companyId) element.innerHTML = gradeMarkup(baseScore(companyId));
  });
}

function bindInitialInputs() {
  document.querySelectorAll(".indicator-value-input").forEach((input) => {
    input.oninput = () => {
      if (input.dataset.period !== periodValue() || checkTransfer) return;
      saveInitialValue(input.dataset.companyId, input.dataset.fieldId, input.value);
      input.classList.add("edited-cell");
      queueCheckEdit(input.dataset.companyId, 250, true);
    };
    input.onchange = () => {
      if (input.dataset.period !== periodValue() || checkTransfer) return;
      const indicator = findIndicator(input.dataset.companyId, input.dataset.indicatorId);
      if (indicator) input.value = indicatorRawDisplay(indicator, input.dataset.companyId);
      queueCheckEdit(input.dataset.companyId, 0, true);
    };
  });
  document.querySelectorAll(".assign-input").forEach((input) => {
    input.oninput = () => {
      const weight = num(input.dataset.weight);
      const indicator = findIndicator(input.dataset.companyId, input.dataset.indicatorId);
      const score = clampScore(input.value, indicator || {});
      const weighted = weight === 0 ? score : score * weight;
      const exact = weight === 0 ? String(score) : decimalProduct([score, weight]);
      const weightedInput = input.closest("td").nextElementSibling.querySelector(".weighted-input");
      weightedInput.value = fmt(exact);
      setIndicatorScore(input.dataset.companyId, input.dataset.indicatorId, score, weighted, exact);
      updateTotals(input.dataset.companyId);
    };
    input.onchange = () => { input.value = fmt(indicatorScore(input.dataset.companyId, findIndicator(input.dataset.companyId, input.dataset.indicatorId)).score); };
  });
  document.querySelectorAll(".weighted-input").forEach((input) => {
    input.oninput = () => {
      const weight = num(input.dataset.weight);
      const weighted = num(input.value);
      const indicator = findIndicator(input.dataset.companyId, input.dataset.indicatorId);
      const proposed = weight === 0 ? weighted : weighted / weight;
      const score = clampScore(proposed, indicator || {});
      const clampedWeighted = weight === 0 ? score : score * weight;
      const assignInput = input.closest("td").previousElementSibling.querySelector(".assign-input");
      const exact = score === proposed ? String(weighted) : weight === 0 ? String(score) : decimalProduct([score, weight]);
      assignInput.value = fmt(score);
      setIndicatorScore(input.dataset.companyId, input.dataset.indicatorId, score, clampedWeighted, exact);
      updateTotals(input.dataset.companyId);
    };
    input.onchange = () => { input.value = fmt(indicatorWeightedExact(input.dataset.companyId, findIndicator(input.dataset.companyId, input.dataset.indicatorId))); };
  });
}

function updateTotals(companyId) {
  const base = baseScore(companyId);
  document.querySelectorAll(`.base-total[data-company-id="${CSS.escape(companyId)}"]`).forEach((el) => (el.textContent = baseScoreText(companyId)));
  document.querySelectorAll(`.base-grade[data-company-id="${CSS.escape(companyId)}"]`).forEach((el) => (el.innerHTML = gradeMarkup(base)));
  renderSummaryPanels();
  if (state.step === 3) renderCheckMatrix();
}

function renderInitialMatrix() {
  closeTableFilterPopover("initial");
  const data = initialTableData(), { indicators } = data;
  const rows = tableDisplayRows("initial", data);
  renderTableViewStatus("initial", rows.length, data.rows.length);
  $("initialHead").innerHTML = `
    <tr>
      <th rowspan="3" class="sticky-col seq-col">序号</th>
      <th rowspan="3" class="sticky-col name-col field-filter-header">主体名称${fieldFilterButton("company:company_name", "主体名称", "initial")}</th>
      <th rowspan="3" class="field-filter-header">初评得分${fieldFilterButton("summary:base_score", "初评得分", "initial")}</th>
      <th rowspan="3" class="field-filter-header">初评等级${fieldFilterButton("summary:base_grade", "初评等级", "initial")}</th>
      ${indicators.map((ind) => `<th colspan="3">${ratingColumnButton("initial", ind.indicator_id, ind.label)}</th>`).join("")}
    </tr>
    <tr>
      ${indicators.map((ind) => `<th colspan="3">权重：${fmt(decimalProduct([ind.weight || 0, 100]))}%</th>`).join("")}
    </tr>
    <tr>
      ${indicators.map((ind) => ["value", "score", "weighted"].map((kind, index) => `<th class="field-filter-header">${["指标值", "赋分", "得分"][index]}${fieldFilterButton(`indicator-${kind}:${ind.indicator_id}`, `${ind.label} · ${["指标值", "赋分", "得分"][index]}`, "initial")}</th>`).join("")).join("")}
    </tr>
  `;
  $("initialRows").innerHTML = rows.map(({ company, index, result, indicators: details }) => {
    const total = baseScore(company.company_id);
    return `
      <tr data-company-id="${esc(company.company_id)}">
        <td class="sticky-col seq-col">${index + 1}</td>
        <td class="sticky-col name-col" title="${esc(company.company_name)}">${esc(company.company_name)}</td>
        <td class="base-total" data-company-id="${esc(company.company_id)}">${result ? baseScoreText(company.company_id) : "待计算"}</td>
        <td class="base-grade" data-company-id="${esc(company.company_id)}">${result ? gradeMarkup(total) : "待计算"}</td>
        ${indicators.map((indicator) => {
          const ind = details.get(indicator.indicator_id);
          if (!ind) return "<td></td><td></td><td></td>";
          const score = indicatorScore(company.company_id, ind);
          const minAttr = ind.score_min !== null && ind.score_min !== undefined && ind.score_min !== "" ? ` min="${esc(ind.score_min)}"` : "";
          const maxAttr = ind.score_max !== null && ind.score_max !== undefined && ind.score_max !== "" ? ` max="${esc(ind.score_max)}"` : "";
          return `<td><input class="matrix-input indicator-value-input${Object.prototype.hasOwnProperty.call(state.overrides[company.company_id] || {}, ind.field_id) ? " edited-cell" : ""}" type="text" data-company-id="${esc(company.company_id)}" data-indicator-id="${esc(ind.indicator_id)}" data-field-id="${esc(ind.field_id)}" data-period="${esc(periodValue())}" aria-label="${esc(company.company_name)} ${esc(ind.label)} 指标值" value="${esc(indicatorRawDisplay(ind, company.company_id))}"></td>
            <td><input type="number" class="matrix-input assign-input" data-company-id="${esc(company.company_id)}" data-indicator-id="${esc(ind.indicator_id)}" data-weight="${esc(ind.weight)}" value="${esc(fmt(score.score))}"${minAttr}${maxAttr}></td>
            <td><input class="matrix-input weighted-input" data-company-id="${esc(company.company_id)}" data-indicator-id="${esc(ind.indicator_id)}" data-weight="${esc(ind.weight)}" value="${esc(fmt(indicatorWeightedExact(company.company_id, ind)))}"></td>`;
        }).join("")}
      </tr>
    `;
  }).join("") || `<tr><td colspan="${4 + indicators.length * 3}" class="empty">${data.rows.length ? "暂无符合筛选条件的数据，可清除筛选后查看全部公司。" : "暂无结果"}</td></tr>`;
  bindInitialInputs();
  bindTableFilterButtons("initial");
}

function resultRows() {
  return state.samples.map((company, index) => {
    const result = state.results[company.company_id];
    return { index, company, result };
  });
}

function renderCheckMatrix() {
  closeTableFilterPopover("check");
  const data = checkTableData(), { fields } = data;
  const rows = tableDisplayRows("check", data);
  renderTableViewStatus("check", rows.length, data.rows.length);
  const hasChecks = state.samples.some((company) => checkFields(company.company_id).length);
  $("resetChecksBtn").disabled = !hasChecks || !!checkTransfer;
  $("exportChecksBtn").disabled = !hasChecks || !!checkTransfer || !checksReady();
  $("importChecksBtn").disabled = !hasChecks || !!checkTransfer;
  $("checkHead").innerHTML = `
    <tr>
      <th rowspan="2" class="sticky-col seq-col">序号</th>
      <th rowspan="2" class="sticky-col name-col field-filter-header">主体名称${fieldFilterButton("company:company_name", "主体名称", "check")}</th>
      ${fields.map((field) => `<th colspan="2" data-check-field="${esc(field.field_id)}" title="${esc(field.expression)}">${ratingColumnButton("check", field.field_id, field.label)}</th>`).join("")}
    </tr>
    <tr>
      ${fields.map((field) => ["value", "score"].map((kind) => `<th class="field-filter-header">${kind === "value" ? "指标值" : "得分"}${fieldFilterButton(`check-${kind}:${field.field_id}`, `${field.label} · ${kind === "value" ? "指标值" : "得分"}`, "check")}</th>`).join("")).join("")}
    </tr>
  `;
  $("checkRows").innerHTML = rows.map((company) => {
    return `
      <tr data-company-id="${esc(company.company_id)}">
        <td class="sticky-col seq-col">${company.index + 1}</td>
        <td class="sticky-col name-col" title="${esc(company.company_name)}"><div class="check-company"><span>${esc(company.company_name)}</span></div></td>
        ${fields.map((field) => {
          const check = company.checks[field.field_id];
          return `<td class="check-value-cell" data-check-value="${esc(field.field_id)}"><input class="check-edit-input" type="text" data-company-id="${esc(company.company_id)}" data-field-id="${esc(field.field_id)}" data-period="${esc(periodValue())}" aria-label="${esc(company.company_name)} ${esc(field.label)} 指标值" value="${esc(fieldDisplay(check.value, field))}" ${checkTransfer ? "disabled" : ""}></td>
            <td><input class="check-score-edit-input${check.score_overridden ? " edited-cell" : ""}" type="text" inputmode="decimal" data-company-id="${esc(company.company_id)}" data-field-id="${esc(field.field_id)}" data-period="${esc(periodValue())}" aria-label="${esc(company.company_name)} ${esc(field.label)} 得分" value="${esc(fmt(check.score))}" ${checkTransfer ? "disabled" : ""}></td>`;
        }).join("")}
      </tr>
    `;
  }).join("") || `<tr><td colspan="${2 + fields.length * 2}" class="empty">${data.rows.length ? "暂无符合筛选条件的数据，可清除筛选后查看全部公司。" : "暂无排查结果"}</td></tr>`;
  $("checkRows").querySelectorAll(".check-edit-input").forEach((input) => {
    input.oninput = () => {
      if (input.dataset.period !== periodValue() || checkTransfer) return;
      savePageChecks(input.dataset.companyId, { [input.dataset.fieldId]: input.value });
      input.classList.add("edited-cell");
      queueCheckEdit(input.dataset.companyId);
    };
    input.onchange = () => {
      if (input.dataset.period === periodValue() && !checkTransfer) {
        const field = checkFields(input.dataset.companyId).find((item) => item.field_id === input.dataset.fieldId);
        if (field) {
          input.value = fieldDisplay(checkValue(input.dataset.companyId, field), field);
        }
        queueCheckEdit(input.dataset.companyId, 0);
      }
    };
  });
  $("checkRows").querySelectorAll(".check-score-edit-input").forEach((input) => {
    input.oninput = () => {
      if (input.dataset.period !== periodValue() || checkTransfer) return;
      savePageCheckScore(input.dataset.companyId, input.dataset.fieldId, input.value);
      input.classList.add("edited-cell");
      input.setAttribute("aria-invalid", String(numericCheckScore(input.value) === null));
      input.title = numericCheckScore(input.value) === null ? "请输入有效数字" : "手动得分；再次修改指标值后按公式重新计算";
      updateStepNavigation();
      $("exportChecksBtn").disabled = !checksReady();
      renderSummaryPanels();
    };
    input.onchange = () => {
      if (input.dataset.period === periodValue() && !checkTransfer) {
        const score = pageCheckScores(input.dataset.companyId)[input.dataset.fieldId];
        input.value = fmt(score);
      }
    };
  });
  state.samples.forEach((company) => updateCheckScoreInputs(company.company_id));
  bindTableFilterButtons("check");
}

function updateCheckScoreInputs(companyId) {
  const fields = new Map(checkFields(companyId).map((field) => [field.field_id, field]));
  document.querySelectorAll("#checkRows .check-score-edit-input").forEach((input) => {
    if (input.dataset.companyId !== companyId || input.dataset.period !== periodValue()) return;
    const field = fields.get(input.dataset.fieldId);
    if (!field) return;
    const score = effectiveCheckScore(companyId, field);
    const overridden = Object.prototype.hasOwnProperty.call(pageCheckScores(companyId), field.field_id);
    if (document.activeElement !== input || !overridden) input.value = fmt(score);
    input.classList.toggle("edited-cell", overridden);
    const job = checkEditJobs.get(companyId);
    const pending = job && !job.error && !overridden;
    input.placeholder = pending ? "计算中…" : score === null ? "计算异常" : "";
    input.setAttribute("aria-invalid", String(score === null && !pending));
    input.title = overridden ? "手动得分；再次修改指标值后按公式重新计算"
      : score === null ? (pending ? "正在按公式计算" : field.score_error || job?.error || "公式无法得到有效数值，可修改指标值或直接输入得分")
      : field.expression ? `公式：${field.expression}` : "按指标值直接计分";
  });
  $("exportChecksBtn").disabled = !state.samples.length || !!checkTransfer || !checksReady();
}

function openCheckModal(companyId) {
  clearTimeout(checkScoreTimer);
  checkPreviewVersion++;
  state.checkModalCompanyId = companyId;
  const company = state.samples.find((x) => x.company_id === companyId);
  const fields = checkFields(companyId);
  $("checkModalTitle").textContent = `排查项录入：${company?.company_name || ""}`;
  $("checkModalStatus").textContent = "";
  $("checkModalSave").disabled = false;
  $("checkModalFields").innerHTML = fields.map((field) => `
    <div class="check-modal-row">
      <div>
        <strong>${esc(field.label)}</strong>
        <em>${esc(field.field_label || field.label)}</em>
      </div>
      <label>指标值<input class="check-value-input" aria-label="${esc(field.label)} 指标值" data-field-id="${esc(field.field_id)}" data-initial-value="${esc(fieldDisplay(checkValue(companyId, field), field))}" value="${esc(fieldDisplay(checkValue(companyId, field), field))}"></label>
      <label>得分<input class="check-score-input" inputmode="decimal" aria-label="${esc(field.label)} 得分" data-field-id="${esc(field.field_id)}" data-overridden="${Object.prototype.hasOwnProperty.call(pageCheckScores(companyId), field.field_id)}" value="${esc(fmt(effectiveCheckScore(companyId, field)))}"></label>
    </div>
  `).join("") || `<div class="empty">暂无排查项</div>`;
  $("checkModal").classList.remove("hidden");
  bindCheckModalInputs();
}

function bindCheckModalInputs() {
  $("checkModalFields").querySelectorAll(".check-value-input").forEach((input) => {
    input.oninput = () => {
      checkPreviewVersion++;
      clearTimeout(checkScoreTimer);
      $("checkModalSave").disabled = true;
      $("checkModalFields").querySelectorAll(".check-score-input").forEach((scoreInput) => {
        if (scoreInput.dataset.fieldId === input.dataset.fieldId) scoreInput.dataset.overridden = "false";
        if (scoreInput.dataset.overridden !== "true") {
          scoreInput.value = "";
          scoreInput.placeholder = "计算中…";
        }
      });
      checkScoreTimer = setTimeout(() => recalculateCheckModalScores().catch((error) => {
        if (error.name !== "AbortError") {
          $("checkModalStatus").textContent = `计算失败：${error.message}`;
          $("checkModalFields").querySelectorAll(".check-score-input").forEach((scoreInput) => { scoreInput.placeholder = "计算异常"; });
        }
      }), 220);
    };
  });
  $("checkModalFields").querySelectorAll(".check-score-input").forEach((input) => {
    input.oninput = () => {
      input.dataset.overridden = "true";
      input.setAttribute("aria-invalid", String(numericCheckScore(input.value) === null));
    };
  });
}

function checkFieldScore(result, fieldId) {
  const field = (result?.check_fields || []).find((item) => item.field_id === fieldId);
  return field ? (Object.prototype.hasOwnProperty.call(field, "score") ? numericCheckScore(field.score) : field.expression ? null : numericCheckScore(field.value)) : null;
}

function checkModalDraft() {
  const values = {};
  $("checkModalFields").querySelectorAll(".check-value-input").forEach((input) => {
    if (input.value !== input.dataset.initialValue) values[input.dataset.fieldId] = input.value;
  });
  return values;
}

async function recalculateCheckModalScores() {
  const companyId = state.checkModalCompanyId;
  const version = checkPreviewVersion;
  const controller = modelController;
  const period = periodValue();
  const data = await postJson("/api/score-preview", {
    company_id: companyId,
    period,
    overrides: checkOverridesFromValues(companyId, checkModalDraft()),
  });
  if (version !== checkPreviewVersion || controller !== modelController || period !== periodValue() || companyId !== state.checkModalCompanyId || $("checkModal").classList.contains("hidden")) return;
  $("checkModalFields").querySelectorAll(".check-score-input").forEach((input) => {
    if (input.dataset.overridden !== "true") input.value = fmt(checkFieldScore(data, input.dataset.fieldId));
    input.placeholder = numericCheckScore(input.value) === null ? "计算异常" : "";
  });
  $("checkModalSave").disabled = false;
  $("checkModalStatus").textContent = "指标值变化后已按公式重新计算，可直接修改得分。";
}

async function saveCheckScores() {
  clearTimeout(checkScoreTimer);
  const version = ++checkPreviewVersion;
  const companyId = state.checkModalCompanyId;
  const controller = modelController;
  const period = periodValue();
  const values = checkModalDraft();
  const scores = Object.fromEntries([...$("checkModalFields").querySelectorAll('.check-score-input')]
    .filter((input) => input.dataset.overridden === "true").map((input) => [input.dataset.fieldId, input.value]));
  $("checkModalSave").disabled = true;
  $("checkModalFields").querySelectorAll("input,textarea").forEach((input) => { input.disabled = true; });
  $("checkModalStatus").textContent = "正在保存页面数据…";
  try {
    const data = await postJson("/api/score-preview", { company_id: companyId, period, overrides: checkOverridesFromValues(companyId, values) });
    if (version !== checkPreviewVersion || controller !== modelController || period !== periodValue() || companyId !== state.checkModalCompanyId || $("checkModal").classList.contains("hidden")) return;
    savePageChecks(companyId, values);
    state.results[companyId] = data;
    Object.entries(scores).forEach(([fieldId, score]) => savePageCheckScore(companyId, fieldId, score));
    $("checkModal").classList.add("hidden");
    renderCheckMatrix();
    renderSummaryPanels();
  } catch (error) {
    if (error.name !== "AbortError") $("checkModalStatus").textContent = `保存失败：${error.message}`;
  } finally {
    if (version === checkPreviewVersion) {
      $("checkModalSave").disabled = false;
      $("checkModalFields").querySelectorAll("input,textarea").forEach((input) => { input.disabled = false; });
    }
  }
}

function finalSummaryRows() {
  return resultRows().map(({ index, company, result }) => ({
    index: index + 1, company_id: company.company_id, company_name: company.company_name,
    bond_id: company.bond_id || "", original_grade: result?.original_grade ?? "",
    base_score: result ? baseScoreText(company.company_id) : "待计算",
    check_score: result ? checkTotalText(company.company_id) ?? checkScoreStatus(company.company_id) : "待计算",
    final_score: result ? finalScoreText(company.company_id) ?? checkScoreStatus(company.company_id) : "待计算",
    base_grade: result ? gradeForScore(baseScore(company.company_id)) || "等级匹配异常" : "待计算",
    final_grade: result ? (checkScoreStatus(company.company_id) || gradeForScore(finalScore(company.company_id)) || "等级匹配异常") : "待计算",
    manual: "自动", conclusion: "按当前指标数据生成",
  }));
}

function finalPageData() {
  if (!checksReady()) throw new Error("排查得分尚未计算完成或存在异常，请完成后再导出。");
  return {
    period: periodValue(),
    grade_rules: state.gradeRules || GradeRules.fromGrades(state.model?.grades || []),
    rows: finalSummaryRows().map((summary) => {
      const id = summary.company_id;
      const matrixRow = state.fieldMatrix.rows.find((row) => row.company.company_id === id);
      if (!matrixRow || !state.results[id]) throw new Error("页面数据尚未加载完成，请稍后重试。");
      return { ...summary,
        source_values: { ...matrixRow.values, ...checkOverridesFromValues(id) },
        indicator_values: indicatorDisplayValues(id, matrixRow),
        indicators: Object.fromEntries(nonCheckDetails(state.results[id]).map((indicator) => [indicator.indicator_id,
          { raw_value: indicatorRawDisplay(indicator, id), score: fmt(indicatorScore(id, indicator).score), weighted: fmt(indicatorWeightedExact(id, indicator)) }])),
        checks: companyChecks(id),
      };
    }),
  };
}

async function exportFinalExcel() {
  if (!state.samples.length) return alert("请先选择样本。");
  if (!checksReady() || checkTransfer) return alert("排查得分尚未计算完成或存在异常，请完成后再导出。");
  const button = $("exportFinalBtn");
  const controller = modelController;
  button.disabled = true;
  $("finalExportStatus").textContent = "正在生成数据文件…";
  try {
    const pageData = finalPageData();
    const { blob, filename } = await postDownload("/api/export-final", { page_data: pageData, rules: state.ruleOverrides });
    if (controller !== modelController || pageData.period !== periodValue()) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    $("finalExportStatus").textContent = "已生成包含 7 个工作表的数据文件。";
  } catch (error) {
    if (error.name !== "AbortError") $("finalExportStatus").textContent = `导出失败：${error.message}`;
  } finally { button.disabled = false; }
}

function renderSummaryPanels() {
  closeTableFilterPopover("final");
  $("exportFinalBtn").disabled = !checksReady() || !!checkTransfer;
  const data = finalTableData(), rows = tableDisplayRows("final", data);
  renderTableViewStatus("final", rows.length, data.rows.length);
  if ($("finalHead")) $("finalHead").innerHTML = `<tr><th>行编号</th>${data.columns.map((column) => `<th class="field-filter-header">${column.label}${fieldFilterButton(column.key, column.label, "final")}</th>`).join("")}</tr>`;
  $("finalRows").innerHTML = rows.map((row) => `
    <tr data-company-id="${esc(row.company_id)}">
      <td>${row.index}</td><td>${esc(row.company_name)}</td><td>${esc(row.bond_id)}</td>
      <td>${esc(row.base_score)}</td><td>${esc(row.check_score)}</td><td>${esc(row.final_score)}</td>
      <td>${row.base_grade === "等级匹配异常" ? '<span class="grade-error">等级匹配异常</span>' : esc(row.base_grade)}</td>
      <td>${row.final_grade === "等级匹配异常" ? '<span class="grade-error">等级匹配异常</span>' : esc(row.final_grade)}</td>
      <td>${row.manual}</td><td>${row.conclusion}</td>
    </tr>
  `).join("") || `<tr><td colspan="10" class="empty">${data.rows.length ? "暂无符合筛选条件的数据，可清除筛选后查看全部公司。" : "暂无最终定级"}</td></tr>`;
  bindTableFilterButtons("final");
}

function wireEvents() {
  $("exportFinalBtn").onclick = exportFinalExcel;
  $("gradeRulesBtn").onclick = () => openGradeRules();
  $("gradeRulesReload").onclick = () => openGradeRules(true);
  $("gradeRulesClose").onclick = () => { gradeOpenVersion++; gradeRuleDraft = null; $("gradeRulesModal").classList.add("hidden"); };
  $("gradeRulesSave").onclick = () => saveGradeRules();
  $("scoringRulesBtn").onclick = openScoringRules;
  $("rulesClose").onclick = () => { ruleDraft = null; $("rulesModal").classList.add("hidden"); };
  $("rulesSave").onclick = () => saveScoringRules();
  $("selectDataSourceBtn").onclick = selectDataSource;
  $("dataSourceForm").onsubmit = submitDataSource;
  $("dataSourceBrowse").onclick = () => {
    if (dataSourceBusy) return;
    setDataSourceBrowseMenu($("dataSourceBrowseOptions").hidden);
    if (!$("dataSourceBrowseOptions").hidden) $("dataSourceBrowseDirectory").focus();
  };
  $("dataSourceBrowseDirectory").onclick = () => browseDataSource("directory");
  $("dataSourceBrowseFile").onclick = () => browseDataSource("file");
  $("dataSourceBrowseOptions").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setDataSourceBrowseMenu(false);
    $("dataSourceBrowse").focus();
  });
  $("dataSourceCancel").onclick = () => {
    if (dataSourceBusy) return;
    setDataSourceBrowseMenu(false);
    $("dataSourceModal").close();
  };
  $("dataSourceModal").addEventListener("cancel", (event) => {
    if (dataSourceBusy || !$("dataSourceBrowseOptions").hidden) event.preventDefault();
    if (!dataSourceBusy) setDataSourceBrowseMenu(false);
  });
  $("modelSelect").onchange = (event) => switchModel(event.target.value);
  window.addEventListener("unhandledrejection", (event) => {
    if (event.reason?.name === "AbortError") event.preventDefault();
  });
  window.addEventListener("focus", refreshGradesOnFocus);
  $("searchInput").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    state.companies = [];
    renderCompanySuggest("正在搜索公司…");
    searchTimer = setTimeout(() => loadCompanies(event.target.value), 160);
  });
  $("searchInput").addEventListener("focus", (event) => loadCompanies(event.target.value));
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search-box")) $("companySuggest").classList.add("hidden");
    if (!event.target.closest(".data-source-browse")) setDataSourceBrowseMenu(false);
  });
  $("sampleFilter").addEventListener("input", () => {
    state.checkedSamples.clear();
    renderSamples();
  });
  $("deleteSelectedBtn").onclick = () => removeSamples([...state.checkedSamples]);
  $("sampleRows").addEventListener("click", (event) => {
    const button = event.target.closest(".remove-sample");
    if (button) removeSamples([button.dataset.id]);
  });
  $("sampleRows").addEventListener("change", (event) => {
    if (!event.target.matches(".sample-check")) return;
    if (event.target.checked) state.checkedSamples.add(event.target.dataset.id);
    else state.checkedSamples.delete(event.target.dataset.id);
    updateSampleChecks();
  });
  $("checkAll").onchange = (event) => {
    $("sampleRows").querySelectorAll(".sample-check").forEach((item) => {
      item.checked = event.target.checked;
      if (item.checked) state.checkedSamples.add(item.dataset.id);
      else state.checkedSamples.delete(item.dataset.id);
    });
    updateSampleChecks();
  };
  $("yearSelect").onchange = () => {
    closeFieldFilterPopover();
    resetTableViews();
    closeFieldColumnModal(true);
    closeRatingColumnModal(true);
    cancelCheckEdits();
    checkTransfer = null;
    cancelBulkSelection();
    state.overrides = {};
    state.importedIndicatorValues = {};
    state.indicatorScores = {};
    renderCheckMatrix();
    refreshScores().then(refreshFieldMatrix).then(renderInitialMatrix).then(renderCheckMatrix);
  };
  $("reportSelect").onchange = () => {
    closeFieldFilterPopover();
    resetTableViews();
    closeFieldColumnModal(true);
    closeRatingColumnModal(true);
    cancelCheckEdits();
    checkTransfer = null;
    cancelBulkSelection();
    state.overrides = {};
    state.importedIndicatorValues = {};
    state.indicatorScores = {};
    renderCheckMatrix();
    refreshScores().then(refreshFieldMatrix).then(renderInitialMatrix).then(renderCheckMatrix);
  };
  $("resetCurrentBtn").onclick = resetToDatabaseValues;
  $("exportFieldsBtn").onclick = exportFieldsExcel;
  $("importFieldsBtn").onclick = () => $("importFieldsInput").click();
  $("toggleIndicatorsBtn").onclick = () => {
    state.showIndicators = !state.showIndicators;
    renderFieldTable();
  };
  $("importFieldsInput").onchange = (event) => importFieldsExcel(event.target.files[0]);
  $("exportChecksBtn").onclick = exportChecksExcel;
  $("resetChecksBtn").onclick = resetCheckData;
  $("importChecksBtn").onclick = () => $("importChecksInput").click();
  $("importChecksInput").onchange = (event) => importChecksExcel(event.target.files[0]);
  $("prevBtn").onclick = () => setStep(state.step - 1);
  $("nextBtn").onclick = () => setStep(state.step + 1, true);
  $("modalClose").onclick = () => $("fieldModal").classList.add("hidden");
  $("modalSave").onclick = saveModalFields;
  ["field", "initial", "check", "final"].forEach((table) => {
    $(`clear${table[0].toUpperCase() + table.slice(1)}ViewBtn`).onclick = () => clearFieldTableView(table);
  });
  ["initial", "check"].forEach((table) => {
    $(`${table}Rows`).addEventListener("focusout", () => setTimeout(() => refreshRatingTableView(table), 0));
  });
  $("fieldFilterSearch").oninput = renderFieldFilterOptions;
  $("fieldFilterAll").onchange = (event) => chooseFieldFilterValues("all", event.target.checked);
  $("fieldFilterInvert").onclick = () => chooseFieldFilterValues("invert");
  $("fieldFilterDuplicates").onclick = () => chooseFieldFilterValues("duplicates");
  $("fieldFilterUnique").onclick = () => chooseFieldFilterValues("unique");
  $("fieldFilterApply").onclick = applyFieldFilter;
  $("fieldFilterCancel").onclick = () => closeFieldFilterPopover(true);
  $("fieldFilterClose").onclick = () => closeFieldFilterPopover(true);
  $("fieldFilterClear").onclick = () => {
    if (!fieldFilterDraft) return;
    const { table, key } = fieldFilterDraft;
    delete tableViewState(table).filters[key];
    closeFieldFilterPopover();
    renderTableView(table);
  };
  document.querySelectorAll("[data-field-sort]").forEach((button) => { button.onclick = () => sortFieldTable(button.dataset.fieldSort); });
  $("fieldFilterPopover").addEventListener("toggle", () => {
    if (!$("fieldFilterPopover").matches(":popover-open")) closeFieldFilterPopover();
  });
  $("fieldFilterPopover").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeFieldFilterPopover(true); }
  });
  window.addEventListener("resize", positionFieldFilterPopover);
  window.addEventListener("resize", ensureCurrentStepVisible);
  window.addEventListener("scroll", (event) => {
    if (fieldFilterDraft && !$("fieldFilterPopover").contains(event.target)) positionFieldFilterPopover();
  }, true);
  $("fieldColumnForm").onsubmit = (event) => { event.preventDefault(); saveFieldColumn(); };
  $("fieldColumnClose").onclick = () => closeFieldColumnModal();
  $("fieldColumnCancel").onclick = () => closeFieldColumnModal();
  $("fieldColumnModal").addEventListener("cancel", (event) => { event.preventDefault(); closeFieldColumnModal(); });
  ["initialHead", "checkHead"].forEach((id) => {
    $(id).addEventListener("click", (event) => {
      const button = event.target.closest(".rating-column-edit");
      if (button) openRatingColumnModal(button.dataset.editTable, button.dataset.editKey);
    });
  });
  $("ratingColumnForm").onsubmit = (event) => { event.preventDefault(); saveRatingColumn(); };
  $("ratingColumnClose").onclick = () => closeRatingColumnModal();
  $("ratingColumnCancel").onclick = () => closeRatingColumnModal();
  $("ratingColumnModal").addEventListener("cancel", (event) => { event.preventDefault(); closeRatingColumnModal(); });
  $("checkModalClose").onclick = () => {
    clearTimeout(checkScoreTimer);
    checkPreviewVersion++;
    $("checkModal").classList.add("hidden");
  };
  $("checkModalSave").onclick = saveCheckScores;
  document.querySelectorAll(".step").forEach((btn) => (btn.onclick = () => setStep(Number(btn.dataset.step))));
}

function init() {
  initSelectControls();
  $("todayText").textContent = new Date().toISOString().slice(0, 10);
  wireEvents();
  renderSamples();
  renderFieldTable();
  renderInitialMatrix();
  renderCheckMatrix();
  setStep(0);
  loadModels();
}

init();
