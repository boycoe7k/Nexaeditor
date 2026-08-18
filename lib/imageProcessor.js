const sharp = require('sharp');

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * Builds an SVG buffer used for text / shape / vignette overlays.
 * Sharp composites SVG buffers directly, no native canvas dependency needed
 * (keeps this deployable on Render without extra system libs).
 */
function svgBuffer(width, height, innerSvg) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${innerSvg}</svg>`
  );
}

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---- individual operation handlers -----------------------------------
// Each handler receives (sharpInstance, params, meta{width,height}) and
// returns either a new sharp instance, or a promise resolving to one.

const ops = {
  // ---------- transform ----------
  crop: (img, p) =>
    img.extract({
      left: Math.round(p.x ?? p.left ?? 0),
      top: Math.round(p.y ?? p.top ?? 0),
      width: Math.round(p.width),
      height: Math.round(p.height),
    }),

  rotate: (img, p) =>
    img.rotate(Number(p.angle) || 0, {
      background: p.background || { r: 0, g: 0, b: 0, alpha: 0 },
    }),

  straighten: (img, p) =>
    img.rotate(Number(p.angle) || 0, {
      background: p.background || { r: 255, g: 255, b: 255, alpha: 1 },
    }),

  flip: (img, p) => {
    if (p.direction === 'vertical') return img.flip();
    return img.flop(); // horizontal (default)
  },

  resize: (img, p) =>
    img.resize({
      width: p.width ? Math.round(p.width) : undefined,
      height: p.height ? Math.round(p.height) : undefined,
      fit: p.fit || 'cover',
      withoutEnlargement: p.withoutEnlargement || false,
    }),

  // ---------- adjustments ----------
  brightness: (img, p) =>
    img.modulate({ brightness: clamp(1 + Number(p.value ?? 0) / 100, 0, 3) }),

  saturation: (img, p) =>
    img.modulate({ saturation: clamp(1 + Number(p.value ?? 0) / 100, 0, 3) }),

  hue: (img, p) => img.modulate({ hue: Number(p.degrees ?? p.value ?? 0) }),

  contrast: (img, p) => {
    const c = clamp(Number(p.value ?? 0), -100, 100) * 2.55; // -255..255
    const a = (259 * (c + 255)) / (255 * (259 - c));
    const b = 128 * (1 - a);
    return img.linear(a, b);
  },

  exposure: (img, p) => {
    const factor = clamp(1 + Number(p.value ?? 0) / 100, 0, 4);
    return img.linear(factor, 0);
  },

  sharpen: (img, p) => img.sharpen({ sigma: Number(p.sigma ?? 1.5) }),

  blur: (img, p) => img.blur(clamp(Number(p.sigma ?? 5), 0.3, 1000)),

  grayscale: (img) => img.grayscale(),

  sepia: (img) =>
    img.recomb([
      [0.393, 0.769, 0.189],
      [0.349, 0.686, 0.168],
      [0.272, 0.534, 0.131],
    ]),

  invert: (img) => img.negate({ alpha: false }),

  temperature: (img, p) => {
    // positive = warmer (more red/less blue), negative = cooler
    const v = clamp(Number(p.value ?? 0), -100, 100);
    return img.tint({
      r: 255,
      g: 255,
      b: clamp(255 - v * 1.2, 0, 255),
    });
  },

  tint: (img, p) => img.tint(p.color || { r: 255, g: 255, b: 255 }),

  opacity: (img, p) =>
    img.ensureAlpha(clamp(Number(p.value ?? 100) / 100, 0, 1)),

  // ---------- effects ----------
  pixelate: async (img, p, meta) => {
    const size = clamp(Number(p.size ?? 12), 2, 200);
    const w = Math.max(1, Math.round(meta.width / size));
    const h = Math.max(1, Math.round(meta.height / size));
    const buf = await img
      .resize(w, h, { kernel: 'nearest' })
      .toBuffer();
    return sharp(buf).resize(meta.width, meta.height, { kernel: 'nearest' });
  },
  mosaic: (img, p, meta) => ops.pixelate(img, p, meta),

  posterize: async (img, p, meta) => {
    const levels = clamp(Math.round(Number(p.levels ?? 4)), 2, 32);
    const { data, info } = await img
      .raw()
      .toBuffer({ resolveWithObject: true });
    const step = 255 / (levels - 1);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.round(Math.round(data[i] / step) * step);
    }
    return sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    });
  },

  edgeDetect: (img) =>
    img.grayscale().convolve({
      width: 3,
      height: 3,
      kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1],
    }),

  emboss: (img) =>
    img.grayscale().convolve({
      width: 3,
      height: 3,
      kernel: [-2, -1, 0, -1, 1, 1, 0, 1, 2],
      offset: 128,
    }),

  noiseReduction: (img, p) => img.median(clamp(Number(p.size ?? 3), 1, 9)),

  vignette: (img, p, meta) => {
    const intensity = clamp(Number(p.intensity ?? 60), 0, 100) / 100;
    const svg = svgBuffer(
      meta.width,
      meta.height,
      `<defs><radialGradient id="v" cx="50%" cy="50%" r="75%">
        <stop offset="55%" stop-color="black" stop-opacity="0"/>
        <stop offset="100%" stop-color="black" stop-opacity="${intensity}"/>
      </radialGradient></defs>
      <rect width="100%" height="100%" fill="url(#v)"/>`
    );
    return img.composite([{ input: svg, blend: 'multiply' }]);
  },

  // ---------- text ----------
  text: (img, p, meta) => {
    const x = Number(p.x ?? 20);
    const y = Number(p.y ?? 40);
    const fontSize = Number(p.fontSize ?? 32);
    const fill = p.color || '#ffffff';
    const stroke = p.strokeColor;
    const strokeWidth = p.strokeWidth ?? (stroke ? 2 : 0);
    const weight = p.bold ? 'bold' : 'normal';
    const style = p.italic ? 'italic' : 'normal';
    const anchor = p.align === 'center' ? 'middle' : p.align === 'right' ? 'end' : 'start';
    const rotation = Number(p.rotation ?? 0);
    const opacity = clamp(Number(p.opacity ?? 100) / 100, 0, 1);
    const spacing = p.letterSpacing ?? 0;
    const shadow = p.shadow
      ? `<feDropShadow dx="2" dy="2" stdDeviation="2" flood-color="black" flood-opacity="0.6"/>`
      : '';
    const filterDef = p.shadow
      ? `<filter id="ds" x="-50%" y="-50%" width="200%" height="200%">${shadow}</filter>`
      : '';
    const filterAttr = p.shadow ? 'filter="url(#ds)"' : '';

    const svg = svgBuffer(
      meta.width,
      meta.height,
      `<defs>${filterDef}</defs>
      <text x="${x}" y="${y}" font-family="${escapeXml(p.fontFamily || 'sans-serif')}"
        font-size="${fontSize}" font-weight="${weight}" font-style="${style}"
        fill="${fill}" fill-opacity="${opacity}" text-anchor="${anchor}"
        letter-spacing="${spacing}" ${filterAttr}
        ${stroke ? `stroke="${stroke}" stroke-width="${strokeWidth}"` : ''}
        transform="rotate(${rotation} ${x} ${y})">${escapeXml(p.text || '')}</text>`
    );
    return img.composite([{ input: svg, top: 0, left: 0 }]);
  },

  // ---------- shapes ----------
  rectangle: (img, p, meta) => {
    const svg = svgBuffer(
      meta.width,
      meta.height,
      `<rect x="${p.x ?? 0}" y="${p.y ?? 0}" width="${p.width ?? 100}" height="${p.height ?? 100}"
        fill="${p.fill || 'none'}" stroke="${p.stroke || '#ff0000'}" stroke-width="${p.strokeWidth ?? 3}"
        fill-opacity="${clamp(Number(p.opacity ?? 100) / 100, 0, 1)}"/>`
    );
    return img.composite([{ input: svg }]);
  },

  circle: (img, p, meta) => {
    const svg = svgBuffer(
      meta.width,
      meta.height,
      `<ellipse cx="${p.cx ?? p.x ?? 50}" cy="${p.cy ?? p.y ?? 50}" rx="${p.rx ?? p.radius ?? 40}" ry="${p.ry ?? p.radius ?? 40}"
        fill="${p.fill || 'none'}" stroke="${p.stroke || '#ff0000'}" stroke-width="${p.strokeWidth ?? 3}"
        fill-opacity="${clamp(Number(p.opacity ?? 100) / 100, 0, 1)}"/>`
    );
    return img.composite([{ input: svg }]);
  },

  line: (img, p, meta) => {
    const svg = svgBuffer(
      meta.width,
      meta.height,
      `<line x1="${p.x1 ?? 0}" y1="${p.y1 ?? 0}" x2="${p.x2 ?? 100}" y2="${p.y2 ?? 100}"
        stroke="${p.stroke || '#ff0000'}" stroke-width="${p.strokeWidth ?? 3}"/>`
    );
    return img.composite([{ input: svg }]);
  },

  arrow: (img, p, meta) => {
    const x1 = p.x1 ?? 0, y1 = p.y1 ?? 0, x2 = p.x2 ?? 100, y2 = p.y2 ?? 100;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = p.headLength ?? 14;
    const stroke = p.stroke || '#ff0000';
    const strokeWidth = p.strokeWidth ?? 3;
    const hx1 = x2 - headLen * Math.cos(angle - Math.PI / 6);
    const hy1 = y2 - headLen * Math.sin(angle - Math.PI / 6);
    const hx2 = x2 - headLen * Math.cos(angle + Math.PI / 6);
    const hy2 = y2 - headLen * Math.sin(angle + Math.PI / 6);
    const svg = svgBuffer(
      meta.width,
      meta.height,
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${strokeWidth}"/>
       <polygon points="${x2},${y2} ${hx1},${hy1} ${hx2},${hy2}" fill="${stroke}"/>`
    );
    return img.composite([{ input: svg }]);
  },
  // ---------- compositing ----------
  watermark: async (img, p, meta) => {
    let overlayBuf;
    if (p.imageBase64) {
      overlayBuf = Buffer.from(p.imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    } else if (p.imageUrl) {
      const res = await fetch(p.imageUrl);
      if (!res.ok) throw new Error(`Failed to fetch overlay image: ${res.status}`);
      overlayBuf = Buffer.from(await res.arrayBuffer());
    } else {
      throw new Error('watermark op requires imageUrl or imageBase64');
    }

    let overlay = sharp(overlayBuf);
    if (p.width || p.height) {
      overlay = overlay.resize(
        p.width ? Math.round(p.width) : undefined,
        p.height ? Math.round(p.height) : undefined
      );
    }
    if (p.opacity !== undefined) {
      overlay = overlay.ensureAlpha(clamp(Number(p.opacity) / 100, 0, 1));
    }
    const overlayBuffer = await overlay.toBuffer();
    return img.composite([
      {
        input: overlayBuffer,
        top: Math.round(p.y ?? 0),
        left: Math.round(p.x ?? 0),
        blend: p.blend || 'over',
      },
    ]);
  },
};

