'use strict';

const DEFAULT_SIZE = Object.freeze({
  width: 1024,
  height: 1024
});

function escapeXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getRenderPlanSize(renderPlan) {
  const metadataSize = renderPlan && renderPlan.metadata && renderPlan.metadata.imageSize;
  const width = Number(metadataSize && metadataSize.width) || DEFAULT_SIZE.width;
  const height = Number(metadataSize && metadataSize.height) || DEFAULT_SIZE.height;
  return { width, height };
}

function renderMultilineText(text, x, y, options = {}) {
  const lines = String(text || '').split('\n');
  const anchor = options.anchor || 'start';
  const baseline = options.baseline || 'middle';
  const lineHeight = Number(options.lineHeight) || 28;
  return [
    `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="${baseline}" class="${options.className || 'dimension-text'}">`,
    lines.map((line, index) => {
      const dy = index === 0 ? 0 : lineHeight;
      return `<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`;
    }).join(''),
    '</text>'
  ].join('');
}

function renderLine(line) {
  return `<line id="${escapeXml(line.id)}" x1="${line.from.x}" y1="${line.from.y}" x2="${line.to.x}" y2="${line.to.y}" class="dimension-line" marker-start="url(#arrow)" marker-end="url(#arrow)" />`;
}

function renderText(text) {
  const anchor = text.align === 'right'
    ? 'end'
    : text.align === 'center'
      ? 'middle'
      : 'start';
  const baseline = text.baseline === 'bottom'
    ? 'text-after-edge'
    : text.baseline === 'middle'
      ? 'middle'
      : 'text-before-edge';
  return renderMultilineText(text.text, text.position.x, text.position.y, {
    anchor,
    baseline,
    className: 'dimension-text'
  });
}

function renderTextOnly(annotation) {
  return renderMultilineText(annotation.text, annotation.position.x, annotation.position.y, {
    anchor: 'start',
    baseline: 'middle',
    className: 'dimension-text-only',
    lineHeight: 30
  });
}

function renderDimensionSvgOverlay(renderPlan, options = {}) {
  const size = getRenderPlanSize(renderPlan);
  const lines = Array.isArray(renderPlan && renderPlan.lines) ? renderPlan.lines : [];
  const texts = Array.isArray(renderPlan && renderPlan.texts) ? renderPlan.texts : [];
  const textOnlyAnnotations = Array.isArray(renderPlan && renderPlan.textOnlyAnnotations)
    ? renderPlan.textOnlyAnnotations
    : [];
  const background = options.whiteBackground
    ? `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="#fff" />`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`,
    '<defs>',
    '<marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto-start-reverse">',
    '<path d="M 0 0 L 8 4 L 0 8 z" fill="#111" />',
    '</marker>',
    '<style>',
    '.dimension-line{stroke:#111;stroke-width:2;fill:none;shape-rendering:crispEdges;}',
    '.dimension-text,.dimension-text-only{font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;font-size:24px;font-weight:500;fill:#111;}',
    '.dimension-text{paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round;}',
    '.dimension-text-only{font-size:26px;}',
    '</style>',
    '</defs>',
    background,
    '<g id="dimension-lines">',
    lines.map(renderLine).join(''),
    '</g>',
    '<g id="dimension-texts">',
    texts.map(renderText).join(''),
    '</g>',
    '<g id="dimension-text-only">',
    textOnlyAnnotations.map(renderTextOnly).join(''),
    '</g>',
    '</svg>'
  ].join('');
}

module.exports = {
  renderDimensionSvgOverlay,
  getRenderPlanSize
};
