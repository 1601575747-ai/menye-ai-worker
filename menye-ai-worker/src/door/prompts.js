'use strict';

function buildDoorStructurePrompt({ doorType, viewSide, taskType } = {}) {
  return [
    '你只做门结构识别，不生成图片，不修改图片。',
    `任务类型：${taskType || '未指定'}。`,
    `门类型：${doorType || '未指定'}。`,
    `图面方向：${viewSide === 'back' ? 'back' : 'front'}。`,
    '必须只输出 JSON，不要输出 markdown，不要输出自然语言解释。',
    '识别真实实体硬边：门套外沿 outerTrim、门洞 opening、见光 visibleOpening、门扇 doorLeaf。',
    '可见时识别 handle、lock、transom、header；不可见或无法判断时填 null。',
    '阴影、光晕、压缩噪点、背景灰边、地面接触投影不得并入门结构边界。',
    'shadowRegions 必须单独输出，不得作为 outerTrim/opening/visibleOpening/doorLeaf 的来源。',
    'doorBottomY 必须输出；无法判断时填 null，并设置 needsUserAdjustment=true。',
    'heightBottomMode 默认 shared。只有存在下槛、台阶、门洞落差或额外底部结构时才输出 separate。',
    '低置信度字段必须在 confidence 中标 low，不得胡乱补 high。',
    'JSON 字段固定为：doorType, viewSide, boxes, keypoints, modes, confidence, needsUserAdjustment, notes。',
    'boxes 固定包含：outerTrim, opening, visibleOpening, doorLeaf, handle, lock, transom, header, shadowRegions。',
    'keypoints 固定包含：doorBottomY。modes 固定包含：heightBottomMode。',
    'box 格式固定为 {"left":number,"top":number,"right":number,"bottom":number} 或 null。'
  ].join('\n');
}

module.exports = {
  buildDoorStructurePrompt
};
