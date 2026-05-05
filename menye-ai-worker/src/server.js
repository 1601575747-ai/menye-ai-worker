const http = require('http');
const https = require('https');
const crypto = require('crypto');
const cloudbase = require('@cloudbase/node-sdk');
const openaiModule = require('openai');

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const SECRET_ID = process.env.CLOUDBASE_SECRET_ID;
const SECRET_KEY = process.env.CLOUDBASE_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || '';
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET;
const PORT = Number(process.env.PORT || 3000);

const requiredEnvMap = {
  CLOUDBASE_ENV_ID: ENV_ID,
  CLOUDBASE_SECRET_ID: SECRET_ID,
  CLOUDBASE_SECRET_KEY: SECRET_KEY,
  OPENAI_API_KEY,
  WORKER_SHARED_SECRET
};

function getMissingEnvKeys() {
  return Object.keys(requiredEnvMap).filter((key) => !requiredEnvMap[key]);
}

const missingEnvKeys = getMissingEnvKeys();
const isConfigured = missingEnvKeys.length === 0;

const app = isConfigured ? cloudbase.init({
  env: ENV_ID,
  secretId: SECRET_ID,
  secretKey: SECRET_KEY
}) : null;

const db = app ? app.database() : null;
const collection = db ? db.collection('ai_jobs') : null;
const OpenAIClient = openaiModule.default || openaiModule;
const toFile = openaiModule.toFile;
const openai = isConfigured ? new OpenAIClient({
  apiKey: OPENAI_API_KEY,
  ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {})
}) : null;

function getSanitizedBaseUrl(value) {
  if (!value) {
    return 'https://api.openai.com/v1';
  }
  try {
    const target = new URL(value);
    return `${target.protocol}//${target.host}${target.pathname}`;
  } catch (error) {
    return value;
  }
}

function assertConfigured() {
  if (!isConfigured) {
    throw new Error(`缺少环境变量：${missingEnvKeys.join(', ')}`);
  }
}

