/* Sorting and checkbox filtering change the table view, never its source rows. */
(() => {
  const precision = typeof module !== "undefined" && module.exports ? require('./number-format.js') : window.NumberFormat;
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

  function key(label) {
    return label === null || label === undefined || String(label).trim() === '' ? '' : String(label);
  }

  function compare(left, right, direction = 'asc') {
    const a = key(left.label), b = key(right.label);
    if (a === '' || b === '') return a === b ? 0 : a === '' ? 1 : -1;
    const numeric = left.numeric && right.numeric ? precision.compareNumbers(left.value, right.value) : null;
    return (numeric ?? collator.compare(a, b)) * (direction === 'desc' ? -1 : 1);
  }

  function apply(rows, filters, sort, read, except = '') {
    const selections = Object.entries(filters || {}).filter(([column]) => column !== except)
      .map(([column, values]) => [column, new Set(values)]);
    const result = rows.filter(row => selections.every(([column, values]) => values.has(key(read(row, column).label))));
    if (!sort) return result;
    return result.map((row, index) => ({row, index})).sort((a, b) =>
      compare(read(a.row, sort.key), read(b.row, sort.key), sort.direction) || a.index - b.index).map(item => item.row);
  }

  function options(rows, column, read) {
    const values = new Map();
    rows.forEach(row => {
      const cell = read(row, column), id = key(cell.label);
      const existing = values.get(id);
      if (existing) existing.count++;
      else values.set(id, {...cell, key:id, count:1});
    });
    return [...values.values()].sort((a, b) => compare(a, b));
  }

  function search(options, query) {
    const words = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return !words.length ? options : options.filter(option => words.some(word => (option.key || '（空白）').toLocaleLowerCase().includes(word)));
  }

  const api = { key, compare, apply, options, search };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.ColumnFilters = api;
})();
