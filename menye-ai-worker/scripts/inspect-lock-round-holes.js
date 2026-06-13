'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

function parseArgs(argv) {
  const args = {
    imagePath: '',
    annotatePath: '',
    region: 'left',
    failOnExtra: false,
    expectExtra: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fail-on-extra') {
      args.failOnExtra = true;
    } else if (arg === '--expect-extra') {
      args.expectExtra = true;
    } else if (arg === '--annotate') {
      args.annotatePath = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--annotate=')) {
      args.annotatePath = arg.slice('--annotate='.length);
    } else if (arg === '--region') {
      args.region = argv[index + 1] || args.region;
      index += 1;
    } else if (arg.startsWith('--region=')) {
      args.region = arg.slice('--region='.length);
    } else if (!args.imagePath) {
      args.imagePath = arg;
    }
  }

  return args;
}

function getPixelStats(raw, width, x, y) {
  const index = (y * width + x) * 4;
  const r = raw[index];
  const g = raw[index + 1];
  const b = raw[index + 2];
  const alpha = raw[index + 3];
  return {
    alpha,
    luma: (0.299 * r) + (0.587 * g) + (0.114 * b),
    spread: Math.max(r, g, b) - Math.min(r, g, b)
  };
}

function findDarkComponents(raw, width, height, options = {}) {
  const startX = Math.round(width * (options.startXRatio ?? 0));
  const endX = Math.round(width * (options.endXRatio ?? 1));
  const startY = Math.round(height * (options.startYRatio ?? 0));
  const endY = Math.round(height * (options.endYRatio ?? 1));
  const lumaLimit = options.lumaLimit ?? 110;
  const spreadLimit = options.spreadLimit ?? 105;
  const minArea = options.minArea ?? 20;
  const maxArea = options.maxArea ?? 50000;
  const visited = new Uint8Array(width * height);
  const components = [];

  function isDarkPixel(x, y) {
    if (x < startX || x >= endX || y < startY || y >= endY) {
      return false;
    }
    const pixel = getPixelStats(raw, width, x, y);
    return pixel.alpha >= 16 && pixel.luma < lumaLimit && pixel.spread < spreadLimit;
  }

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = y * width + x;
      if (visited[offset] || !isDarkPixel(x, y)) {
        visited[offset] = 1;
        continue;
      }

      const stack = [[x, y]];
      visited[offset] = 1;
      let area = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let sumLuma = 0;

      while (stack.length) {
        const [cx, cy] = stack.pop();
        const pixel = getPixelStats(raw, width, cx, cy);
        area += 1;
        sumLuma += pixel.luma;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);

        const neighbors = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1]
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < startX || nx >= endX || ny < startY || ny >= endY) {
            continue;
          }
          const neighborOffset = ny * width + nx;
          if (visited[neighborOffset]) {
            continue;
          }
          visited[neighborOffset] = 1;
          if (isDarkPixel(nx, ny)) {
            stack.push([nx, ny]);
          }
        }
      }

      if (area < minArea || area > maxArea) {
        continue;
      }

      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      const boxArea = Math.max(1, boxWidth * boxHeight);
      components.push({
        left: minX,
        top: minY,
        right: maxX,
        bottom: maxY,
        width: boxWidth,
        height: boxHeight,
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2,
        area,
        density: area / boxArea,
        meanLuma: sumLuma / Math.max(1, area),
        aspect: boxWidth / Math.max(1, boxHeight)
      });
    }
  }

  return components;
}

const scanRegions = {
  left: {
    startXRatio: 0.12,
    endXRatio: 0.58,
    startYRatio: 0.18,
    endYRatio: 0.86
  },
  right: {
    startXRatio: 0.52,
    endXRatio: 0.96,
    startYRatio: 0.18,
    endYRatio: 0.90
  },
  center: {
    startXRatio: 0.25,
    endXRatio: 0.75,
    startYRatio: 0.18,
    endYRatio: 0.88
  },
  full: {
    startXRatio: 0.04,
    endXRatio: 0.96,
    startYRatio: 0.14,
    endYRatio: 0.90
  }
};

