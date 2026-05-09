const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const cloudbase = require('@cloudbase/node-sdk');
const openaiModule = require('openai');

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const SECRET_ID = process.env.CLOUDBASE_SECRET_ID;
const SECRET_KEY = process.env.CLOUDBASE_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || '';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 180000);
const OPENAI_IMAGE_TIMEOUT_MS = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS || OPENAI_TIMEOUT_MS);
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
  timeout: OPENAI_TIMEOUT_MS,
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

function getReferenceImages(job) {
  return Array.isArray(job.referenceImages) ? job.referenceImages.filter((item) => item && item.originalImageFileID) : [];
}

function getPrimaryReferenceImage(job) {
  const referenceImages = getReferenceImages(job);
  return referenceImages.find((item) => item.slotId === 'full-door') || referenceImages[0] || null;
}

function getHandleDetailImage(job) {
  const referenceImages = getReferenceImages(job);
  return referenceImages.find((item) => item.slotId === 'handle-detail') || null;
}

function getReferenceSlotLabel(slotId) {
  switch (slotId) {
    case 'full-door':
      return '整门上下文图';
    case 'handle-detail':
      return '门把手细节图';
    case 'edge-trim-detail':
      return '包边参考图';
    case 'color-sample':
      return '颜色参考图';
    case 'left-leaf-detail':
      return '左门扇细节图';
    case 'right-leaf-detail':
      return '右门扇细节图';
    case 'child-leaf-detail':
      return '小门扇细节图';
    case 'middle-join-detail':
      return '中缝/拼接细节图';
    default:
      return slotId || '参考图';
  }
}

function getReferenceStylePrompt(slotId) {
  switch (slotId) {
    case 'edge-trim-detail':
      return [
        '请识别这张门业包边参考图中的包边/门套线/收口条外观特征，只返回 JSON。',
        '注意：这张图可能是包边近景，也可能是一整扇门。即使图片是一整扇门，也只能识别门洞周围的包边、门套线、收口条、压线和边缘收口区域，不要识别门扇主体、门板花纹、把手、锁体或整门款式。',
        'JSON 格式必须为：{"part":"包边","sourceType":"近景或整门参考","color":"...","material":"...","finish":"...","shape":"...","structure":"...","profile":"...","edge":"...","details":"...","applyDescription":"..."}。',
        '其中 color 表示可见主颜色，material 表示材质，finish 表示表面工艺或质感，shape 表示整体造型和宽窄比例，structure 表示门套线、收口条、压线、拼接结构，profile 表示截面层次、凹凸、倒角、圆角、折边等轮廓特征，edge 表示边角、转角、收边方式，details 表示纹路、线条、装饰、色差等关键细节。',
        'applyDescription 必须写成可执行的一句话，例如“提取参考图中门洞外圈的浅金木纹窄边门套线和内侧细压线，只迁移包边，不迁移门扇”。',
        '如果参考图是一整扇门，必须在 details 里说明“已忽略门扇主体和把手，只提取包边”。',
        '必须尽量具体，不要只写“普通包边”“金属包边”“木纹包边”这类泛化描述。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'color-sample':
      return [
        '请像 Photoshop 吸管工具一样识别这张门体颜色参考图中肉眼可见的主取样颜色和材质特征，只返回 JSON。',
        'JSON 格式必须为：{"part":"门体颜色","color":"...","colorFamily":"...","undertone":"...","brightness":"...","saturation":"...","hueLock":"...","toneLock":"...","material":"...","finish":"...","shape":"...","structure":"...","details":"...","applyDescription":"..."}。',
        '识别时不要推断“材料本身固有色”，不要自动校正白平衡、环境光或拍摄偏色；看到什么颜色就提取什么颜色。只避开明显高光点、反光点、深阴影、污渍和噪点，从最大、最均匀、最能代表门体表面的区域取样。',
        '其中 color 表示可直接用于生成的具体可见取样色描述，不要只写“深色”“浅色”；colorFamily 表示颜色大类，例如黑、灰、白、棕、红棕、金、香槟、木色等；undertone 表示可见冷暖色偏，例如偏黄、偏红、偏灰、偏蓝、偏金；brightness 表示肉眼可见明度，例如深/中深/中/浅；saturation 表示肉眼可见饱和度，例如低饱和/中饱和/高饱和；hueLock 表示最不能漂移的可见色相约束，例如不要偏红、不要偏黄、不要偏绿、不要偏蓝；toneLock 表示最不能漂移的明暗/灰度约束，例如不要提亮、不要压暗、不要加灰、不要加暖；material 表示材质；finish 表示哑光/亮光/金属/木纹等表面质感；shape 可以写“不适用”；structure 表示纹理方向或拼色关系；details 表示取样区域、木纹、拉丝、颗粒、色差等关键细节；applyDescription 表示给图像编辑模型执行时应使用的一句话颜色描述。',
        '如果图片里有多个颜色，请选择面积最大、最像客户想要门体表面颜色的可见主色，并在 details 里说明次要色或纹理色差。',
        'applyDescription 必须写成“可见取样色”描述，包含颜色大类、冷暖色偏、明度、饱和度和禁止漂移方向，例如“可见取样色为中深低饱和冷灰木色，不要偏黄或提亮”。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    default:
      return '';
  }
}

function getPngSize(buffer) {
  if (!buffer || buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function getJpegSize(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const size = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + size;
  }
  return null;
}

function getImageSize(buffer, fileID) {
  const extension = getFileExtensionFromPath(fileID, 'png');
  if (extension === 'png') {
    return getPngSize(buffer);
  }
  if (extension === 'jpg' || extension === 'jpeg') {
    return getJpegSize(buffer);
  }
  return getPngSize(buffer) || getJpegSize(buffer);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function buildHandleMaskBuffer(width, height, box) {
  const rowLength = 1 + (width * 4);
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixelStart = rowStart + 1 + (x * 4);
      const inside = x >= box.left && x < box.right && y >= box.top && y < box.bottom;
      raw[pixelStart] = 255;
      raw[pixelStart + 1] = 255;
      raw[pixelStart + 2] = 255;
      raw[pixelStart + 3] = inside ? 0 : 255;
    }
  }

  const chunks = [];
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  chunks.push(pngHeader);

  function createChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBuffer, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((crc32(crcInput) >>> 0), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(createChunk('IHDR', ihdr));
  chunks.push(createChunk('IDAT', zlib.deflateSync(raw)));
  chunks.push(createChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeMaskBox(rawBox, size, source) {
  if (!rawBox || !size || !size.width || !size.height) {
    return null;
  }
  const left = clamp(Math.round(rawBox.left), 0, Math.max(size.width - 1, 0));
  const top = clamp(Math.round(rawBox.top), 0, Math.max(size.height - 1, 0));
  const right = clamp(Math.round(rawBox.right), left + 1, size.width);
  const bottom = clamp(Math.round(rawBox.bottom), top + 1, size.height);
  if (right <= left || bottom <= top) {
    return null;
  }
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    source: source || rawBox.source || 'unknown'
  };
}

function inferHandleMaskBox(size, handleBuffer, job) {
  if (!size || !size.width || !size.height) {
    return null;
  }
  const aspect = handleBuffer && handleBuffer.length ? 0.28 : 0.22;
  const boxWidth = Math.max(Math.round(size.width * aspect), 140);
  const boxHeight = Math.max(Math.round(boxWidth * 1.4), 180);
  const isDoubleDoor = /双开|子母|四开|六开/.test(job && job.doorType || '');
  const centerX = isDoubleDoor ? size.width * 0.5 : size.width * 0.78;
  const centerY = size.height * 0.5;
  return normalizeMaskBox({
    left: centerX - (boxWidth / 2),
    top: centerY - (boxHeight / 2),
    right: centerX + (boxWidth / 2),
    bottom: centerY + (boxHeight / 2)
  }, size, isDoubleDoor ? 'door-type-center-heuristic' : 'door-type-side-heuristic');
}

function toDataUrl(buffer, fileID) {
  return `data:${getMimeType(getFileExtensionFromPath(fileID, 'png'))};base64,${buffer.toString('base64')}`;
}

function extractJsonObject(text) {
  if (!text) {
    return null;
  }
  const matched = /\{[\s\S]*\}/.exec(text);
  if (!matched) {
    return null;
  }
  try {
    return JSON.parse(matched[0]);
  } catch (error) {
    return null;
  }
}

async function detectHandleStyle(primaryBuffer, primaryFileID, handleBuffer, handleFileID) {
  if (!handleBuffer) {
    return null;
  }
  const response = await openai.responses.create({
    model: OPENAI_VISION_MODEL,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '请识别第二张门把手细节图中的门把手外观特征，只返回 JSON。',
              'JSON 格式必须为：{"color":"...","material":"...","finish":"...","shape":"...","base":"...","details":"..."}。',
              '其中 color 表示可见主颜色，material 表示材质，finish 表示表面工艺或质感，shape 表示主体造型，base 表示把手底座/面板特征，details 表示纹路、转角、装饰、镂空、线条等关键细节。',
              '不要解释，不要输出 markdown。'
            ].join('\n')
          },
          {
            type: 'input_image',
            image_url: toDataUrl(primaryBuffer, primaryFileID)
          },
          {
            type: 'input_image',
            image_url: toDataUrl(handleBuffer, handleFileID)
          }
        ]
      }
    ]
  });
  const parsed = extractJsonObject(response.output_text || '');
  if (!parsed) {
    return null;
  }
  return {
    color: parsed.color || '',
    colorFamily: parsed.colorFamily || '',
    undertone: parsed.undertone || '',
    brightness: parsed.brightness || '',
    saturation: parsed.saturation || '',
    hueLock: parsed.hueLock || '',
    toneLock: parsed.toneLock || '',
    material: parsed.material || '',
    finish: parsed.finish || '',
    shape: parsed.shape || '',
    base: parsed.base || '',
    details: parsed.details || ''
  };
}