/**
 * Runs a pipeline of operations sequentially over an input image buffer.
 * @param {Buffer} inputBuffer
 * @param {Array<{op: string, [key:string]: any}>} operations
 * @param {{format?: string, quality?: number}} outputOpts
 */
async function runPipeline(inputBuffer, operations = [], outputOpts = {}) {
  let img = sharp(inputBuffer, { failOn: 'none' });
  let meta = await img.metadata();

  for (const step of operations) {
    const handler = ops[step.op];
    if (!handler) {
      throw new Error(`Unknown operation: "${step.op}"`);
    }
    const result = await handler(img, step, {
      width: meta.width,
      height: meta.height,
    });
    img = result;
    // refresh metadata after ops that can change dimensions
    if (['crop', 'resize', 'rotate', 'straighten', 'pixelate', 'mosaic'].includes(step.op)) {
      const buf = await img.toBuffer();
      img = sharp(buf);
      meta = await img.metadata();
    }
  }

  const format = (outputOpts.format || meta.format || 'png').toLowerCase();
  const quality = outputOpts.quality ? Number(outputOpts.quality) : undefined;

  if (format === 'jpg' || format === 'jpeg') {
    img = img.jpeg({ quality: quality || 90 });
  } else if (format === 'webp') {
    img = img.webp({ quality: quality || 90 });
  } else {
    img = img.png();
  }

  const outBuffer = await img.toBuffer();
  return { buffer: outBuffer, format: format === 'jpg' ? 'jpeg' : format };
}

module.exports = { runPipeline, availableOps: Object.keys(ops) };
