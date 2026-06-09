'use strict';

const { ErrorCode } = require('../utils/errors');

function makeStructuredError(code, message, details = {}) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code,
      message,
      ...details
    })
  });
}

function parseStructuredJson(text) {
  if (!text || typeof text !== 'string') {
    return makeStructuredError(ErrorCode.VALIDATION_FAILED, 'Structured output is empty');
  }
  try {
    return Object.freeze({
      ok: true,
      value: JSON.parse(text)
    });
  } catch (error) {
    return makeStructuredError(ErrorCode.VALIDATION_FAILED, 'Structured output is not valid JSON', {
      parserMessage: error && error.message ? error.message : String(error)
    });
  }
}

function unwrapOpenAIResponseText(response) {
  if (!response) {
    return '';
  }
  if (typeof response.output_text === 'string') {
    return response.output_text;
  }
  if (typeof response.text === 'string') {
    return response.text;
  }
  return '';
}

module.exports = {
  makeStructuredError,
  parseStructuredJson,
  unwrapOpenAIResponseText
};