function signPayload(jobId, timestamp, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${jobId}.${timestamp}`)
    .digest('hex');
}

function verifySignature(body) {
  const { jobId, timestamp, signature } = body || {};
  if (!jobId || !timestamp || !signature || !WORKER_SHARED_SECRET) {
    return false;
  }
  return signPayload(jobId, timestamp, WORKER_SHARED_SECRET) === signature;
}

function buildDoorImageInstruction(job) {
  return [
    '请在保留原始拍摄角度和整体构图的前提下处理这张门业图片。',
    `用途：${job.templateType || '门业展示'}`,
    `门类型：${job.doorType || '未指定'}`,
    `风格：${job.style || '未指定'}`,
    `补充要求：${job.requirement || '按当前图片处理'}`,
    '优先围绕门体、材质、颜色、空间氛围做优化，不要无关改动。'
  ].join('\n');
}

function getFileExtensionFromPath(value, fallback) {
  const matched = /\.([a-zA-Z0-9]+)(?:$|\?)/.exec(value || '');
  return matched ? matched[1].toLowerCase() : (fallback || 'png');
}

function getMimeType(extension) {
  switch ((extension || '').toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'png':
    default:
      return 'image/png';
  }
}

function getResultCloudPath(jobId, version, extension) {
  const ext = extension || 'png';
  return `ai-jobs/result/${jobId}/v${version || 1}-${Date.now()}.${ext}`;
}

function downloadRemoteBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = /^https:/i.test(url) ? https : http;
    const request = client.get(url, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        resolve(downloadRemoteBuffer(response.headers.location));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下载结果图片失败：${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });

    request.on('error', reject);
  });
}

async function getJob(jobId) {
  const detail = await collection.doc(jobId).get();
  const data = detail && detail.data;
  if (Array.isArray(data)) {
    return data[0] || null;
  }
  return data || null;
}

async function updateJob(jobId, data) {
  await collection.doc(jobId).update(data);
}

async function downloadOriginalImage(job) {
  const result = await app.downloadFile({
    fileID: job.originalImageFileID
  });
  return result.fileContent;
}

async function uploadResult(jobId, version, buffer) {
  const cloudPath = getResultCloudPath(jobId, version, 'png');
  const result = await app.uploadFile({
    cloudPath,
    fileContent: buffer
  });
  return result.fileID;
}

async function createInputImage(job, sourceBuffer) {
  const extension = getFileExtensionFromPath(job.originalImageFileID, 'png');
  return toFile(sourceBuffer, `door-source.${extension}`, {
    type: getMimeType(extension)
  });
}

async function readImageResponseBody(response) {
  if (!response || !response.data || !response.data[0]) {
    throw new Error('没有拿到处理结果');
  }
  const first = response.data[0];
  if (first.b64_json) {
    return Buffer.from(first.b64_json, 'base64');
  }
  if (first.url) {
    return downloadRemoteBuffer(first.url);
  }
  throw new Error('暂时无法识别返回图片');
}

async function processJob(jobId) {
  assertConfigured();
  console.log('[worker] start processJob', jobId);

  const job = await getJob(jobId);
  console.log('[worker] fetched job', jobId, !!job, job ? Object.keys(job) : [], job && job.originalImageFileID);
  if (!job) {
    throw new Error('未找到任务');
  }
  if (!job.originalImageFileID) {
    throw new Error('缺少原始图片');
  }

  await updateJob(jobId, {
    status: 'processing',
    provider: 'openai-worker',
    providerStatus: 'processing',
    errorMessage: '',
    updatedAt: Date.now()
  });
  console.log('[worker] updated job to processing', jobId);

  const sourceBuffer = await downloadOriginalImage(job);
  console.log('[worker] downloaded source image', jobId, sourceBuffer.length);
  const inputImage = await createInputImage(job, sourceBuffer);
  console.log('[worker] created input image', jobId);
  console.log('[worker] calling image api', {
    jobId,
    baseURL: getSanitizedBaseUrl(OPENAI_BASE_URL),
    model: OPENAI_IMAGE_MODEL
  });
  const response = await openai.images.edit({
    model: OPENAI_IMAGE_MODEL,
    image: inputImage,
    prompt: buildDoorImageInstruction(job),
    size: '1024x1024'
  });
  console.log('[worker] received openai response', jobId);

  const resultBuffer = await readImageResponseBody(response);
  console.log('[worker] parsed result buffer', jobId, resultBuffer.length);
  const resultImageFileID = await uploadResult(jobId, job.version || 1, resultBuffer);
  console.log('[worker] uploaded result image', jobId, resultImageFileID);
  const time = Date.now();
  const nextVersions = (job.versions || []).concat({
    resultImageFileID,
    text: job.requirement || '生成结果',
    time,
    imageUrl: ''
  });

  await updateJob(jobId, {
    status: 'success',
    provider: 'openai-worker',
    providerStatus: 'success',
    resultImageFileID,
    errorMessage: '',
    updatedAt: time,
    versions: nextVersions
  });
  console.log('[worker] completed job', jobId);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(body));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? JSON.parse(text) : {});
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      success: true,
      configured: isConfigured,
      missingEnvKeys
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/jobs/process') {
    try {
      if (!isConfigured) {
        sendJson(res, 500, {
          success: false,
          errorMessage: `缺少环境变量：${missingEnvKeys.join(', ')}`
        });
        return;
      }

      const body = await readRequestBody(req);
      if (!verifySignature(body)) {
        sendJson(res, 401, { success: false, errorMessage: '签名无效' });
        return;
      }

      sendJson(res, 200, { success: true, accepted: true });

      processJob(body.jobId).catch(async (error) => {
        console.error('[worker] processJob failed:', body.jobId, error);
        try {
          await updateJob(body.jobId, {
            status: 'failed',
            provider: 'openai-worker',
            providerStatus: 'failed',
            errorMessage: error && error.message ? error.message : '处理失败，请稍后再试',
            updatedAt: Date.now()
          });
        } catch (updateError) {
          console.error('update job failed:', updateError);
        }
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        errorMessage: error && error.message ? error.message : '请求处理失败'
      });
      return;
    }
  }

  sendJson(res, 404, { success: false, errorMessage: '未找到接口' });
});

server.listen(PORT, () => {
  console.log(`menye-ai-worker listening on ${PORT}`);
  if (!isConfigured) {
    console.warn(`missing env keys: ${missingEnvKeys.join(', ')}`);
  }
});
