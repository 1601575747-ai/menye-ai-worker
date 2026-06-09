'use strict';

const { DimensionField } = require('./schema');
const { normalizeDimensionInputs } = require('./dimensions');
const { ErrorCode } = require('../utils/errors');

function makeIssue(code, field, message, retryable = false) {
  return Object.freeze({
    code,
    field,
    message,
    retryable
  });
}

function getExpectedInputFields(inputs, context = {}) {
  return Object.keys(normalizeDimensionInputs(inputs, context).values);
}

function hasMm(text) {
  return /mm\b/i.test(String(text || ''));
}

function getRuleFields(rules) {
  return (Array.isArray(rules) ? rules : []).map((rule) => rule && rule.field).filter(Boolean);
}

function getRenderPlanLineFields(renderPlan) {
  return (renderPlan && Array.isArray(renderPlan.lines) ? renderPlan.lines : [])
    .map((line) => line && line.field)
    .filter(Boolean);
}

function getRenderPlanTextFields(renderPlan) {
  const textFields = (renderPlan && Array.isArray(renderPlan.texts) ? renderPlan.texts : [])
    .map((text) => text && text.field)
    .filter(Boolean);
  const annotationFields = (renderPlan && Array.isArray(renderPlan.textOnlyAnnotations) ? renderPlan.textOnlyAnnotations : [])
    .map((annotation) => annotation && annotation.field)
    .filter(Boolean);
  return textFields.concat(annotationFields);
}

function validateRuleFieldSet({ expectedFields, rules, issues }) {
  const ruleFields = getRuleFields(rules);
  const uniqueRuleFields = new Set(ruleFields);
  for (const field of expectedFields) {
    if (!uniqueRuleFields.has(field)) {
      issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, field, 'Missing dimension rule for filled field', true));
    }
  }
  for (const field of uniqueRuleFields) {
    if (!expectedFields.includes(field)) {
      issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, field, 'Unexpected rule for unfilled field', false));
    }
  }
  if (ruleFields.length !== uniqueRuleFields.size) {
    issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, '', 'Duplicate dimension rules found', false));
  }
}

function validateRenderPlanFieldSet({ expectedFields, renderPlan, issues }) {
  const renderedFields = new Set(getRenderPlanTextFields(renderPlan));
  for (const field of expectedFields) {
    if (!renderedFields.has(field)) {
      issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, field, 'Missing rendered annotation for filled field', true));
    }
  }
  for (const field of renderedFields) {
    if (!expectedFields.includes(field)) {
      issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, field, 'Rendered annotation for unfilled field', false));
    }
  }
}

function validateTextUnits(renderPlan, issues) {
  const texts = renderPlan && Array.isArray(renderPlan.texts) ? renderPlan.texts : [];
  const annotations = renderPlan && Array.isArray(renderPlan.textOnlyAnnotations) ? renderPlan.textOnlyAnnotations : [];
  for (const text of texts) {
    if (!hasMm(text && text.text)) {
      issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, text && text.field, 'Rendered dimension text missing mm', true));
    }
  }
  for (const annotation of annotations) {
    if (!hasMm(annotation && annotation.text)) {
      issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, annotation && annotation.field, 'Rendered text-only annotation missing mm', true));
    }
  }
}

function validateWallThickness({ rules, renderPlan, issues }) {
  const wallRule = (Array.isArray(rules) ? rules : []).find((rule) => rule && rule.field === DimensionField.WALL_THICKNESS);
  if (wallRule && wallRule.type !== 'textOnly') {
    issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, DimensionField.WALL_THICKNESS, 'wallThickness rule must be textOnly', false));
  }
  const lineFields = getRenderPlanLineFields(renderPlan);
  if (lineFields.includes(DimensionField.WALL_THICKNESS)) {
    issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, DimensionField.WALL_THICKNESS, 'wallThickness must not render as a line', false));
  }
}

function validateSharedHeightBottom({ rules, renderPlan, metadata, issues }) {
  const shared = metadata && metadata.heightBottomMode === 'shared';
  if (!shared) {
    return;
  }
  const expectedHeightFields = new Set((Array.isArray(rules) ? rules : [])
    .filter((rule) => rule && rule.type === 'line' && rule.orientation === 'vertical' && rule.constraints && rule.constraints.heightBottomMode === 'shared')
    .map((rule) => rule.field));
  if (!expectedHeightFields.size) {
    return;
  }
  const bottomValues = new Set((renderPlan && Array.isArray(renderPlan.lines) ? renderPlan.lines : [])
    .filter((line) => expectedHeightFields.has(line.field))
    .map((line) => line && line.to && line.to.y)
    .filter((value) => typeof value === 'number' && Number.isFinite(value)));
  if (bottomValues.size > 1) {
    issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, '', 'Shared height dimensions must use the same bottomY', true));
  }
}

function validateWhiteBackground(metadata, issues) {
  if (!metadata || typeof metadata.whiteBackground !== 'boolean') {
    issues.push(makeIssue(ErrorCode.VALIDATION_FAILED, '', 'whiteBackground state missing from metadata', false));
  }
}

function validateDimensionAnnotation({ inputs, rules, renderPlan, resultImageUrl, metadata } = {}) {
  const issues = [];
  const context = {
    doorType: metadata && metadata.doorType,
    viewSide: metadata && metadata.viewSide
  };
  const expectedFields = getExpectedInputFields(inputs, context);

  validateRuleFieldSet({ expectedFields, rules, issues });
  validateRenderPlanFieldSet({ expectedFields, renderPlan, issues });
  validateTextUnits(renderPlan, issues);
  validateWallThickness({ rules, renderPlan, issues });
  validateSharedHeightBottom({ rules, renderPlan, metadata, issues });
  validateWhiteBackground(metadata, issues);

  const retryable = issues.some((issue) => issue.retryable);
  return Object.freeze({
    passed: issues.length === 0,
    issues: Object.freeze(issues),
    retryable,
    retryPrompt: retryable ? 'Regenerate deterministic dimension renderPlan and renderer output from validated rules.' : '',
    needsUserAdjustment: issues.some((issue) => !issue.retryable),
    metadata: Object.freeze({
      renderPlanChecked: true,
      resultImageUrl: resultImageUrl || '',
      visualCheckTodo: 'TODO: add second-layer visual inspection for rendered image URL.'
    })
  });
}

module.exports = {
  validateDimensionAnnotation
};
