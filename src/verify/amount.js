// Requirement comparison in base units. Balances and token amounts are
// compared as BigInt only: floats never touch money. The comparison is
// independent of chain and asset, so every adapter uses it.

const OPERATORS = ['gte', 'gt', 'lte', 'lt', 'eq', 'exactly', 'at_least', 'at_most', 'minimum'];

// Accept an operator spelled as a symbol, a word, or the builder's own term.
function normalizeOperator(op) {
  const s = String(op === undefined || op === null ? 'gte' : op).trim().toLowerCase();
  const map = {
    '>=': 'gte', '≥': 'gte', 'gte': 'gte', 'at_least': 'gte', 'atleast': 'gte',
    'minimum': 'gte', 'min': 'gte', 'gte_': 'gte',
    '>': 'gt', 'gt': 'gt', 'more_than': 'gt',
    '<=': 'lte', '≤': 'lte', 'lte': 'lte', 'at_most': 'lte', 'atmost': 'lte', 'maximum': 'lte', 'max': 'lte',
    '<': 'lt', 'lt': 'lt', 'less_than': 'lt',
    '==': 'eq', '=': 'eq', 'eq': 'eq', 'exactly': 'eq', 'equal': 'eq',
  };
  return map[s] || null;
}

// Parse a decimal string ("100", "1.5") into base units given `decimals`.
// Returns null on anything that is not a plain non-negative decimal, so a
// malformed amount becomes INVALID_CONFIGURATION rather than a silent 0.
function toBaseUnits(value, decimals) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const dec = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 0;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > dec) {
    // More precision than the asset supports: refuse rather than round up.
    if (frac.slice(dec).replace(/0+$/, '') !== '') return null;
  }
  const fracPadded = (frac + '0'.repeat(dec)).slice(0, dec);
  try {
    return BigInt(whole + fracPadded);
  } catch {
    return null;
  }
}

// Compare a measured base-unit BigInt against a requirement. `amount` is the
// human decimal value, `decimals` its scale. Returns
// { ok, operator, required, actual, reason }.
function compare(actual, { amount, decimals, operator }) {
  const op = normalizeOperator(operator);
  if (!op) return { ok: false, invalid: true, reason: 'Unknown comparison operator' };
  const actualBig = toBigInt(actual);
  if (actualBig === null) return { ok: false, invalid: true, reason: 'Could not read the measured amount' };
  const required = toBaseUnits(amount, decimals);
  if (required === null) return { ok: false, invalid: true, reason: 'The required amount is not a valid number for this asset' };
  let ok;
  switch (op) {
    case 'gte': ok = actualBig >= required; break;
    case 'gt': ok = actualBig > required; break;
    case 'lte': ok = actualBig <= required; break;
    case 'lt': ok = actualBig < required; break;
    case 'eq': ok = actualBig === required; break;
    default: ok = false;
  }
  return { ok, operator: op, required, actual: actualBig };
}

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    try { return BigInt(value); } catch { return null; }
  }
  if (typeof value === 'string') {
    try { return BigInt(value.trim()); } catch { return null; }
  }
  return null;
}

module.exports = { OPERATORS, normalizeOperator, toBaseUnits, compare, toBigInt };
