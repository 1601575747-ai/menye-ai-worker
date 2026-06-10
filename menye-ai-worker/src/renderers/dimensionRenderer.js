'use strict';

const {
  renderDimensionSvgOverlay,
  getRenderPlanSize
} = require('./svgRenderer');

let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  sharp = null;
}

function isBufferLike(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

async function getImageMetadata(image) {
  if (!sharp || !isBufferLike(image)) {
    return null;
  }
  try {
    return await sharp(image).metadata();
  } catch (error) {
    return null;
  }
}

function getOutputSize(renderPlan, metadata) {
  const planSize = getRenderPlanSize(renderPlan);
  return {
    width: Number(metadata && metadata.width) || planSize.width,
    height: Number(metadata && metadata.height) || planSize.height
  };
}

function estimateTextBounds(textItem) {
  const text = String(textItem && textItem.text ? textItem.text : '');
  const lines = text.split('\n');
  const width = Math.max(...lines.map((line) => line.length), 1) * 16;
  const height = Math.max(lines.length, 1) * 30;
  const x = Number(textItem && textItem.position && textItem.position.x) || 0;
  const y = Number(textItem && textItem.position && textItem.position.y) || 0;
  const align = textItem && textItem.align;
  const left = align === 'right'
    ? x - width
    : align === 'center'
      ? x - width / 2
      : x;
  const rotation = Math.abs(Number(textItem && textItem.rotation) || 0) % 180;
  if (rotation > 45 && rotation < 135) {
    return {
      minX: x - height - 18,
      minY: y - width / 2 - 18,
      maxX: x + height + 18,
      maxY: y + width / 2 + 18
    };
  }
  return {
    minX: left - 12,
    minY: y - height - 12,
    maxX: left + width + 12,
    maxY: y + height + 12
  };
}

function mergeBounds(bounds, next) {
  return {
    minX: Math.min(bounds.minX, next.minX),
    minY: Math.min(bounds.minY, next.minY),
    maxX: Math.max(bounds.maxX, next.maxX),
    maxY: Math.max(bounds.maxY, next.maxY)
  };
}

function getRenderBounds(renderPlan, imageSize) {
  const initial = {
    minX: 0,
    minY: 0,
    maxX: imageSize.width,
    maxY: imageSize.height
  };
  let bounds = initial;
  const lines = Array.isArray(renderPlan && renderPlan.lines) ? renderPlan.lines : [];
  const extensionLines = Array.isArray(renderPlan && renderPlan.extensionLines) ? renderPlan.extensionLines : [];
  const texts = Array.isArray(renderPlan && renderPlan.texts) ? renderPlan.texts : [];
  const textOnlyAnnotations = Array.isArray(renderPlan && renderPlan.textOnlyAnnotations)
    ? renderPlan.textOnlyAnnotations
    : [];

  for (const line of lines) {
    if (!line || !line.from || !line.to) {
      continue;
    }
    bounds = mergeBounds(bounds, {
      minX: Math.min(line.from.x, line.to.x) - 28,
      minY: Math.min(line.from.y, line.to.y) - 28,
      maxX: Math.max(line.from.x, line.to.x) + 28,
      maxY: Math.max(line.from.y, line.to.y) + 28
    });
  }
  for (const line of extensionLines) {
    if (!line || !line.from || !line.to) {
      continue;
    }
    bounds = mergeBounds(bounds, {
      minX: Math.min(line.from.x, line.to.x) - 16,
      minY: Math.min(line.from.y, line.to.y) - 16,
      maxX: Math.max(line.from.x, line.to.x) + 16,
      maxY: Math.max(line.from.y, line.to.y) + 16
    });
  }
  for (const text of texts.concat(textOnlyAnnotations)) {
    bounds = mergeBounds(bounds, estimateTextBounds(text));
  }

  return bounds;
}

function getCanvasGeometry(renderPlan, imageSize) {
  const bounds = getRenderBounds(renderPlan, imageSize);
  const margin = 24;
  const left = Math.max(0, Math.ceil(-bounds.minX + margin));
  const top = Math.max(0, Math.ceil(-bounds.minY + margin));
  const right = Math.max(0, Math.ceil(bounds.maxX - imageSize.width + margin));
  const bottom = Math.max(0, Math.ceil(bounds.maxY - imageSize.height + margin));
  return {
    imageOffset: { x: left, y: top },
    imageSize,
    outputSize: {
      width: imageSize.width + left + right,
      height: imageSize.height + top + bottom
    },
    padding: { left, top, right, bottom }
  };
}

function clampContentBox(box, imageSize) {
  if (!box || !imageSize) {
    return null;
  }
  const left = Math.max(0, Math.floor(Number(box.left)));
  const top = Math.max(0, Math.floor(Number(box.top)));
  const right = Math.min(imageSize.width, Math.ceil(Number(box.right)));
  const bottom = Math.min(imageSize.height, Math.ceil(Number(box.bottom)));
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    return null;
  }
  return { left, top, right, bottom };
}

