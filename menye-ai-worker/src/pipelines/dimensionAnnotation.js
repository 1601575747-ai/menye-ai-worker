'use strict';

const { TaskType } = require('../door/schema');
const { analyzeDoor } = require('../door/analyzer');
const { normalizeDoorType } = require('../door/profiles');
const { buildDimensionRules } = require('../door/ruleEngine');
const { buildDimensionRenderPlan } = require('../door/dimensionLayout');
const { renderDimensionAnnotation } = require('../renderers/dimensionRenderer');
const { validateDimensionAnnotation } = require('../door/validators');
const { JobStatus } = require('../jobs/status');
const { ErrorCode } = require('../utils/errors');

function hasInputValues(source) {
  if (Array.isArray(source)) {
    return source.length > 0;
  }
  return !!(source && typeof source === 'object' && Object.keys(source).length > 0);
}

function getJobInputs(job) {
  const sources = [
    job && job.inputs,
    job && job.dimensionValues,
    job && job.dimensions,
    job && job.dimensionInputs
  ];
  return sources.find(hasInputValues) || {};
}

function normalizeViewSide(value) {
  return value === 'back' ? 'back' : 'front';
}

function normalizeWhiteBackground(job) {
  if (typeof (job && job.whiteBackground) === 'boolean') {
    return job.whiteBackground;
  }
  if (typeof (job && job.dimensionWhiteBackground) === 'boolean') {
    return job.dimensionWhiteBackground;
  }
  const backgroundInfo = String(job && job.backgroundInfo ? job.backgroundInfo : '');
  return /白板|白底|纯白|改白/.test(backgroundInfo);
}

function normalizeDimensionAnnotationJob(job = {}) {
  const requirement = job.requirement && typeof job.requirement === 'object' ? job.requirement : {};
  return Object.freeze({
    jobId: job.jobId || job._id || '',
    taskType: job.taskType || TaskType.DIMENSION_ANNOTATION,
    doorType: normalizeDoorType(job.doorType || requirement.doorType),
    viewSide: normalizeViewSide(job.dimensionViewSide || job.viewSide),
    inputs: getJobInputs(job),
    image: job.image || job.imageBuffer || null,
    imageUrl: job.imageUrl || job.primaryImageUrl || job.originalImageUrl || '',
    imageSize: job.imageSize || null,
    whiteBackground: normalizeWhiteBackground(job),
    analyzerMode: job.analyzerMode || '',
    rendererOptions: job.rendererOptions || null
  });
}

function makePipelineIssue(code, message, details = {}) {
  return Object.freeze({
    code,
    message,
    retryable: false,
    ...details
  });
}

function summarizeBox(box) {
  if (!box) {
    return null;
  }
  return Object.freeze({
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom
  });
}

function summarizeDoorStructure(doorStructure) {
  const boxes = doorStructure && doorStructure.boxes ? doorStructure.boxes : {};
  return Object.freeze({
    boxes: Object.freeze({
      outerTrim: summarizeBox(boxes.outerTrim),
      opening: summarizeBox(boxes.opening),
      visibleOpening: summarizeBox(boxes.visibleOpening),
      doorLeaf: summarizeBox(boxes.doorLeaf),
      transom: summarizeBox(boxes.transom),
      header: summarizeBox(boxes.header),
      shadowRegions: Object.freeze(Array.isArray(boxes.shadowRegions) ? boxes.shadowRegions.map(summarizeBox).filter(Boolean) : [])
    }),
    dimensionAnchors: Object.freeze({
      doorTrimConnection: summarizeBox(doorStructure && doorStructure.dimensionAnchors
        ? doorStructure.dimensionAnchors.doorTrimConnection
        : null),
      openingMidline: summarizeBox(doorStructure && doorStructure.dimensionAnchors
        ? doorStructure.dimensionAnchors.openingMidline
        : null)
    }),
    keypoints: Object.freeze({
      doorBottomY: doorStructure && doorStructure.keypoints ? doorStructure.keypoints.doorBottomY : null
    }),
    modes: Object.freeze({
      heightBottomMode: doorStructure && doorStructure.modes ? doorStructure.modes.heightBottomMode : 'shared'
    }),
    confidence: Object.freeze({ ...((doorStructure && doorStructure.confidence) || {}) }),
    needsUserAdjustment: Boolean(doorStructure && doorStructure.needsUserAdjustment),
    notes: doorStructure && doorStructure.notes ? doorStructure.notes : ''
  });
}