async function detectHandleMaskBox(primaryBuffer, primaryFileID, handleBuffer, handleFileID, size, job) {
  if (!primaryBuffer || !handleBuffer || !size) {
    return null;
  }
  const response = await openai.responses.create({
    model: OPENAI_VISION_MODEL,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '你要定位整门照中的门把手区域。',
              `门类型：${job && job.doorType ? job.doorType : '未指定'}`,
              '第一张图是整门照，第二张图是要融合上去的门把手细节图。',
              '请在整门照中找到最适合替换为该门把手的位置。',
              '只返回 JSON，不要返回任何额外文字。',
              'JSON 格式必须为：{"left":整数,"top":整数,"right":整数,"bottom":整数}。',
              `坐标基于第一张图原始尺寸 width=${size.width}, height=${size.height}。`,
              '如果门上已有把手，就框住原把手区域；如果不明显，也要给出最合理的门把手安装区域。'
            ].join('\n')
          },
          {
            type: 'input_image',
            image_url: toDataUrl(primaryBuffer, primaryFileID)
          },
          {
            type: 'input_image',
            image_url: toDataUrl(handleBuffer, handleFileID)
          }
        ]
      }
    ]
  });
  const text = response.output_text || '';
  const parsed = extractJsonObject(text);
  return normalizeMaskBox(parsed, size, 'vision-detected');
}

async function detectReferenceStyle(referenceImage, referenceBuffer) {
  const prompt = getReferenceStylePrompt(referenceImage && referenceImage.slotId);
  if (!prompt || !referenceBuffer) {
    return null;
  }
  const response = await openai.responses.create({
    model: OPENAI_VISION_MODEL,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt
          },
          {
            type: 'input_image',
            image_url: toDataUrl(referenceBuffer, referenceImage.originalImageFileID)
          }
        ]
      }
    ]
  });
  const parsed = extractJsonObject(response.output_text || '');
  if (!parsed) {
    return null;
  }
  return {
    slotId: referenceImage.slotId || '',
    label: getReferenceSlotLabel(referenceImage.slotId),
    part: parsed.part || getReferenceSlotLabel(referenceImage.slotId),
    sourceType: parsed.sourceType || '',
    color: parsed.color || '',
    colorFamily: parsed.colorFamily || '',
    undertone: parsed.undertone || '',
    brightness: parsed.brightness || '',
    saturation: parsed.saturation || '',
    hueLock: parsed.hueLock || '',
    toneLock: parsed.toneLock || '',
    material: parsed.material || '',
    finish: parsed.finish || '',
    shape: parsed.shape || '',
    structure: parsed.structure || '',
    profile: parsed.profile || '',
    edge: parsed.edge || '',
    details: parsed.details || '',
    applyDescription: parsed.applyDescription || ''
  };
}

function buildReferenceStyleInstruction(referenceStyles, options) {
  const styles = Array.isArray(referenceStyles) ? referenceStyles.filter(Boolean) : [];
  if (!styles.length) {
    return '';
  }
  const useEdgeTrimReferenceColor = !!(options && options.useEdgeTrimReferenceColor);
  return styles.map((style) => (
    style.slotId === 'edge-trim-detail' && !useEdgeTrimReferenceColor
      ? `系统识别到${style.label || style.part || '包边参考图'}结构特征：来源类型=${style.sourceType || '未识别'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；轮廓/形态=${style.shape || '未识别'}；结构=${style.structure || '未识别'}；截面/层次=${style.profile || '未识别'}；边角/收边=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；颜色字段默认忽略，不作为最终包边颜色；执行描述=只提取包边结构、宽窄、层次、线条、纹理走向和收边方式，最终包边颜色跟门体/颜色参考图统一。`
      : `系统识别到${style.label || style.part || '参考图'}特征：来源类型=${style.sourceType || '未识别'}；颜色=${style.color || '未识别'}；颜色大类=${style.colorFamily || '未识别'}；冷暖色偏=${style.undertone || '未识别'}；明度=${style.brightness || '未识别'}；饱和度=${style.saturation || '未识别'}；色相锁定=${style.hueLock || '未识别'}；明暗/灰度锁定=${style.toneLock || '未识别'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；轮廓/形态=${style.shape || '未识别'}；结构=${style.structure || '未识别'}；截面/层次=${style.profile || '未识别'}；边角/收边=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；执行描述=${style.applyDescription || '未识别'}。`
  )).join('\n');
}

