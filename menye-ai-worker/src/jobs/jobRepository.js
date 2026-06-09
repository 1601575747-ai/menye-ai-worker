'use strict';

const { JobStatus } = require('./status');

const jobs = new Map();
let jobCounter = 0;

function nowIso() {
  return new Date().toISOString();
}

function createJobId() {
  jobCounter += 1;
  return `job_${Date.now()}_${jobCounter}`;
}

function cloneValue(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((result, key) => {
      result[key] = cloneValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function createJobRecord(payload = {}) {
  const timestamp = nowIso();
  const jobId = payload.jobId || createJobId();
  const job = {
    ...cloneValue(payload),
    jobId,
    status: payload.status || JobStatus.CREATED,
    retryCount: Number.isInteger(payload.retryCount) ? payload.retryCount : 0,
    createdAt: payload.createdAt || timestamp,
    updatedAt: payload.updatedAt || timestamp,
    events: Array.isArray(payload.events) ? cloneValue(payload.events) : []
  };

  job.events.push({
    status: job.status,
    stage: 'create',
    at: timestamp,
    patch: {}
  });

  jobs.set(jobId, job);
  return cloneValue(job);
}

function getJobRecord(jobId) {
  const job = jobs.get(jobId);
  return job ? cloneValue(job) : null;
}

function updateJobRecord(jobId, patch = {}) {
  const current = jobs.get(jobId);
  if (!current) {
    return null;
  }
  const timestamp = nowIso();
  const next = {
    ...current,
    ...cloneValue(patch),
    jobId,
    updatedAt: timestamp,
    events: Array.isArray(current.events) ? current.events.slice() : []
  };

  if (patch.event) {
    next.events.push({
      ...cloneValue(patch.event),
      at: patch.event.at || timestamp
    });
    delete next.event;
  }

  jobs.set(jobId, next);
  return cloneValue(next);
}

function listJobs() {
  return Array.from(jobs.values()).map(cloneValue);
}

function clearJobsForTest() {
  jobs.clear();
  jobCounter = 0;
}

module.exports = {
  createJobRecord,
  getJobRecord,
  updateJobRecord,
  listJobs,
  clearJobsForTest
};
