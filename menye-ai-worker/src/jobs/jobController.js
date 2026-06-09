'use strict';

const {
  createJob,
  runJob,
  getJob,
  updateJobStatus
} = require('./jobService');

async function createAndRunJob(payload = {}) {
  const job = createJob(payload);
  return runJob(job.jobId);
}

module.exports = {
  createJob,
  runJob,
  getJob,
  updateJobStatus,
  createAndRunJob
};
