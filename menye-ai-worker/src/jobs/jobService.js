'use strict';

const {
  createJobRecord,
  getJobRecord,
  updateJobRecord
} = require('./jobRepository');
const {
  saveArtifact,
  listArtifactsForJob
} = require('./artifactService');
const { runPipeline } = require('../pipelines');
const { TaskType } = require('../door/schema');
const { normalizeDoorType } = require('../door/profiles');
const { JobStatus } = require('./status');
const { ErrorCode } = require('../utils/errors');

const progressByStatus = Object.freeze({
  [JobStatus.CREATED]: 0,
  [JobStatus.UPLOADED]: 10,
  [JobStatus.NORMALIZED]: 20,
  [JobStatus.ANALYZING]: 35,
  [JobStatus.RULES_READY]: 50,
  [JobStatus.RENDERING]: 65,
  [JobStatus.GENERATING]: 75,
  [JobStatus.VALIDATING]: 90,
  [JobStatus.RETRYING]: 15,
  [JobStatus.SUCCEEDED]: 100,
  [JobStatus.FAILED]: 100,
  [JobStatus.NEEDS_USER_ADJUSTMENT]: 100
});

function normalizeViewSide(value) {
  return value === 'back' ? 'back' : 'front';
}

function normalizeTaskType(value) {
  return value || TaskType.DIMENSION_ANNOTATION;
}

function pickInputs(payload = {}) {
  return payload.inputs || payload.dimensionValues || payload.dimensions || payload.dimensionInputs || {};
}

function pickImageRefs(payload = {}) {
  return {
    imageUrl: payload.imageUrl || payload.primaryImageUrl || payload.originalImageUrl || '',
    originalImageUrl: payload.originalImageUrl || '',
    primaryImageUrl: payload.primaryImageUrl || '',
    imageFileID: payload.imageFileID || payload.primaryImageFileID || payload.originalImageFileID || '',
    primaryImageFileID: payload.primaryImageFileID || '',
    originalImageFileID: payload.originalImageFileID || ''
  };
}

function normalizeWhiteBackground(payload = {}) {
  if (typeof payload.whiteBackground === 'boolean') {
    return payload.whiteBackground;
  }
  if (typeof payload.dimensionWhiteBackground === 'boolean') {
    return payload.dimensionWhiteBackground;
  }
  const backgroundInfo = String(payload.backgroundInfo || '');
  const requirement = String(payload.requirement || '');
  return /白板|白底|纯白|改白/.test(`${backgroundInfo} ${requirement}`);
}

function normalizeCreatePayload(payload = {}) {
  const taskType = normalizeTaskType(payload.taskType);
  const imageRefs = pickImageRefs(payload);
  return {
    taskType,
    doorType: normalizeDoorType(payload.doorType),
    viewSide: normalizeViewSide(payload.viewSide || payload.dimensionViewSide),
    inputs: pickInputs(payload),
    dimensionValues: pickInputs(payload),
    image: payload.image || payload.imageBuffer || null,
    imageSize: payload.imageSize || null,
    imageUrl: imageRefs.imageUrl,
    imageRefs,
    whiteBackground: normalizeWhiteBackground(payload),
    analyzerMode: payload.analyzerMode || '',
    metadata: payload.metadata || {}
  };
}

function makeError({ errorCode, message, stage, details = {} }) {
  return {
    errorCode,
    message,
    stage,
    details
  };
}

function makeErrorFromPipelineResult(pipelineResult, fallbackStage) {
  if (pipelineResult && pipelineResult.error) {
    return {
      errorCode: pipelineResult.error.errorCode || pipelineResult.error.code || ErrorCode.VALIDATION_FAILED,
      message: pipelineResult.error.message || 'Pipeline failed',
      stage: pipelineResult.error.stage || fallbackStage,
      details: pipelineResult.error.details || {}
    };
  }

  const issue = pipelineResult && Array.isArray(pipelineResult.issues) ? pipelineResult.issues[0] : null;
  if (issue) {
    return {
      errorCode: issue.errorCode || issue.code || ErrorCode.VALIDATION_FAILED,
      message: issue.message || 'Pipeline failed',
      stage: issue.stage || fallbackStage,
      details: issue
    };
  }

  return makeError({
    errorCode: ErrorCode.VALIDATION_FAILED,
    message: 'Pipeline failed',
    stage: fallbackStage
  });
}

function createJob(payload = {}) {
  return createJobRecord(normalizeCreatePayload(payload));
}

function updateJobStatus(jobId, status, patch = {}) {
  const updated = updateJobRecord(jobId, {
    ...patch,
    status,
    event: {
      status,
      stage: patch.stage || status,
      patch: patch.eventPatch || {}
    }
  });

  if (!updated) {
    throw makeError({
      errorCode: ErrorCode.VALIDATION_FAILED,
      message: `Job not found: ${jobId}`,
      stage: 'jobRepository'
    });
  }

  return updated;
}

function buildJobView(job) {
  if (!job) {
    return null;
  }

  return {
    jobId: job.jobId,
    status: job.status,
    progress: progressByStatus[job.status] || 0,
    result: job.result || null,
    error: job.error || null,
    retryCount: job.retryCount || 0,
    metadata: {
      ...(job.metadata || {}),
      artifacts: job.artifacts || [],
      events: job.events || []
    }
  };
}

function getJob(jobId) {
  return buildJobView(getJobRecord(jobId));
}

