/* Grade intervals are page-local and share each adjacent boundary. */
(() => {
  function clone(model) {
    return { grades: [...model.grades], boundaries: [...model.boundaries] };
  }

  function fromGrades(grades) {
    const rows = grades.filter((row) => row.status === "打分映射" && String(row.inclusive) === "1")
      .map((row) => ({ grade: row.grade, left: row.threshold === null || row.threshold === undefined || row.threshold === "" ? -99999 : Number(row.threshold) }))
      .sort((a, b) => a.left - b.left);
    return { grades: rows.map((row) => row.grade), boundaries: rows.length ? [...rows.map((row) => row.left), 99999] : [] };
  }

  function number(value) {
    if (value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(Number(value))) {
      throw new Error("边界值必须是有效数字，不能为空。");
    }
    return Number(value);
  }

  function validate(model) {
    if (!model.grades.length || model.boundaries.length !== model.grades.length + 1) throw new Error("至少需要保留一个等级区间。");
    model.boundaries.forEach((value, index) => {
      number(value);
      if (index && !(model.boundaries[index - 1] < value)) {
        throw new Error(`修改不规范：${model.grades[index - 1]} 的左边界必须小于右边界，相邻区间不能交叉或为空。`);
      }
    });
    return model;
  }

  function withBounds(model, index, left, right) {
    const next = clone(model);
    next.boundaries[index] = number(left);
    next.boundaries[index + 1] = number(right);
    return validate(next);
  }

  function remove(model, index) {
    if (model.grades.length <= 1) throw new Error("至少需要保留一个等级区间，不能删除最后一行。");
    const next = clone(model);
    next.grades.splice(index, 1);
    next.boundaries.splice(index === 0 ? 1 : index, 1);
    return validate(next);
  }

  function gradeForScore(model, score) {
    const index = model.grades.findIndex((grade, i) => score >= model.boundaries[i] &&
      (score < model.boundaries[i + 1] || (i === model.grades.length - 1 && score === model.boundaries[i + 1])));
    return index < 0 ? null : model.grades[index];
  }

  const api = { clone, fromGrades, validate, withBounds, remove, gradeForScore };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.GradeRules = api;
})();
