'use strict';

const {
  DimensionField,
  DimensionFieldMeta
} = require('./schema');
const {
  isDimensionFieldAllowed
} = require('./profiles');
const { ErrorCode } = require('../utils/errors');

const ALLOWED_DIMENSION_FIELDS = Object.freeze(new Set(Object.values(DimensionField)));

function readInputValue(rawValue) {
  if (rawValue && typeof rawValue === 'object' && Object.prototype.hasOwnProperty.call(rawValue, 'value')) {
    return rawValue.value;
  }
  return rawValue;
}

function parseDimensionNumber(rawValue) {
  const value = readInputValue(rawValue);
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  const normalized = text.replace(/mm|毫米/gi, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return { error: true, raw: text };
  }
  const number = Number(normalized);
  if (!Number.isFinite(number)) {
    return { error: true, raw: text };
  }
  return number;
}

function normalizeDimensionInputs(inputs, context = {}) {
  const source = inputs && typeof inputs === 'object' ? inputs : {};
  const normalized = {};
  const errors = [];
  const entries = Array.isArray(source)
    ? source.map((item) => [item && item.key, item])
    : Object.entries(source);

  for (const [rawKey, rawValue] of entries) {
    const field = String(rawKey || '').trim();
    if (!field || !ALLOWED_DIMENSION_FIELDS.has(field)) {
      continue;
    }
    if (!isDimensionFieldAllowed({
      doorType: context.doorType,
      viewSide: context.viewSide,
      field
    })) {
      continue;
    }
    const parsed = parseDimensionNumber(rawValue);
    if (parsed === null) {
      continue;
    }
    if (parsed && parsed.error) {
      errors.push({
        code: ErrorCode.DIMENSION_RULE_INVALID,
        field,
        message: 'Invalid dimension number',
        rawValue: parsed.raw
      });
      continue;
    }
    const meta = DimensionFieldMeta[field];
    normalized[field] = Object.freeze({
      field,
      value: parsed,
      unit: 'mm',
      textOnly: !!(meta && meta.textOnly)
    });
  }

  return Object.freeze({
    values: Object.freeze(normalized),
    errors: Object.freeze(errors)
  });
}

module.exports = {
  normalizeDimensionInputs
};