function buildDoorImageInstruction(job, maskBox, handleStyle, referenceStyles) {
  const requirementText = job && job.requirement ? String(job.requirement) : '';
  const backgroundInfo = job && job.backgroundInfo ? String(job.backgroundInfo).trim() : '';
  const allowHandleColorChange = /把手.*颜色|颜色.*把手|门把手.*颜色|颜色.*门把手|调成门的颜色|改成门的颜色|同门颜色|跟门同色|与门同色/.test(requirementText);
  const allowHandleStyleChange = /更换把手|更改把手样式|改变把手样式|换个把手|把手款式|把手造型|把手结构/.test(requirementText);
  const allowHandleBaseChange = /去掉底座|删除底座|取消底座|不要底座|只保留把手主体|弱化底座|缩小底座/.test(requirementText);
  const userWantsEdgeTrimDoorColor = /(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:同门|跟门|与门|和门|门体|门扇|整门)[^。；，,.]{0,24}(?:同色|一样|一致|统一)|(?:门体|门扇|整门)[^。；，,.]{0,24}(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:同色|一样|一致|统一)/.test(requirementText);
  const userSpecifiedEdgeTrimColor = /(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:改成|换成|调成|做成|改为|设为|使用|用)[^。；，,.]{0,24}(?:颜色|色|黑|白|灰|棕|木|金|银|红|黄|蓝|绿|深|浅)|(?:黑色|白色|灰色|棕色|木色|金色|银色|深色|浅色)[^。；，,.]{0,24}(?:包边|门套|收口|压线)/.test(requirementText);
  const userWantsEdgeTrimReferenceColor = /(?:包边|门套|收口|压线)[^。；，,.]{0,28}(?:按|跟随|参考|保留|保持|使用|用)[^。；，,.]{0,28}(?:包边参考图|参考图|原图)[^。；，,.]{0,16}(?:颜色|色|固有色)|(?:包边|门套|收口|压线)[^。；，,.]{0,28}(?:不要|不跟|不同|独立|单独|另外|另做)[^。；，,.]{0,28}(?:同门|跟门|门体|门扇|整门|同色|统一|颜色|色)/.test(requirementText);
  const userWantsIndependentEdgeTrimColor = !userWantsEdgeTrimDoorColor && (userSpecifiedEdgeTrimColor || userWantsEdgeTrimReferenceColor);
  const allowEdgeTrimColorChange = userWantsEdgeTrimDoorColor || userSpecifiedEdgeTrimColor || userWantsEdgeTrimReferenceColor;
  const allowEdgeTrimStyleChange = /更换包边|更改包边|改变包边|包边款式|包边造型|包边结构|门套线.*样式|收口条.*样式/.test(requirementText);
  const allowEdgeTrimRemoveChange = /去掉包边|删除包边|取消包边|不要包边|去掉门套线|删除门套线|取消门套线|不要门套线/.test(requirementText);
  const targetParts = Array.isArray(job.targetParts)
    ? job.targetParts.map((item) => {
        if (item === 'handle') {
          return '门把手';
        }
        if (item === 'edge-trim') {
          return '包边';
        }
        if (item === 'door-color') {
          return '门体颜色';
        }
        return item;
      }).filter(Boolean)
    : [];
  const targetPartText = targetParts.length ? targetParts.join('、') : '门体';
  const referenceImages = getReferenceImages(job);
  const imageLines = referenceImages.map((item, index) => {
    const label = getReferenceSlotLabel(item.slotId);
    if (index === 0) {
      return `参考图${index + 1}：${label}。这是唯一底图和唯一门型来源，最终必须像在这张图上做局部编辑。`;
    }
    return `参考图${index + 1}：${label}。这只是对应部件参考，不能作为整门底图或整门款式参考。`;
  });
  const hasHandleDetail = referenceImages.some((item) => item.slotId === 'handle-detail');
  const hasEdgeTrimDetail = referenceImages.some((item) => item.slotId === 'edge-trim-detail');
  const hasColorSample = referenceImages.some((item) => item.slotId === 'color-sample');
  const edgeTrimColorProtectedFromColorSample = hasEdgeTrimDetail && userWantsIndependentEdgeTrimColor;
  const colorSampleAppliesToEdgeTrim = hasColorSample && !edgeTrimColorProtectedFromColorSample;
  const isCutoutRequest = /抠图|扣图|扣出来|抠出来|单独抠|单独扣|单独.*出来|白底|透明底|去背景|去掉背景|去除背景/.test(`${requirementText} ${backgroundInfo}`);
  const maskInstruction = maskBox
    ? `系统检测到门把手编辑区域：left=${maskBox.left}, top=${maskBox.top}, right=${maskBox.right}, bottom=${maskBox.bottom}。本次只允许在该区域及极小衔接边缘内编辑。`
    : `本次未启用区域 mask，请仅围绕目标部件（${targetPartText}）及必要衔接区域做处理，不要扩散到背景、墙面或其他未点名区域。`;
  const handleStyleInstruction = handleStyle && (handleStyle.color || handleStyle.material || handleStyle.finish || handleStyle.shape || handleStyle.base || handleStyle.details)
    ? [
        `系统识别到门把手细节特征：颜色=${handleStyle.color || '未识别'}；材质=${handleStyle.material || '未识别'}；表面质感=${handleStyle.finish || '未识别'}；主体造型=${handleStyle.shape || '未识别'}；底座/面板=${handleStyle.base || '未识别'}；关键细节=${handleStyle.details || '未识别'}。`,
        allowHandleColorChange
          ? '用户这次明确要求调整门把手颜色，因此颜色可以按用户要求改变；但主体造型、材质观感、底座结构和关键细节仍应尽量保持与细节图一致。'
          : '最终成图中的门把手必须优先保持细节图中的颜色，不要因为环境光或门体配色自动改成其他颜色。',
        allowHandleStyleChange
          ? '用户这次明确要求改变把手样式，因此可按要求调整样式；但除用户点名变化外，仍应尽量保留其余细节。'
          : '门把手主体造型、轮廓、线条、转角和装饰细节都应以细节图为准，不要把细节简化成相似但不同的款式。',
        allowHandleBaseChange
          ? '用户这次明确要求调整底座或只保留主体，因此底座相关结构可以按要求删减或弱化；但不要顺带改变把手主体样式。'
          : '底座/面板结构也应尽量保持与细节图一致，不要擅自删除或替换。'
      ].join('\n')
    : hasHandleDetail
      ? '门把手颜色、材质、主体造型、底座结构和关键细节都必须以门把手细节图为准；如果用户明确要求改变其中某项，则只改那一项。'
      : '当前没有门把手细节图，请只在整门图中识别现有门把手；除非用户明确要求，不要擅自改变门把手款式、颜色、材质、底座结构或关键细节。';
  const referenceStyleInstruction = buildReferenceStyleInstruction(referenceStyles, {
    useEdgeTrimReferenceColor: userWantsIndependentEdgeTrimColor
  });
  const edgeTrimStyle = Array.isArray(referenceStyles)
    ? referenceStyles.find((style) => style && style.slotId === 'edge-trim-detail')
    : null;
  const colorSampleStyle = Array.isArray(referenceStyles)
    ? referenceStyles.find((style) => style && style.slotId === 'color-sample')
    : null;
  const allowDoorSurfaceColorChange = hasColorSample || /门.*颜色|颜色.*门|颜色参考|色号|改色|换色|调色|变色|颜色不对|颜色再|颜色偏|YM[-\w]*/i.test(requirementText);
  const allowBackgroundChange = !!backgroundInfo || isCutoutRequest;
  const hasEdgeTrimOnlyReference = hasEdgeTrimDetail && !hasHandleDetail && !allowDoorSurfaceColorChange && !allowBackgroundChange && !allowEdgeTrimColorChange;
  const edgeTrimScopeLimitInstruction = allowDoorSurfaceColorChange
    ? '最高优先级限制：包边替换不是整门换款。包边任务只允许修改包边、门套线、收口条、压线和其极小衔接边缘；包边参考图默认只提供包边结构、宽窄、层次、线条和收边方式，包边颜色默认跟门扇/门体同色，并随颜色参考图一起统一；只有客户明确指定包边独立颜色或按包边参考图颜色时，包边颜色才不跟门体同色。门扇主体造型、门板花纹、门板线条数量、线条位置、门型比例、玻璃、门芯结构、五金把手必须保持整门照原样。严禁为了适配包边而重画门扇。'
    : '最高优先级限制：包边替换不是整门换款。只允许修改包边、门套线、收口条、压线和其极小衔接边缘；包边参考图默认只提供包边结构、宽窄、层次、线条和收边方式，包边颜色默认匹配第一张整门图的门体颜色；门扇主体、门板花纹、门板线条数量、线条位置、门型比例、玻璃、门芯造型、门面颜色、五金把手必须保持整门照原样。严禁为了适配包边而重画门扇。';
  const requiredReferenceTasks = [
    hasHandleDetail ? '门把手：必须按门把手细节图融合/替换' : '',
    hasEdgeTrimDetail ? '包边：必须识别包边参考图中的包边结构并产生可见融合/替换效果，不能保留原包边不变' : '',
    hasColorSample
      ? (edgeTrimColorProtectedFromColorSample
        ? '门体颜色：必须按颜色参考图调整门扇/门体可见表面颜色和材质观感；包边因客户明确要求独立颜色，按客户包边颜色或包边参考图颜色执行'
        : '整门颜色：默认必须按颜色参考图统一调整整门可见门面颜色和材质观感，包含包边/门套同色；如补充要求指定局部不同颜色，则按指定部件优先')
      : ''
  ].filter(Boolean);
  const requiredReferenceTaskInstruction = requiredReferenceTasks.length
    ? [
        `结构化强制任务清单：${requiredReferenceTasks.join('；')}。`,
        '以上任务是并列关系，不是互斥关系；如果同时上传了多个参考图，最终成图必须同时完成这些参考图对应的修改。',
        '不要只执行其中一个参考图任务后忽略其他已上传参考图。',
        hasEdgeTrimDetail
          ? '包边验收标准：只要上传了包边参考图，最终图中包边/门套线/收口条/压线区域必须能看出来自参考图的宽窄、层次、截面、线条或收边方式变化；颜色同门同色不等于完成包边任务，保留原包边结构不变视为失败。'
          : ''
      ].filter(Boolean).join('\n')
    : '';
  const layeredTaskOrderInstruction = requiredReferenceTasks.length
    ? [
        '强制执行顺序：先锁定第一张整门图的门型几何、门扇比例、线条位置和把手位置，再按包边参考图处理包边层，再按颜色参考图处理门体颜色层，最后才处理背景/白底。',
        edgeTrimColorProtectedFromColorSample
          ? '后执行的任务不能覆盖先执行的任务：客户已经明确要求包边独立颜色，因此颜色任务不能把包边统一成门体颜色；背景/白底任务不能删除、变浅、简化或重画包边。'
          : '后执行的任务不能覆盖先执行的任务：颜色任务默认要覆盖门扇、门体、包边、门套、收口条、压线和同门体侧边的可见门面颜色，使包边与门体同色；但不能改变包边参考图提供的宽窄、层次、线条和收边结构；背景/白底任务不能删除、变浅、简化或重画包边。',
        '最终自检：只要上传了包边参考图，成图中门洞周围必须能清楚看到参考包边的宽窄、层次、线条和收边结构；如果包边仍是原图旧结构、没有可见结构变化、白底后变成无层次的普通边框或消失，视为失败。',
        '最终自检：只要同时上传包边参考图和颜色参考图，必须同时完成“包边结构来自包边参考图、整门颜色来自颜色参考图且包边默认同门同色”，不能只改颜色而忽略包边结构。'
      ].join('\n')
    : '';
  const edgeTrimStrictInstruction = hasEdgeTrimDetail
    ? [
        '高优先级指令：包边参考图是包边款式的唯一参考来源，严格程度与门把手细节图相同。',
        '高优先级指令：包边参考图可能是一张包边近景，也可能是一整扇门。无论是哪一种，都只能从中提取门洞周围的包边、门套线、收口条、压线、外框边缘和收边方式。',
        '禁止从包边参考图中迁移门扇主体、门芯造型、门板分割、门板花纹、玻璃、把手、锁体、门扇颜色或整门款式；参考图里那扇门不是要替换的门，只是包边来源。',
        '如果包边参考图是一整扇门，必须把它当作“包边取样图”，不能把它当作“新门样式图”。不要让最终门扇变成包边参考图中的那扇门。',
        '高优先级指令：只要输入中包含包边参考图，本次任务就默认必须执行“把该参考包边融合/替换到整门照中”的操作；这是强制目标，不需要等待客户额外说明，也不能因为颜色同门同色、补充要求为空、背景任务或颜色任务而跳过。',
        '任务目标：请先在整门照中识别原有包边、门套线、门框内外侧收口条、压线和边缘收口区域，再把包边参考图中的包边款式融合到这些对应位置。必须直接观察输入的包边参考图本身，即使系统识别文本为空或不完整，也要从参考图里提取包边结构。',
        '最终输出必须是一张已经使用参考包边后的完整整门效果图，不能只是把包边参考图当作颜色参考，也不能保留与参考图不一致的原包边。颜色同门同色时，也必须通过宽窄、层次、截面、线条、倒角、压线或收边方式体现包边已更换。',
        edgeTrimScopeLimitInstruction,
        allowBackgroundChange
          ? '背景、抠图或白底按客户背景要求执行；但背景变化不能反向改变门扇结构、包边参考任务、门体颜色任务或把手任务。'
          : '墙面、地面、背景和整体构图必须保持整门照原样。',
        '如果模型需要在“更完整地替换包边”和“保持门样式不变”之间取舍，必须优先保持门样式不变，只做更小范围的包边融合。',
        '包边融合失败判定：如果最终图出现新的门板分割、新的浮雕花纹、新的把手位置、新的门扇比例或把主门替换成参考门款式，都属于失败，必须退回为第一张整门图的门扇结构。',
        '包边未执行失败判定：如果最终图的包边/门套线/收口条/压线看起来仍是第一张整门图原来的结构，没有体现参考图的宽窄、层次、截面、线条或收边方式，也属于失败。',
        edgeTrimStyle && edgeTrimStyle.applyDescription
          ? (userWantsIndependentEdgeTrimColor
            ? `包边执行描述：${edgeTrimStyle.applyDescription}。`
            : '包边执行描述：只迁移包边参考图的结构、宽窄、层次、线条、纹理走向和收边方式；忽略包边参考图颜色，最终包边颜色跟门体/颜色参考图统一。')
          : '',
        '最终成图中的包边必须优先保持包边参考图中“门洞周围包边区域”的宽窄比例、截面层次、凹凸倒角、收边方式、线条、纹理走向和关键装饰细节。',
        userWantsIndependentEdgeTrimColor
          ? '客户这次明确要求包边使用独立颜色或按包边参考图颜色，因此包边颜色可以不同于门体；但包边结构、宽窄比例、截面层次、线条和关键细节仍应保持与包边参考图一致。'
          : '默认规则：包边颜色必须跟门扇/门体同色。包边参考图默认不决定最终包边颜色，只决定包边结构、宽窄、层次、线条和收边方式；如果上传了颜色参考图，包边也应随整门一起使用该颜色参考图的颜色。',
        allowEdgeTrimStyleChange
          ? '用户这次明确要求改变包边样式，因此可按要求调整样式；但除用户点名变化外，仍应尽量保留其余包边细节。'
          : '不要把包边简化成相似但不同的款式，不要擅自改变包边宽窄、线条、截面、倒角、收边或拼接结构。',
        allowEdgeTrimRemoveChange
          ? `用户这次明确要求删除或取消包边，因此可以按要求处理包边；但不要顺带改变门把手、门型结构或背景${hasColorSample ? '，门体颜色仍按颜色参考图执行' : '，门体颜色也保持原样'}。`
          : '不要擅自删除、弱化、替换或重新设计包边。'
      ].join('\n')
    : '';
  const auxiliaryReferenceInstruction = [
    hasEdgeTrimDetail
      ? '高优先级指令：输入中包含包边参考图时，系统默认必须自动识别、定位并更换/融合该包边参考；如果参考图是一整扇门，也必须只识别这扇门的包边并 P 到主门上，不需要客户额外说明“把包边 P 上去”。最终包边结构必须有可见变化，不能只保持原包边不动。'
      : '',
    hasColorSample
      ? (edgeTrimColorProtectedFromColorSample
        ? '高优先级指令：输入中包含颜色参考图时，AI 必须自动识别主色、色偏、纹理和表面质感，并默认按该颜色参考图调整门扇/门体可见表面颜色；不需要客户额外说明“改成这个颜色”。本次客户明确要求包边独立颜色，因此包边按客户包边颜色或包边参考图颜色优先。'
        : '高优先级指令：输入中包含颜色参考图时，AI 必须自动识别主色、色偏、纹理和表面质感，并默认按该颜色参考图统一调整整门可见门面颜色，包含包边/门套同色；不需要客户额外说明“改成这个颜色”。如果补充要求明确写了不同部件不同颜色，则按局部指定优先。')
      : '',
    hasEdgeTrimDetail || hasColorSample
      ? (edgeTrimColorProtectedFromColorSample
        ? '包边参考图和颜色参考图只用于约束对应部件；除非用户明确要求，不要因为这些参考图顺带改变门把手、门型结构、门扇样式、背景或其他未点名内容。多张参考图同时存在时，必须像图层编辑一样分别执行：包边层只改包边，颜色层只改门扇/门体可见表面，背景层只改背景；包边独立颜色不要被统一颜色覆盖。'
        : '包边参考图和颜色参考图只用于约束对应部件；除非用户明确要求，不要因为这些参考图顺带改变门把手、门型结构、门扇样式、背景或其他未点名内容。多张参考图同时存在时，必须像图层编辑一样分别执行：包边层只改包边结构，颜色层默认统一整门可见门面颜色并包含包边同色，背景层只改背景；如果用户给某个部件指定了不同颜色，则该部件不要被统一颜色覆盖。')
      : ''
  ].filter(Boolean).join('\n');
  const colorSampleStrictInstruction = hasColorSample
    ? [
        edgeTrimColorProtectedFromColorSample
          ? '高优先级指令：颜色参考图是门扇/门体可见表面的默认颜色和材质观感参考来源，严格程度与门把手、包边参考图相同；但客户已经明确要求包边独立颜色时，包边颜色优先按客户包边颜色或包边参考图颜色执行。'
          : '高优先级指令：颜色参考图是整门默认统一颜色和材质观感的唯一颜色参考来源，严格程度与门把手、包边参考图相同。',
        '颜色取样规则：颜色参考图必须按 Photoshop 吸管工具的思路执行，以图片中肉眼可见的主取样色为准。不要推断材料本身固有色，不要自动校正白平衡、环境光或拍摄偏色；看到什么颜色就用什么颜色。只避开明显高光点、反光点、深阴影、污渍和噪点。',
        colorSampleAppliesToEdgeTrim
          ? '高优先级指令：只要输入中包含颜色参考图，本次任务就默认必须执行“把整门照中的可见门面颜色统一调整为该参考颜色”的操作；这是强制目标，不需要等待客户额外说明。'
          : '高优先级指令：只要输入中包含颜色参考图，本次任务就默认必须执行“把整门照中的门扇/门体可见表面颜色调整为该参考颜色”的操作；这是强制目标，不需要等待客户额外说明。包边因客户明确独立颜色而另行执行。',
        colorSampleAppliesToEdgeTrim
          ? '默认统一范围：门扇正面、门板凹凸面、装饰线/压线、同一门体上的可见侧边、门框/门套/包边等属于这扇门的可见门面区域，默认都应呈现同一参考色系和材质观感，不能只改中间门板而留下其他门面区域明显不同色。'
          : '默认范围：门扇正面、门板凹凸面、门体同材质压线和同门体可见侧边；因为客户明确要求包边独立颜色，本次才排除包边、门套线、收口条和外框边缘的颜色统一。',
        edgeTrimColorProtectedFromColorSample
          ? '优先级例外：客户已经明确指定包边使用独立颜色或按包边参考图颜色，因此包边颜色按该独立要求执行，不被整门统一颜色覆盖；其他部件只有在补充要求明确指定不同颜色时，才按局部颜色优先。'
          : '优先级例外：只有补充要求明确指定某个部件使用不同颜色时，该部件才按局部颜色优先；包边参考图默认只提供结构，不会让包边颜色脱离整门统一颜色。',
        `颜色执行描述：${(colorSampleStyle && (colorSampleStyle.applyDescription || colorSampleStyle.color)) || '以颜色参考图中的可见主取样色、纹理和材质观感为准'}。`,
        `颜色约束：颜色大类=${(colorSampleStyle && colorSampleStyle.colorFamily) || '未识别'}；冷暖色偏=${(colorSampleStyle && colorSampleStyle.undertone) || '未识别'}；明度=${(colorSampleStyle && colorSampleStyle.brightness) || '未识别'}；饱和度=${(colorSampleStyle && colorSampleStyle.saturation) || '未识别'}；色相锁定=${(colorSampleStyle && colorSampleStyle.hueLock) || '未识别'}；明暗/灰度锁定=${(colorSampleStyle && colorSampleStyle.toneLock) || '未识别'}。`,
        colorSampleAppliesToEdgeTrim
          ? '请把颜色参考图中的可见主取样色应用到整门可见门面。不要把参考图颜色重新解释为更亮、更暗、更暖、更冷或更灰的材料固有色。'
          : '请把颜色参考图中的可见主取样色应用到门扇/门体可见表面；包边颜色按客户明确的独立颜色要求处理。不要把参考图颜色重新解释为更亮、更暗、更暖、更冷或更灰的材料固有色。',
        '颜色匹配优先级高于“更自然”“更高级”“更协调”的自动美化；不要为了环境光、背景色或整体风格主动把可见取样色调暖、调冷、调红、调黄、调蓝、提亮、压暗、加灰或降饱和。',
        '必须保持可见取样色的色相、冷暖色偏、明度和饱和度关系。允许为了贴合原图光影做极轻微明暗过渡，但不能改变取样色本身。',
        '如果整门照环境光会让颜色看起来偏色，应优先让最终视觉颜色接近颜色参考图中的可见取样色，而不是校正成模型认为更合理的材质本色。',
        edgeTrimColorProtectedFromColorSample
          ? '颜色任务只允许调整门扇/门体可见表面的颜色、纹理色差和必要材质观感；包边颜色按客户明确的独立包边颜色要求执行，不被颜色参考图覆盖；包边宽窄、层次和线条按包边参考图执行；门型结构、门板线条数量、线条位置、凹凸深浅、玻璃、把手和门框比例必须保持整门照原样。'
          : '颜色任务默认允许统一调整整门可见门面颜色、纹理色差和必要材质观感，包括门扇、压线、同门体侧边和包边/门套等可见门面区域；门型结构、门板线条数量、线条位置、凹凸深浅、玻璃、把手、包边和门框比例必须保持整门照原样。',
        allowBackgroundChange
          ? '背景、抠图或白底按客户背景要求执行；颜色任务不能与背景任务互相覆盖。'
          : '墙面、地面、背景和整体构图必须保持整门照原样。',
        colorSampleAppliesToEdgeTrim
          ? '统一颜色只表示同一扇门的可见门面默认同色系，不表示可以重画门款、增加新线条或改变包边宽窄结构。不要把颜色参考图误当成新的门款式，不要因为改颜色而重绘门扇结构或替换门型。'
          : '门体颜色只表示门扇/门体可见表面按颜色参考图调整，不表示可以重画门款、增加新线条、改变包边颜色或改变包边宽窄结构。不要把颜色参考图误当成新的门款式，不要因为改颜色而重绘门扇结构或替换门型。',
        edgeTrimColorProtectedFromColorSample
          ? '最终自检：客户明确给包边指定了单独颜色或要求按包边参考图颜色时，最终包边必须保持该独立颜色，不能被颜色参考图拉成门扇颜色。'
          : '',
        '如果无法精确匹配颜色，应优先保持门型结构不变，再尽量接近颜色参考图的可见取样色。'
      ].filter(Boolean).join('\n')
    : '';
  const edgeTrimOnlyFreezeInstruction = hasEdgeTrimOnlyReference
    ? [
        '本次只有包边参考图，且客户没有上传颜色参考图，也没有在文字中提出改颜色、改背景或其他变化。',
        '因此本次唯一允许变化的对象是包边/门套线/收口条/压线区域；包边颜色默认匹配第一张整门图的门体颜色，不按包边参考图的颜色独立变化。',
        '虽然颜色默认匹配门体，但包边结构必须发生可见替换：宽窄比例、截面层次、内外线条、压线、倒角或收边方式至少应有一项明显来自包边参考图。',
        '禁止改变门扇样式、门板纹理、门板颜色、门型结构、开门比例、玻璃形状、门把手、锁体、背景和整体构图。',
        '输出应看起来像在原整门照上只更换了包边，而不是重新生成了一扇门。'
      ].join('\n')
    : '';
  const structuredReferenceInstruction = [
    hasHandleDetail
      ? '结构化需求确认：客户上传了门把手细节图，因此“更换/融合门把手”本身已经是明确需求。'
      : '',
    hasEdgeTrimDetail
      ? '结构化需求确认：客户上传了包边参考图，因此“识别参考图中的包边并更换/融合包边”本身已经是明确需求，不应被理解为未点名改动。'
      : '',
    hasColorSample
      ? (edgeTrimColorProtectedFromColorSample
        ? '结构化需求确认：客户上传了颜色参考图，因此“默认按颜色参考调整门扇/门体可见表面颜色和材质观感”本身已经是明确需求；本次包边有独立包边约束，包边不参与门体统一颜色。'
        : '结构化需求确认：客户上传了颜色参考图，因此“默认按颜色参考统一整门可见门面颜色和材质观感，包边跟门体同色”本身已经是明确需求；如补充要求指定局部不同颜色，则局部指定优先。')
      : ''
  ].filter(Boolean).join('\n');
  const immutableBaseDoorInstruction = [
    '最高优先级不可重绘协议：最终图必须沿用第一张整门上下文图中的同一扇门，不能重新画一扇相似的门，不能重新建模，不能替换成商品渲染门。',
    '第一张整门图不是“风格参考”，而是必须被保留的底图。所有修改都必须像在这张底图上做局部修图：只覆盖被允许修改的区域，其他区域应保持原图结构和布局。',
    '绝对冻结项：门扇外轮廓、宽高比例、透视角度、开门方向、门板分割数量、每条装饰线/压线的位置、门芯造型、凹凸深浅、玻璃/镂空位置、把手安装位置、锁体位置、门框和门扇相对比例。',
    '允许变化项只限于已上传参考图、背景信息或客户文字明确要求的对象：包边层只改包边/门套线/收口条/压线区域；颜色层按颜色参考图统一调整整门可见门面，默认覆盖包边并让包边跟门体同色；只有客户明确要求包边独立颜色或按包边参考图颜色时，包边颜色才不参与统一；背景层只改背景或抠图白底；把手层只改把手区域。',
    '如果参考图中的包边、颜色或把手与第一张整门图的门型结构冲突，必须优先保留第一张整门图的门型结构，宁可让局部融合更保守，也不能重画门扇。',
    '失败结果定义：最终图只要出现新的门板线条数量、新的线条位置、新的浮雕/门芯图案、新的门扇比例、新的把手位置、或变成另一扇浅色/深色商品门，就属于失败，必须改回第一张整门图的门型。',
    '不要为了白底、抠图、换颜色、换包边、更干净、更高级、更真实、更协调而重绘门扇主体。'
  ].join('\n');
  const doorIdentityLockInstruction = [
    '最高优先级门型锁定：第一张整门上下文图是最终输出的唯一门型基底，不是风格参考图，也不是可自由重绘的提示图。',
    '本任务是“基于第一张整门图的局部编辑/换色/换包边”，不是“根据参考图重新生成一扇门”。',
    '必须保留第一张整门图里的门扇外轮廓、宽高比例、开门方向、门板分割数量、线条位置、凹凸/浮雕/压线结构、玻璃位置、门芯造型、把手位置和门框相对比例。',
    '包边参考图只约束包边/门套线/收口条/压线区域的结构、宽窄、层次、线条和收边方式；颜色参考图默认约束整门可见门面颜色、纹理色差和材质观感，包含包边同色；门把手细节图只约束门把手区域；背景文字只约束背景或抠图。',
    '如果最终图的门板线条数量、线条位置、门芯造型、门扇比例、把手位置、开门方向或门框比例与第一张整门图明显不同，应视为失败结果，必须改回第一张整门图的门型结构。',
    '不要把第一张整门图重画成另一款门，不要新增或删除门板装饰线，不要把平板门改成浮雕门，也不要把浮雕门改成平板门。',
    '即使用户要求白底、抠图、改颜色或换包边，也只能在第一张整门图的门型结构上完成，不得生成一扇新的商品门。'
  ].join('\n');
  const cutoutPreservationInstruction = isCutoutRequest
    ? [
        '高优先级抠图说明：客户要求抠图、白底或把某一扇门单独扣出来时，含义是从第一张整门图中提取/保留指定门扇并更换背景，不是重新设计一扇新门。',
        '允许删除未被指定的旁边门扇、墙面、地面或原背景；但被保留的目标门扇必须沿用第一张整门图的门型、门板线条、凹凸结构、比例、把手位置和细节。',
        '抠图后即使背景变成白底，也不能因为画面更干净而重新生成门板造型、门芯花纹、把手位置或门框结构。'
      ].join('\n')
    : '';
  const backgroundInstruction = backgroundInfo
    ? [
        `背景要求：${backgroundInfo}`,
        '客户填写了背景信息，因此允许按该背景要求调整门后空间、墙面、地面、光线或场景氛围。',
        '背景调整只控制背景、空间、墙面、地面、光线或抠图白底效果；不能改变门型结构、门框比例、把手位置，也不能覆盖包边、颜色等其他已明确目标任务。'
      ].join('\n')
    : [
        '背景要求：未填写。',
        '高优先级指令：客户没有填写背景信息，因此默认不改背景。',
        '必须保留整门照中的原背景、墙面、地面、空间、光线方向和整体构图；不要为了更高级、更协调或更真实而主动替换、虚化、美化或重绘背景。'
      ].join('\n');
  const modifyScopeInstruction = job && job.actionType === 'modify'
    ? [
        '高优先级指令：本次任务是继续修改，只允许执行用户这一次明确提出的修改要求；已有成功结果中的其他区域保持不变。',
        '系统门型锁定、参考图边界、颜色分层和背景边界继续有效，不能因为继续修改而放宽。',
        '最高原则：只有系统自动任务或用户明确说可以改的属性，才允许改；没有进入本次任务的属性，一律默认不改。',
        '最高原则：宁可少改，也不可多改；宁可保留原状，也不要擅自新增变化。',
        '除非用户这次明确要求改变门把手样式、颜色、材质、底座、轮廓、结构、纹理或装饰细节，否则这些内容都必须保持与当前输入图一致，不得擅自修改。',
        '如果用户明确要求改变其中某一项（例如只改颜色、只去掉底座），则只允许改那一项，其他把手属性仍保持不变。',
        '你必须自己判断用户点名允许改动的是哪一项属性，并把未点名属性视为冻结状态。',
        '除用户点名要改的局部外，其他门体、门框、玻璃、墙面、背景、光影关系和已有把手样式都不要动。',
        '如果用户只要求删除、弱化或调整某个局部，就只处理该局部，不要顺带优化、重绘、替换、美化或修正其他部分。',
        '当用户要求与把手有关的局部调整时，默认先保留现有把手款式、颜色、材质、结构、纹理和细节，只修改被明确点名的那一部分。',
        '如果对用户意图存在歧义，默认选择修改更少、保留更多原始内容的方案。'
      ].join('\n')
    : [
        '高优先级指令：本次只允许围绕系统自动任务（已上传参考图、背景信息）和客户补充要求出图，不要主动扩大发挥范围。',
        '客户补充要求只是一段简单偏好或额外说明，不需要客户自己写“保留门型、识别包边、不要重画、颜色分层”等专业约束；这些由系统自动任务负责。',
        '最高原则：只有系统自动任务或客户明确说可以改的属性，才允许改；没有进入本次任务的属性，一律默认不改。',
        '最高原则：宁可少改，也不可多改；宁可局部不完美，也不要擅自改变未被点名的内容。',
        '如果某个部分没有对应的上传参考图、背景信息或客户明确要求，就不要擅自修改该部分的样式、颜色、材质、结构、纹理、底座、轮廓或细节。',
        '你必须自己判断用户点名允许改动的是哪一项属性，并把未点名属性视为冻结状态。',
        '除目标部件及其必要衔接区域外，其他门体、门框、玻璃、墙面、背景和光影关系都应尽量保持原样。',
        '不要为了追求整体效果而主动重绘、替换、美化、优化、补全或修正未被点名的内容。',
        '如果某种改动会导致目标部件以外的区域发生明显变化，则应优先缩小改动范围，而不是扩大改动。',
        '如果无法同时满足所有要求，应优先保证未进入系统自动任务和补充要求的区域保持不变，其次再完成目标部件修改。'
      ].join('\n');
  const userRequirementInstruction = [
    `客户补充要求：${requirementText.trim() || '未填写'}`,
    '客户补充要求只用于表达简单偏好、额外文字说明或特殊例外，不要求客户写专业提示词。',
    '门型锁定、参考图自动识别、包边独立替换、颜色分层、背景边界和未点名区域冻结都由系统提示词自动处理。',
    '除非客户非常明确地点名要覆盖某个部件的颜色、样式或背景，否则补充要求不能削弱已上传参考图对应的自动任务。'
  ].join('\n');

  return [
    immutableBaseDoorInstruction,
    '请把第一张整门上下文图当作底图，在保留原始拍摄角度和整体构图的前提下做局部编辑。',
    '输出必须是一张基于第一张整门图编辑后的完整整门效果图，不能返回单独的门把手参考图、局部裁切图、拼贴参考图、仅展示局部的图片，也不能返回一张重新设计的新门。',
    '禁止从零生成新门款；禁止把其他参考图中的整门样式迁移到第一张整门图上；禁止把第一张整门图替换成看起来相似但线条、比例、门芯或把手位置不同的新门。',
    `用途：${job.templateType || '门业展示'}`,
    `门类型：${job.doorType || '未指定'}`,
    `目标部件：${targetPartText}`,
    backgroundInstruction,
    userRequirementInstruction,
    imageLines.length ? imageLines.join('\n') : '参考图：未提供多图标记',
    maskInstruction,
    doorIdentityLockInstruction,
    cutoutPreservationInstruction,
    handleStyleInstruction,
    referenceStyleInstruction,
    requiredReferenceTaskInstruction,
    layeredTaskOrderInstruction,
    edgeTrimStrictInstruction,
    auxiliaryReferenceInstruction,
    colorSampleStrictInstruction,
    edgeTrimOnlyFreezeInstruction,
    structuredReferenceInstruction,
    modifyScopeInstruction,
    !hasHandleDetail && !hasEdgeTrimDetail && !hasColorSample
      ? '当前没有门把手细节照，请先在整门图中识别门把手区域，仅围绕门把手及必要衔接区域做处理，不要改变原门的材质、颜色、纹理、漆面和整体结构。'
      : !hasHandleDetail
        ? '当前没有门把手细节照，请保持整门图中的现有门把手，不要擅自改变门把手款式、颜色、材质或底座；本次应优先执行已上传参考图对应的包边或颜色任务。'
        : [
          '高优先级指令：只要输入中包含门把手细节图，本次任务就默认必须执行“把该门把手融合到整门照中”的操作；这是强制目标，不需要等待客户额外说明。',
          '高优先级指令：整门上下文图是最终输出的唯一基底图，必须保留其门扇、门框、材质、颜色、纹理、漆面、表面工艺、光影和整体结构，不得重绘成其他材质或风格。',
          '高优先级指令：任何不属于门把手及其必要衔接区域的变化，都应视为不合格修改，必须避免。',
          '高优先级指令：门把手细节图是门把手款式的唯一参考来源，请先准确识别并提取该门把手主体，不要自行设计、替换或脑补其他把手款式。',
          '任务目标：必须在整门照中原门把手所在位置完成门把手的替换或融合，可理解为把细节图中的门把手直接贴合到整门照中，并输出已经上把手后的最终效果图。',
          '如果整门照中的原把手与细节图不一致，应以细节图中的门把手为准完成替换，而不是保留原把手。',
          '融合时必须优先保持门把手的材质、造型、颜色、纹理、边界、底座结构、边角转折和关键细节一致，再匹配整门图中的位置、比例、透视、光照、阴影与遮挡关系。',
          '除门把手及其必要衔接区域外，禁止修改门板、门框、玻璃、墙面和背景；不要改变原门的材质、颜色、纹理和表面质感。',
          '如果无法同时满足全部要求，也必须优先保证整门材质不变，并且最终成图里明确出现来自细节图款式的门把手；宁可保留细节图中的底座、轮廓、线条、转角和装饰特征，也不要生成一个只有大体相似轮廓的新把手。'
        ].join('\n'),
    '优先围绕目标部件和门体关系做优化，不要把整门上下文误解为所有部件都需要大改。'
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

async function downloadOriginalImage(fileID) {
  const result = await app.downloadFile({
    fileID
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

async function createInputImage(fileID, sourceBuffer, fallbackName) {
  const extension = getFileExtensionFromPath(fileID, 'png');
  return toFile(sourceBuffer, fallbackName || `door-source.${extension}`, {
    type: getMimeType(extension)
  });
}

async function createMaskFile(maskBuffer) {
  return toFile(maskBuffer, 'handle-mask.png', {
    type: 'image/png'
  });
}

async function buildEditArtifacts(job) {
  const primaryImage = getPrimaryReferenceImage(job);
  if (!primaryImage) {
    if (!job.originalImageFileID) {
      throw new Error('缺少原始图片');
    }
    const sourceBuffer = await downloadOriginalImage(job.originalImageFileID);
    console.log('[worker] downloaded source image', job._id || job.jobId, sourceBuffer.length);
    return {
      inputImages: [await createInputImage(job.originalImageFileID, sourceBuffer, 'door-source.png')],
      maskFile: null,
      maskBox: null,
      detectionMode: 'single-image-fallback'
    };
  }

  const primaryBuffer = await downloadOriginalImage(primaryImage.originalImageFileID);
  const inputImages = [await createInputImage(primaryImage.originalImageFileID, primaryBuffer, `${primaryImage.slotId || 'full-door'}.png`)];
  const referenceBuffers = {};
  const handleDetail = getHandleDetailImage(job);
  let handleBuffer = null;
  const referenceImages = getReferenceImages(job);
  for (const referenceImage of referenceImages) {
    if (!referenceImage || !referenceImage.originalImageFileID || referenceImage.slotId === 'full-door') {
      continue;
    }
    const referenceBuffer = await downloadOriginalImage(referenceImage.originalImageFileID);
    referenceBuffers[referenceImage.slotId || referenceImage.originalImageFileID] = referenceBuffer;
    inputImages.push(await createInputImage(
      referenceImage.originalImageFileID,
      referenceBuffer,
      `${referenceImage.slotId || 'reference'}.png`
    ));
    if (handleDetail && referenceImage.slotId === handleDetail.slotId) {
      handleBuffer = referenceBuffer;
    }
  }

  const primarySize = getImageSize(primaryBuffer, primaryImage.originalImageFileID);
  if (!primarySize || !primarySize.width || !primarySize.height) {
    throw new Error('无法识别整门照尺寸，暂时不能生成门把手编辑区域');
  }
  let maskBox = null;
  let maskFile = null;
  let detectionMode = 'none';
  let handleStyle = null;
  const referenceStyles = [];
  const hasMultiPartReference = referenceImages.some((item) => item && ['edge-trim-detail', 'color-sample'].includes(item.slotId));
  if (handleDetail) {
    try {
      handleStyle = await detectHandleStyle(
        primaryBuffer,
        primaryImage.originalImageFileID,
        handleBuffer,
        handleDetail.originalImageFileID
      );
    } catch (error) {
      console.warn('[worker] vision handle style detection failed', job._id || job.jobId, error && error.message ? error.message : error);
    }
    if (hasMultiPartReference) {
      detectionMode = 'multi-part-reference-no-mask';
    } else {
      try {
        maskBox = await detectHandleMaskBox(
          primaryBuffer,
          primaryImage.originalImageFileID,
          handleBuffer,
          handleDetail.originalImageFileID,
          primarySize,
          job
        );
      } catch (error) {
        console.warn('[worker] vision handle detection failed', job._id || job.jobId, error && error.message ? error.message : error);
      }
      if (!maskBox) {
        maskBox = inferHandleMaskBox(primarySize, handleBuffer, job);
      }
      if (!maskBox) {
        throw new Error('未能确定门把手编辑区域');
      }
      const maskBuffer = buildHandleMaskBuffer(primarySize.width, primarySize.height, maskBox);
      maskFile = await createMaskFile(maskBuffer);
      detectionMode = maskBox.source || 'heuristic';
    }
  }
  for (const referenceImage of referenceImages) {
    if (!referenceImage || !['edge-trim-detail', 'color-sample'].includes(referenceImage.slotId)) {
      continue;
    }
    try {
      const style = await detectReferenceStyle(
        referenceImage,
        referenceBuffers[referenceImage.slotId]
      );
      if (style) {
        referenceStyles.push(style);
      }
    } catch (error) {
      console.warn('[worker] vision reference style detection failed', {
        jobId: job._id || job.jobId,
        slotId: referenceImage.slotId,
        message: error && error.message ? error.message : error
      });
    }
  }

  console.log('[worker] downloaded edit artifacts', job._id || job.jobId, {
    inputImageCount: inputImages.length,
    hasHandleDetail: !!handleDetail,
    hasEdgeTrimDetail: referenceImages.some((item) => item && item.slotId === 'edge-trim-detail'),
    hasColorSample: referenceImages.some((item) => item && item.slotId === 'color-sample'),
    referenceSlots: referenceImages.map((item) => item && item.slotId).filter(Boolean),
    primarySize,
    detectionMode,
    maskBox,
    handleStyle,
    referenceStyles
  });

  return {
    inputImages,
    maskFile,
    maskBox,
    detectionMode,
    handleStyle,
    referenceStyles
  };
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

function shouldRetryImageApi(error) {
  if (!error) {
    return false;
  }
  if (error.status === 408 || error.status === 409 || error.status === 429) {
    return true;
  }
  if (error.status >= 500) {
    return true;
  }
  return /timeout|timed out|socket hang up|ECONNRESET|ETIMEDOUT|fetch failed/i.test(error.message || '');
}

function summarizeOpenAIError(error) {
  return {
    name: error && error.name ? error.name : '',
    status: error && error.status ? error.status : '',
    type: error && error.type ? error.type : '',
    code: error && error.code ? error.code : '',
    requestID: error && error.requestID ? error.requestID : '',
    message: error && error.message ? error.message : String(error || '')
  };
}

async function requestEditedImage(jobId, inputImages, prompt, options) {
  const requestOptions = options || {};
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = Date.now();
    try {
      console.log('[worker] calling image api', {
        jobId,
        attempt,
        imageCount: inputImages.length,
        hasMask: !!requestOptions.mask,
        baseURL: getSanitizedBaseUrl(OPENAI_BASE_URL),
        model: OPENAI_IMAGE_MODEL,
        visionModel: OPENAI_VISION_MODEL,
        timeoutMs: OPENAI_IMAGE_TIMEOUT_MS
      });
      const response = await openai.images.edit({
        model: OPENAI_IMAGE_MODEL,
        image: inputImages,
        ...(requestOptions.mask ? { mask: requestOptions.mask } : {}),
        prompt,
        size: '1024x1024'
      }, {
        timeout: OPENAI_IMAGE_TIMEOUT_MS
      });
      console.log('[worker] image api returned', {
        jobId,
        attempt,
        elapsedMs: Date.now() - startedAt
      });
      return response;
    } catch (error) {
      const errorSummary = summarizeOpenAIError(error);
      console.warn('[worker] image api failed', {
        jobId,
        attempt,
        elapsedMs: Date.now() - startedAt,
        baseURL: getSanitizedBaseUrl(OPENAI_BASE_URL),
        model: OPENAI_IMAGE_MODEL,
        ...errorSummary
      });
      if (attempt === 1 && shouldRetryImageApi(error)) {
        console.warn('[worker] retrying image api after retryable error', {
          jobId,
          requestID: errorSummary.requestID,
          message: errorSummary.message
        });
        continue;
      }
      throw error;
    }
  }
}

async function processJob(jobId) {
  assertConfigured();
  console.log('[worker] start processJob', jobId);

  const job = await getJob(jobId);
  console.log('[worker] fetched job', jobId, !!job, job ? Object.keys(job) : [], job && (job.primaryImageFileID || job.originalImageFileID));
  if (!job) {
    throw new Error('未找到任务');
  }
  if (!(job.primaryImageFileID || job.originalImageFileID)) {
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

  const editArtifacts = await buildEditArtifacts(job);
  console.log('[worker] prepared input images', jobId, {
    imageCount: editArtifacts.inputImages.length,
    hasMask: !!editArtifacts.maskFile,
    maskBox: editArtifacts.maskBox,
    detectionMode: editArtifacts.detectionMode
  });
  const prompt = buildDoorImageInstruction(
    job,
    editArtifacts.maskBox,
    editArtifacts.handleStyle,
    editArtifacts.referenceStyles
  );
  console.log('[worker] built prompt', {
    jobId,
    hasHandleDetail: !!getHandleDetailImage(job),
    hasEdgeTrimDetail: getReferenceImages(job).some((item) => item && item.slotId === 'edge-trim-detail'),
    hasColorSample: getReferenceImages(job).some((item) => item && item.slotId === 'color-sample'),
    referenceSlots: getReferenceImages(job).map((item) => item && item.slotId).filter(Boolean),
    referenceImageCount: getReferenceImages(job).length,
    hasMask: !!editArtifacts.maskFile,
    detectionMode: editArtifacts.detectionMode,
    maskBox: editArtifacts.maskBox,
    handleStyle: editArtifacts.handleStyle,
    referenceStyles: editArtifacts.referenceStyles
  });
  const response = await requestEditedImage(jobId, editArtifacts.inputImages, prompt, {
    mask: editArtifacts.maskFile
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
            needsManualReview: /编辑区域|门把手/.test(error && error.message ? error.message : ''),
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
