/* Decimal display precision is independent from live scoring calculations. */
(() => {
  function decimalParts(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    const text = String(value).trim().replace(/,/g, "");
    const match = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?$/i.exec(text);
    if (!match || !Number.isFinite(Number(text))) return null;
    const exponent = Number(match[3] || 0);
    if (Math.abs(exponent) > 1000) return null;
    const [integer, fraction = ""] = match[2].split(".");
    let coefficient = BigInt((integer || "0") + fraction) * (match[1] === "-" ? -1n : 1n);
    const scale = fraction.length - exponent;
    if (scale < 0) coefficient *= 10n ** BigInt(-scale);
    return { coefficient, scale: Math.max(0, scale) };
  }

  function decimalProduct(values) {
    const parts = values.map(decimalParts);
    if (parts.some((part) => part === null)) return "0";
    const coefficient = parts.reduce((product, part) => product * part.coefficient, 1n);
    const scale = parts.reduce((sum, part) => sum + part.scale, 0);
    const digits = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
    return `${coefficient < 0n ? "-" : ""}${scale ? digits.slice(0, -scale) + "." + digits.slice(-scale) : digits}`;
  }

  function sumRoundUp4(values) {
    // Sum decimal digits exactly before ROUND_UP, avoiding 0.1 + 0.2 artifacts.
    const parts = values.map(decimalParts).filter((part) => part !== null);
    const scale = parts.reduce((max, part) => Math.max(max, part.scale), 4);
    const sum = parts.reduce((total, part) => total + part.coefficient * 10n ** BigInt(scale - part.scale), 0n);
    const divisor = 10n ** BigInt(scale - 4);
    let rounded = sum / divisor;
    if (sum % divisor !== 0n) rounded += sum < 0n ? -1n : 1n;
    const absolute = rounded < 0n ? -rounded : rounded;
    return `${rounded < 0n ? "-" : ""}${absolute / 10000n}.${String(absolute % 10000n).padStart(4, "0")}`;
  }

  function fmt(value) {
    if (value === null || value === undefined || value === "") return "";
    if (decimalParts(value)) return sumRoundUp4([value]);
    if (typeof value === "number" && !Number.isFinite(value)) return "";
    return String(value);
  }

  function numericField(field = {}) {
    return !/^(?:文本|日期|日期时间|text|date|datetime)$/i.test(field.value_type || "") && !/(?:_id|_code|_year|_date)$/i.test(field.field_id || "") &&
      !/(?:代码|编号)$/.test(field.label || "");
  }

  function fieldDisplay(value, field) {
    return numericField(field) ? fmt(value) : String(value ?? "");
  }

  function compareNumbers(left, right) {
    const a = decimalParts(left), b = decimalParts(right);
    if (!a || !b) return null;
    const scale = Math.max(a.scale, b.scale);
    const difference = a.coefficient * 10n ** BigInt(scale - a.scale) - b.coefficient * 10n ** BigInt(scale - b.scale);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  const api = { decimalProduct, sumRoundUp4, fmt, fieldDisplay, numericField, compareNumbers };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.NumberFormat = api;
})();
