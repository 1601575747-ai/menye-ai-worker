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

async function renderWithSharp({ image, renderPlan, whiteBackground, svgOverlay, size }) {
  if (!sharp) {
    return null;
  }
  const overlayBuffer = Buffer.from(svgOverlay);
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
  return sharp(image)
    .resize(size.width, size.height, { fit: 'fill' })
    .composite([{ input: overlayBuffer, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

async function renderDimensionAnnotation({ image, imageUrl, renderPlan, whiteBackground } = {}) {
  const imageMetadata = await getImageMetadata(image);
  const size = getOutputSize(renderPlan, imageMetadata);
  const svgOverlay = renderDimensionSvgOverlay({
    ...(renderPlan || {}),
    metadata: {
      ...((renderPlan && renderPlan.metadata) || {}),
      imageSize: size
    }
  }, { whiteBackground: !!whiteBackground });

  const resultBuffer = await renderWithSharp({
    image,
    renderPlan,
    whiteBackground: !!whiteBackground,
    svgOverlay,
    size
  });

  if (resultBuffer) {
    return Object.freeze({
      resultBuffer,
      rendererType: 'sharp-svg-overlay',
      metadata: Object.freeze({
        whiteBackground: !!whiteBackground,
        imageSize: Object.freeze(size),
        lineCount: Array.isArray(renderPlan && renderPlan.lines) ? renderPlan.lines.length : 0,
        textCount: Array.isArray(renderPlan && renderPlan.texts) ? renderPlan.texts.length : 0,
        textOnlyCount: Array.isArray(renderPlan && renderPlan.textOnlyAnnotations) ? renderPlan.textOnlyAnnotations.length : 0,
        imageUrl: imageUrl || ''
      })
    });
  }

  return Object.freeze({
    renderPlan,
    svgOverlay,
    rendererType: 'frontend-render-plan',
    metadata: Object.freeze({
      whiteBackground: !!whiteBackground,
      imageSize: Object.freeze(size),
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