async function makeWhiteboardBase({ image, sourceSize, contentBox }) {
  const flattened = await sharp(image)
    .resize(sourceSize.width, sourceSize.height, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  const box = clampContentBox(contentBox, sourceSize);
  if (!box) {
    return flattened;
  }
  const whiteOutsideSvg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sourceSize.width}" height="${sourceSize.height}" viewBox="0 0 ${sourceSize.width} ${sourceSize.height}">`,
    '<path fill="#ffffff" fill-rule="evenodd" d="',
    `M0 0H${sourceSize.width}V${sourceSize.height}H0Z `,
    `M${box.left} ${box.top}H${box.right}V${box.bottom}H${box.left}Z`,
    '" />',
    '</svg>'
  ].join('');
  return sharp(flattened)
    .composite([{ input: Buffer.from(whiteOutsideSvg), left: 0, top: 0 }])
    .png()
    .toBuffer();
}

function translatePoint(point, offset) {
  return Object.freeze({
    ...point,
    x: point.x + offset.x,
    y: point.y + offset.y
  });
}

function translateRenderPlan(renderPlan, geometry) {
  const offset = geometry.imageOffset;
  return Object.freeze({
    ...(renderPlan || {}),
    lines: Object.freeze((Array.isArray(renderPlan && renderPlan.lines) ? renderPlan.lines : []).map((line) => Object.freeze({
      ...line,
      from: translatePoint(line.from, offset),
      to: translatePoint(line.to, offset)
    }))),
    extensionLines: Object.freeze((Array.isArray(renderPlan && renderPlan.extensionLines) ? renderPlan.extensionLines : []).map((line) => Object.freeze({
      ...line,
      from: translatePoint(line.from, offset),
      to: translatePoint(line.to, offset)
    }))),
    texts: Object.freeze((Array.isArray(renderPlan && renderPlan.texts) ? renderPlan.texts : []).map((text) => Object.freeze({
      ...text,
      position: translatePoint(text.position, offset)
    }))),
    arrows: Object.freeze((Array.isArray(renderPlan && renderPlan.arrows) ? renderPlan.arrows : []).map((arrow) => Object.freeze({
      ...arrow,
      position: translatePoint(arrow.position, offset)
    }))),
    textOnlyAnnotations: Object.freeze((Array.isArray(renderPlan && renderPlan.textOnlyAnnotations) ? renderPlan.textOnlyAnnotations : []).map((annotation) => Object.freeze({
      ...annotation,
      position: translatePoint(annotation.position, offset)
    }))),
    metadata: Object.freeze({
      ...((renderPlan && renderPlan.metadata) || {}),
      imageSize: Object.freeze(geometry.outputSize),
      sourceImageSize: Object.freeze(geometry.imageSize),
      imageOffset: Object.freeze(geometry.imageOffset),
      padding: Object.freeze(geometry.padding)
    })
  });
}