function summarizeRules(rules) {
  return Object.freeze((Array.isArray(rules) ? rules : []).map((rule) => Object.freeze({
    field: rule.field,
    type: rule.type,
    orientation: rule.orientation,
    label: rule.label,
    value: rule.value,
    unit: rule.unit,
    sourceBoundary: rule.sourceBoundary || null,
    confidence: rule.confidence
  })));
}

async function runDimensionAnnotationPipeline(job = {}) {
  const normalizedJob = normalizeDimensionAnnotationJob(job);
  if (normalizedJob.taskType !== TaskType.DIMENSION_ANNOTATION) {
    return Object.freeze({
      status: JobStatus.FAILED,
      succeeded: false,
      issues: Object.freeze([
        makePipelineIssue(ErrorCode.DIMENSION_RULE_INVALID, 'Unsupported taskType for dimension annotation pipeline', {
          taskType: normalizedJob.taskType
        })
      ]),
      normalizedJob
    });
  }

  const doorStructure = await analyzeDoor({
    image: normalizedJob.image,
    imageUrl: normalizedJob.imageUrl,
    imageSize: normalizedJob.imageSize,
    doorType: normalizedJob.doorType,
    viewSide: normalizedJob.viewSide,
    taskType: normalizedJob.taskType,
    dimensionInputs: normalizedJob.inputs,
    mode: normalizedJob.analyzerMode
  });

  if (doorStructure.needsUserAdjustment) {
    return Object.freeze({
      status: JobStatus.NEEDS_USER_ADJUSTMENT,
      succeeded: false,
      normalizedJob,
      doorStructure,
      issues: doorStructure.issues || Object.freeze([
        makePipelineIssue(ErrorCode.MISSING_REQUIRED_BOUNDARY, 'Door analyzer needs user adjustment')
      ])
    });
  }

  const ruleResult = buildDimensionRules({
    doorType: normalizedJob.doorType,
    viewSide: normalizedJob.viewSide,
    inputs: normalizedJob.inputs,
    doorStructure
  });

  if (ruleResult.needsUserAdjustment || ruleResult.status === JobStatus.NEEDS_USER_ADJUSTMENT) {
    return Object.freeze({
      status: JobStatus.NEEDS_USER_ADJUSTMENT,
      succeeded: false,
      normalizedJob,
      doorStructure,
      ruleResult,
      issues: ruleResult.issues
    });
  }

  const layoutPlan = buildDimensionRenderPlan({
    rules: ruleResult.rules,
    doorStructure,
    imageSize: normalizedJob.imageSize
  });

  const renderResult = await renderDimensionAnnotation({
    image: normalizedJob.image,
    imageUrl: normalizedJob.imageUrl,
    renderPlan: layoutPlan,
    whiteBackground: normalizedJob.whiteBackground
  });
  const renderPlan = renderResult.renderPlan || layoutPlan;

  const metadata = Object.freeze({
    doorType: normalizedJob.doorType,
    viewSide: normalizedJob.viewSide,
    whiteBackground: renderResult.metadata && typeof renderResult.metadata.whiteBackground === 'boolean'
      ? renderResult.metadata.whiteBackground
      : normalizedJob.whiteBackground,
    heightBottomMode: doorStructure.modes && doorStructure.modes.heightBottomMode,
    rendererType: renderResult.rendererType,
    renderMetadata: renderResult.metadata || null,
    doorStructure: summarizeDoorStructure(doorStructure),
    rules: summarizeRules(ruleResult.rules)
  });

  const validation = validateDimensionAnnotation({
    inputs: normalizedJob.inputs,
    rules: ruleResult.rules,
    renderPlan,
    resultImageUrl: renderResult.resultImageUrl || '',
    metadata
  });

  if (!validation.passed) {
    return Object.freeze({
      status: validation.needsUserAdjustment ? JobStatus.NEEDS_USER_ADJUSTMENT : JobStatus.FAILED,
      succeeded: false,
      normalizedJob,
      doorStructure,
      ruleResult,
      renderPlan,
      renderResult,
      validation,
      issues: validation.issues
    });
  }

  return Object.freeze({
    status: JobStatus.SUCCEEDED,
    succeeded: true,
    normalizedJob,
    doorStructure,
    ruleResult,
    renderPlan,
    renderResult,
    validation,
    resultImageUrl: renderResult.resultImageUrl || '',
    resultBuffer: renderResult.resultBuffer || null,
    rendererType: renderResult.rendererType,
    metadata
  });
}

module.exports = {
  normalizeDimensionAnnotationJob,
  runDimensionAnnotationPipeline
};
