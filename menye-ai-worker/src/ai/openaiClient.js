'use strict';

let openaiModule = null;
try {
  openaiModule = require('openai');
} catch (error) {
  openaiModule = null;
}

function createOpenAIClient(options = {}) {
  if (!openaiModule) {
    return null;
  }
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  const OpenAIClient = openaiModule.default || openaiModule;
  return new OpenAIClient({
    apiKey,
    ...(options.baseURL || process.env.OPENAI_BASE_URL ? { baseURL: options.baseURL || process.env.OPENAI_BASE_URL } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {})
  });
}

function getDefaultVisionModel() {
  return process.env.OPENAI_VISION_MODEL || 'gpt-5.5';
}

module.exports = {
  createOpenAIClient,
  getDefaultVisionModel
};
