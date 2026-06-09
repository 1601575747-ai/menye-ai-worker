'use strict';

const JobStatus = Object.freeze({
  CREATED: 'created',
  UPLOADED: 'uploaded',
  NORMALIZED: 'normalized',
  ANALYZING: 'analyzing',
  RULES_READY: 'rules_ready',
  RENDERING: 'rendering',
  GENERATING: 'generating',
  VALIDATING: 'validating',
  RETRYING: 'retrying',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  NEEDS_USER_ADJUSTMENT: 'needs_user_adjustment'
});

module.exports = {
  JobStatus
};
