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

function buildDoorStructureRefinementPrompt({ doorType, viewSide, taskType, imageSize, heuristicStructure } = {}) {
  const sizeText = imageSize && imageSize.width && imageSize.height
    ? `原图像素尺寸：width=${imageSize.width}, height=${imageSize.height}。所有坐标必须使用这个原图像素坐标，不要输出 0-1 比例。`
    : '所有坐标必须使用原图像素坐标，不要输出 0-1 比例。';
  const heuristicText = heuristicStructure
    ? JSON.stringify({
      boxes: heuristicStructure.boxes || {},
      keypoints: heuristicStructure.keypoints || {},
      modes: heuristicStructure.modes || {},
      confidence: heuristicStructure.confidence || {},
      notes: heuristicStructure.notes || ''
    })
    : '{}';
  return [
    buildDoorStructurePrompt({ doorType, viewSide, taskType }),
    sizeText,
    '你现在是在校正程序给出的候选门结构边界。候选结果可能不准，必须以图片中真实实体硬边为准。',
    '候选 DoorStructure JSON：',
    heuristicText,
    '尺寸标注边界定义：',
    '- outerTrim：含包边、门头、门柱、外框装饰在内的整体门体最外硬边；不要包含阴影、背景灰边、墙面、地面投影。',
    '- opening：门洞/门框结构边界。对于带门头、气窗或上横梁的门，opening.top 应落在门洞开始处的横向硬边，不要落在最上方拱头或背景上沿；如果无法稳定判断半包边位置，可先贴近门洞结构硬边。',
    '- visibleOpening：见光尺寸边界，也就是门和包边之间的连接硬边；visibleOpening.top 应落在门与上包边连接处或门扇可见区域上沿。',
    '- opening.left/right 必须取整个门洞左右硬边，不得取中缝、门扇分缝、玻璃竖线、装饰线、把手、锁体或局部门板线条。',
    '- visibleOpening.left/right 必须取整组可见开口的左右边界，不得只圈单个门扇、单个玻璃窗、单侧装饰区域或中间窄区域。',
    '- 双开门、子母门、四开门、六开门的 opening/visibleOpening 应跨完整门组；除非图片中真实门洞就是窄单扇，否则宽度不能被中间竖向装饰边缘截断。',
    '- header：含门头高/宽使用的整体边界，应包含门和门头门柱的总宽高；没有独立门头时可与 outerTrim 接近。',
    '- transom：含气窗高只需要准确的 transom.top；它应是气窗/上亮/上部区域最上沿，底部高度计算会共用 doorBottomY。',
    '- doorBottomY：门体真实底部同一水平边界。底部没有额外部件时所有高度共用这一条，不得把地面阴影、反光、压缩灰边当作底部。',
    '如果某个边界被遮挡或图片不足以判断，给该字段 confidence 标 low，并设置 needsUserAdjustment=true；不要硬猜成 high。',
    '最终仍然只输出一个 JSON 对象，不要输出解释。'
  ].join('\n');
}

module.exports = {
  buildDoorStructurePrompt,
  buildDoorStructureRefinementPrompt
};