function getScanRegion(regionName) {
  const key = String(regionName || 'left').trim().toLowerCase();
  const customValues = key.split(',').map((value) => Number(value.trim()));
  if (customValues.length === 4 && customValues.every((value) => Number.isFinite(value))) {
    const [startXRatio, startYRatio, endXRatio, endYRatio] = customValues;
    const validCustomRegion = (
      startXRatio >= 0 &&
      startYRatio >= 0 &&
      endXRatio <= 1 &&
      endYRatio <= 1 &&
      startXRatio < endXRatio &&
      startYRatio < endYRatio
    );
    if (!validCustomRegion) {
      throw new Error(`Invalid custom region "${regionName}". Expected x1,y1,x2,y2 ratios between 0 and 1.`);
    }
    return {
      key: 'custom',
      startXRatio,
      endXRatio,
      startYRatio,
      endYRatio
    };
  }
  if (!Object.prototype.hasOwnProperty.call(scanRegions, key)) {
    throw new Error(`Unsupported region "${regionName}". Use one of: ${Object.keys(scanRegions).join(', ')}, or x1,y1,x2,y2 ratios.`);
  }
  return {
    key,
    ...scanRegions[key]
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function svgRect(box, options) {
  const label = options.label || '';
  const stroke = options.stroke || '#ff0000';
  const top = Math.max(0, box.top);
  const left = Math.max(0, box.left);
  const width = Math.max(1, box.right - box.left + 1);
  const height = Math.max(1, box.bottom - box.top + 1);
  const labelY = Math.max(18, top - 8);
  return [
    `<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="none" stroke="${stroke}" stroke-width="4"/>`,
    label
      ? `<text x="${left}" y="${labelY}" font-size="22" font-family="Arial, sans-serif" fill="${stroke}" stroke="white" stroke-width="4" paint-order="stroke">${escapeXml(label)}</text>`
      : ''
  ].filter(Boolean).join('\n');
}

function buildAnnotationSvg(result) {
  const { width, height } = result.imageSize;
  const shapes = [];
  if (result.lockBody) {
    shapes.push(svgRect(result.lockBody, {
      label: 'LOCK BODY',
      stroke: '#00bcd4'
    }));
  }
  result.extraRoundHoleCandidates.forEach((box, index) => {
    shapes.push(svgRect(box, {
      label: `EXTRA HOLE ${index + 1}`,
      stroke: '#ff1744'
    }));
  });
  return Buffer.from([
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect x="0" y="0" width="100%" height="100%" fill="transparent"/>',
    shapes.join('\n'),
    '</svg>'
  ].join('\n'));
}

async function writeAnnotationImage(imagePath, result, annotatePath) {
  const outputPath = path.resolve(annotatePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await sharp(imagePath)
    .composite([{
      input: buildAnnotationSvg(result),
      top: 0,
      left: 0
    }])
    .png()
    .toFile(outputPath);
  return outputPath;
}

function findSmartLockBody(raw, width, height, region) {
  const components = findDarkComponents(raw, width, height, {
    startXRatio: region.startXRatio,
    endXRatio: region.endXRatio,
    startYRatio: region.startYRatio,
    endYRatio: region.endYRatio,
    lumaLimit: 130,
    minArea: 1500,
    maxArea: Math.round(width * height * 0.08)
  });

  return components
    .filter((component) => (
      component.width >= Math.round(width * 0.015) &&
      component.width <= Math.round(width * 0.09) &&
      component.height >= Math.round(height * 0.16) &&
      component.aspect <= 0.35 &&
      component.density >= 0.35
    ))
    .sort((a, b) => (b.area * b.height) - (a.area * a.height))[0] || null;
}

function findExtraRoundHoleCandidates(raw, width, height, lockBody, region) {
  if (!lockBody) {
    return [];
  }

  const components = findDarkComponents(raw, width, height, {
    startXRatio: region.startXRatio,
    endXRatio: region.endXRatio,
    startYRatio: region.startYRatio,
    endYRatio: region.endYRatio,
    lumaLimit: 110,
    minArea: 60,
    maxArea: 1400
  });

  const horizontalTolerance = Math.max(14, lockBody.width * 0.75);
  const verticalGap = Math.max(4, Math.round(height * 0.004));
  const verticalReach = Math.max(36, Math.round(height * 0.09));

  return components
    .filter((component) => {
      const roundish = component.aspect >= 0.55 && component.aspect <= 1.65;
      const compact = component.density >= 0.35 && component.density <= 0.95;
      const plausibleSize = (
        component.width >= Math.round(width * 0.008) &&
        component.width <= Math.round(width * 0.04) &&
        component.height >= Math.round(height * 0.008) &&
        component.height <= Math.round(height * 0.04)
      );
      const underLock = component.top > lockBody.bottom + verticalGap &&
        component.top <= lockBody.bottom + verticalReach;
      const nearLockColumn = component.centerX >= lockBody.left - horizontalTolerance &&
        component.centerX <= lockBody.right + horizontalTolerance;
      return roundish && compact && plausibleSize && underLock && nearLockColumn;
    })
    .sort((a, b) => b.area - a.area);
}

async function inspectImage(imagePath, options = {}) {
  const region = getScanRegion(options.region);
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lockBody = findSmartLockBody(data, info.width, info.height, region);
  const extraRoundHoleCandidates = findExtraRoundHoleCandidates(data, info.width, info.height, lockBody, region);

  return {
    imagePath,
    region,
    imageSize: {
      width: info.width,
      height: info.height
    },
    lockBody,
    extraRoundHoleCandidates,
    hasExtraRoundHole: extraRoundHoleCandidates.length > 0
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.imagePath) {
    console.error('Usage: node scripts/inspect-lock-round-holes.js <imagePath> [--region left|right|center|full] [--fail-on-extra] [--expect-extra] [--annotate <output.png>]');
    process.exit(2);
  }

  const imagePath = path.resolve(args.imagePath);
  if (!fs.existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`);
    process.exit(2);
  }

  const result = await inspectImage(imagePath, { region: args.region });
  if (args.annotatePath) {
    result.annotationPath = await writeAnnotationImage(imagePath, result, args.annotatePath);
  }
  console.log(JSON.stringify(result, null, 2));

  if (args.expectExtra && !result.hasExtraRoundHole) {
    console.error('Expected an extra round hole candidate, but none was detected.');
    process.exit(1);
  }

  if (args.failOnExtra && result.hasExtraRoundHole) {
    console.error('Detected extra round hole candidate outside the smart lock body.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