async function renderWithSharp({ image, whiteBackground, svgOverlay, geometry, renderPlan }) {
  if (!sharp) {
    return null;
  }
  const overlayBuffer = Buffer.from(svgOverlay);
  const size = geometry.outputSize;
  const sourceSize = geometry.imageSize;
  const offset = geometry.imageOffset;
  if (whiteBackground && isBufferLike(image)) {
    const baseBuffer = await makeWhiteboardBase({
      image,
      sourceSize,
      contentBox: renderPlan && renderPlan.metadata ? renderPlan.metadata.contentBox : null
    });
    return sharp({
      create: {
        width: size.width,
        height: size.height,
        channels: 4,
        background: '#ffffff'
      }
    })
      .composite([
        { input: baseBuffer, left: offset.x, top: offset.y },
        { input: overlayBuffer, left: 0, top: 0 }
      ])
      .png()
      .toBuffer();
  }
  if (whiteBackground) {
    return sharp({
      create: {
        width: size.width,
        height: size.height,
        channels: 4,
        background: '#ffffff'
      }
    })
      .composite([{ input: overlayBuffer, left: 0, top: 0 }])
      .png()
      .toBuffer();
  }
  if (!isBufferLike(image)) {
    return null;
  }
  const baseBuffer = await sharp(image)
    .resize(sourceSize.width, sourceSize.height, { fit: 'fill' })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: size.width,
      height: size.height,
      channels: 4,
      background: '#ffffff'
    }
  })
    .composite([
      { input: baseBuffer, left: offset.x, top: offset.y },
      { input: overlayBuffer, left: 0, top: 0 }
    ])
    .png()
    .toBuffer();
}

async function renderDimensionAnnotation({ image, imageUrl, renderPlan, whiteBackground } = {}) {
  const imageMetadata = await getImageMetadata(image);
  const sourceSize = getOutputSize(renderPlan, imageMetadata);
  const geometry = getCanvasGeometry(renderPlan, sourceSize);
  const translatedRenderPlan = translateRenderPlan(renderPlan, geometry);
  const shouldDrawSvgBackground = !!whiteBackground && !isBufferLike(image);
  const svgOverlay = renderDimensionSvgOverlay(translatedRenderPlan, { whiteBackground: shouldDrawSvgBackground });

  const resultBuffer = await renderWithSharp({
    image,
    whiteBackground: !!whiteBackground,
    svgOverlay,
    geometry,
    renderPlan
  });

  if (resultBuffer) {
    return Object.freeze({
      resultBuffer,
      rendererType: 'sharp-svg-overlay',
      metadata: Object.freeze({
        whiteBackground: !!whiteBackground,
        imageSize: Object.freeze(geometry.outputSize),
        sourceImageSize: Object.freeze(geometry.imageSize),
        imageOffset: Object.freeze(geometry.imageOffset),
        padding: Object.freeze(geometry.padding),
        lineCount: Array.isArray(renderPlan && renderPlan.lines) ? renderPlan.lines.length : 0,
        textCount: Array.isArray(renderPlan && renderPlan.texts) ? renderPlan.texts.length : 0,
        textOnlyCount: Array.isArray(renderPlan && renderPlan.textOnlyAnnotations) ? renderPlan.textOnlyAnnotations.length : 0,
        imageUrl: imageUrl || ''
      })
    });
  }

  return Object.freeze({
    renderPlan: translatedRenderPlan,
    svgOverlay,
    rendererType: 'frontend-render-plan',
    metadata: Object.freeze({
      whiteBackground: !!whiteBackground,
      imageSize: Object.freeze(geometry.outputSize),
      sourceImageSize: Object.freeze(geometry.imageSize),
      imageOffset: Object.freeze(geometry.imageOffset),
      padding: Object.freeze(geometry.padding),
      lineCount: Array.isArray(renderPlan && renderPlan.lines) ? renderPlan.lines.length : 0,
      textCount: Array.isArray(renderPlan && renderPlan.texts) ? renderPlan.texts.length : 0,
      textOnlyCount: Array.isArray(renderPlan && renderPlan.textOnlyAnnotations) ? renderPlan.textOnlyAnnotations.length : 0,
      imageUrl: imageUrl || '',
      reason: sharp ? 'missing image buffer' : 'sharp unavailable'
    })
  });
}

module.exports = {
  renderDimensionAnnotation
};