function savePipelineArtifacts(jobId, job, pipelineResult = {}) {
  const refs = [];

  if ((job.image || job.imageUrl || job.imageRefs) && !pipelineResult.legacy) {
    refs.push(saveArtifact({
      jobId,
      type: 'originalImage',
      value: job.image || job.imageUrl || job.imageRefs,
      metadata: { imageUrl: job.imageUrl || '' }
    }));
  }

  if (pipelineResult.doorStructure) {
    refs.push(saveArtifact({ jobId, type: 'doorStructure', value: pipelineResult.doorStructure }));
  }
  if (pipelineResult.ruleResult) {
    refs.push(saveArtifact({ jobId, type: 'dimensionRules', value: pipelineResult.ruleResult }));
  }
  if (pipelineResult.renderPlan) {
    refs.push(saveArtifact({ jobId, type: 'renderPlan', value: pipelineResult.renderPlan }));
  }
  if (pipelineResult.resultImageUrl) {
    refs.push(saveArtifact({
      jobId,
      type: 'resultImageUrl',
      value: pipelineResult.resultImageUrl
    }));
  }
  if (pipelineResult.resultBuffer) {
    refs.push(saveArtifact({
      jobId,
      type: 'resultBuffer',
      value: pipelineResult.resultBuffer
    }));
  }

  return refs;
}

async function runJob(jobId) {
  const existing = getJobRecord(jobId);
  if (!existing) {
    throw makeError({
      errorCode: ErrorCode.VALIDATION_FAILED,
      message: `Job not found: ${jobId}`,
      stage: 'jobRepository'
    });
  }

  if (existing.status === JobStatus.SUCCEEDED && existing.result) {
    return {
      ...buildJobView(existing),
      metadata: {
        ...(existing.metadata || {}),
        artifacts: existing.artifacts || listArtifactsForJob(jobId),
        events: existing.events || [],
        idempotent: true
      }
    };
  }

  const nextRetryCount = existing.status === JobStatus.FAILED || existing.status === JobStatus.NEEDS_USER_ADJUSTMENT
    ? (existing.retryCount || 0) + 1
    : (existing.retryCount || 0);

  if (nextRetryCount !== (existing.retryCount || 0)) {
    updateJobStatus(jobId, JobStatus.RETRYING, {
      retryCount: nextRetryCount,
      stage: 'retrying'
    });
  }

  try {
    updateJobStatus(jobId, JobStatus.NORMALIZED, { retryCount: nextRetryCount, stage: 'normalize' });
    const normalizedJob = getJobRecord(jobId);

    updateJobStatus(jobId, normalizedJob.taskType === TaskType.DIMENSION_ANNOTATION
      ? JobStatus.ANALYZING
      : JobStatus.GENERATING, {
      stage: normalizedJob.taskType === TaskType.DIMENSION_ANNOTATION ? 'analyze' : 'legacy'
    });
    const pipelineResult = await runPipeline(normalizedJob);

    if (pipelineResult.ruleResult) {
      updateJobStatus(jobId, JobStatus.RULES_READY, { stage: 'rules' });
    }
    if (pipelineResult.renderPlan || pipelineResult.renderResult) {
      updateJobStatus(jobId, JobStatus.RENDERING, { stage: 'render' });
    }
    updateJobStatus(jobId, JobStatus.VALIDATING, { stage: 'validate' });
    const artifactRefs = savePipelineArtifacts(jobId, normalizedJob, pipelineResult);
    const artifacts = listArtifactsForJob(jobId);

    if (pipelineResult.succeeded) {
      const result = {
        succeeded: true,
        legacy: Boolean(pipelineResult.legacy),
        resultImageUrl: pipelineResult.resultImageUrl || '',
        rendererType: pipelineResult.rendererType || '',
        pipelineResult: pipelineResult.result || null,
        artifacts
      };

      updateJobStatus(jobId, JobStatus.SUCCEEDED, {
        result,
        error: null,
        retryCount: nextRetryCount,
        artifacts,
        metadata: {
          ...(normalizedJob.metadata || {}),
          ...(pipelineResult.metadata || {}),
          artifactCount: artifactRefs.length
        },
        stage: 'succeeded'
      });
      return getJob(jobId);
    }

    const status = pipelineResult.status === JobStatus.NEEDS_USER_ADJUSTMENT
      ? JobStatus.NEEDS_USER_ADJUSTMENT
      : JobStatus.FAILED;
    const error = makeErrorFromPipelineResult(pipelineResult, pipelineResult.status || 'pipeline');

    updateJobStatus(jobId, status, {
      error,
      result: {
        succeeded: false,
        artifacts
      },
      retryCount: nextRetryCount,
      artifacts,
      metadata: {
        ...(normalizedJob.metadata || {}),
        ...(pipelineResult.metadata || {}),
        artifactCount: artifactRefs.length
      },
      stage: error.stage
    });
    return getJob(jobId);
  } catch (error) {
    const structuredError = makeError({
      errorCode: error.errorCode || error.code || ErrorCode.VALIDATION_FAILED,
      message: error.message || 'Job failed',
      stage: error.stage || 'runJob',
      details: error.details || {}
    });
    updateJobStatus(jobId, JobStatus.FAILED, {
      error: structuredError,
      retryCount: nextRetryCount,
      stage: structuredError.stage
    });
    return getJob(jobId);
  }
}

module.exports = {
  createJob,
  runJob,
  getJob,
  updateJobStatus,
  normalizeCreatePayload,
  makeError
};
