'use strict';

const { TaskType } = require('../door/schema');
const { runDimensionAnnotationPipeline } = require('./dimensionAnnotation');
const { JobStatus } = require('../jobs/status');
const { ErrorCode } = require('../utils/errors');

const legacyTaskTypes = new Set([
  TaskType.PARTS_COMPOSE,
  TaskType.LOCK_REPLACEMENT,
  TaskType.HANDLE_REPLACEMENT,
  TaskType.COLOR_CHANGE,
  TaskType.BACKGROUND_REPLACE,
  TaskType.CLEANUP
]);

function makeStructuredError({ errorCode, message, stage, details = {} }) {
  return Object.freeze({
    errorCode,
    message,
    stage,
    details
  });
}

async function runLegacyAdapter(job) {
  return Object.freeze({
    status: JobStatus.SUCCEEDED,
    succeeded: true,
    legacy: true,
    result: Object.freeze({
      legacy: true,
      taskType: job.taskType,
      jobId: job.jobId || ''
    }),
    metadata: Object.freeze({
      taskType: job.taskType,
      legacyAdapter: true,
      note: 'Legacy pipeline adapter placeholder; existing old entrypoints are not replaced in this phase.'
    })
  });
}

async function runPipeline(job = {}) {
  if (job.taskType === TaskType.DIMENSION_ANNOTATION) {
    return runDimensionAnnotationPipeline(job);
  }

  if (legacyTaskTypes.has(job.taskType)) {
    return runLegacyAdapter(job);
  }

  return Object.freeze({
    status: JobStatus.FAILED,
    succeeded: false,
    error: makeStructuredError({
      errorCode: ErrorCode.VALIDATION_FAILED,
      message: `Unsupported taskType: ${job.taskType || ''}`,
      stage: 'dispatch'
    }),
    issues: Object.freeze([
      Object.freeze({
        code: ErrorCode.VALIDATION_FAILED,
        message: `Unsupported taskType: ${job.taskType || ''}`,
        stage: 'dispatch',
        retryable: false
      })
    ])
  });
}

module.exports = {
  runPipeline,
  runLegacyAdapter,
  makeStructuredError
};
