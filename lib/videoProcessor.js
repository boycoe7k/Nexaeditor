const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const TMP_DIR = path.join(os.tmpdir(), 'darkroom-video');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const tmpFile = (ext) => path.join(TMP_DIR, `${crypto.randomUUID()}.${ext}`);

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function escapeDrawtext(str = '') {
  return String(str)
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019");
}

function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

/**
 * Builds an ffmpeg filter_complex graph from an ordered operations list.
 * Returns { filters: string[], extraInputs: [{path, type}], vLabel, aLabel, hasAudio }
 */
function buildGraph(operations, meta) {
  const filters = [];
  const extraInputs = [];
  let v = '0:v';
  let a = meta.hasAudio ? '0:a' : null;
  let n = 0;
  const next = (prefix) => `${prefix}${n++}`;

  const pushV = (filterStr) => {
    const out = next('v');
    filters.push(`[${v}]${filterStr}[${out}]`);
    v = out;
  };
  const pushA = (filterStr) => {
    if (!a) return;
    const out = next('a');
    filters.push(`[${a}]${filterStr}[${out}]`);
    a = out;
  };

  for (const step of operations) {
    const p = step;
    switch (step.op) {
      case 'trim': {
        const start = Number(p.start ?? 0);
        const end = p.end !== undefined ? Number(p.end) : (p.duration !== undefined ? start + Number(p.duration) : undefined);
        const trimArgs = end !== undefined ? `start=${start}:end=${end}` : `start=${start}`;
        pushV(`trim=${trimArgs},setpts=PTS-STARTPTS`);
        if (a) pushA(`atrim=${trimArgs},asetpts=PTS-STARTPTS`);
        break;
      }
      case 'crop':
        pushV(`crop=${Math.round(p.width)}:${Math.round(p.height)}:${Math.round(p.x ?? 0)}:${Math.round(p.y ?? 0)}`);
        break;
      case 'resize':
        pushV(`scale=${p.width ?? -1}:${p.height ?? -1}`);
        break;
      case 'rotate': {
        const angle = ((Number(p.angle) % 360) + 360) % 360;
        if (angle === 90) pushV('transpose=1');
        else if (angle === 180) pushV('hflip,vflip');
        else if (angle === 270) pushV('transpose=2');
        else pushV(`rotate=${(angle * Math.PI) / 180}`);
        break;
      }
      case 'flip':
        pushV(p.direction === 'vertical' ? 'vflip' : 'hflip');
        break;
      case 'speed': {
        const factor = clamp(Number(p.factor ?? 1), 0.25, 4);
        pushV(`setpts=${(1 / factor).toFixed(6)}*PTS`);
        if (a) {
          // atempo only supports 0.5-2.0 per stage; chain stages for extreme factors
          let remaining = factor;
          const stages = [];
          while (remaining < 0.5 || remaining > 2.0) {
            const stage = remaining > 2.0 ? 2.0 : 0.5;
            stages.push(stage);
            remaining /= stage;
          }
          stages.push(remaining);
          pushA(stages.map((s) => `atempo=${s.toFixed(3)}`).join(','));
        }
        break;
      }
      case 'brightness':
        pushV(`eq=brightness=${clamp(Number(p.value ?? 0) / 100, -1, 1)}`);
        break;
      case 'contrast':
        pushV(`eq=contrast=${clamp(1 + Number(p.value ?? 0) / 100, 0, 3)}`);
        break;
      case 'saturation':
        pushV(`eq=saturation=${clamp(1 + Number(p.value ?? 0) / 100, 0, 3)}`);
        break;
      case 'hue':
        pushV(`hue=h=${Number(p.degrees ?? 0)}`);
        break;
      case 'grayscale':
        pushV('hue=s=0');
        break;
      case 'sepia':
        pushV('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:0');
        break;
      case 'invert':
        pushV('negate');
        break;
      case 'blur':
        pushV(`boxblur=${clamp(Number(p.radius ?? 5), 1, 40)}:1`);
        break;
      case 'sharpen':
        pushV(`unsharp=5:5:${clamp(Number(p.amount ?? 1), 0.1, 3)}`);
        break;
      case 'vignette':
        pushV('vignette');
        break;
      case 'volume':
        pushA(`volume=${clamp(Number(p.value ?? 100) / 100, 0, 5)}`);
        break;
      case 'mute':
        pushA('volume=0');
        break;
      case 'fadeIn':
        pushV(`fade=t=in:st=0:d=${Number(p.duration ?? 1)}`);
        if (a) pushA(`afade=t=in:st=0:d=${Number(p.duration ?? 1)}`);
        break;
      case 'fadeOut': {
        const total = meta.duration || 0;
        const d = Number(p.duration ?? 1);
        const st = Math.max(0, total - d);
        pushV(`fade=t=out:st=${st.toFixed(2)}:d=${d}`);
        if (a) pushA(`afade=t=out:st=${st.toFixed(2)}:d=${d}`);
        break;
      }
      case 'text': {
        const x = p.x ?? 20;
        const y = p.y ?? 40;
        const fontSize = p.fontSize ?? 32;
        const color = p.color || 'white';
        const enable = p.start !== undefined || p.end !== undefined
          ? `:enable='between(t,${p.start ?? 0},${p.end ?? 999999})'`
          : '';
        const box = p.background ? `:box=1:boxcolor=${p.background}@0.5:boxborderw=8` : '';
        pushV(
          `drawtext=text='${escapeDrawtext(p.text || '')}':x=${x}:y=${y}:fontsize=${fontSize}:fontcolor=${color}${box}${enable}`
        );
        break;
      }
      case 'watermark': {
        extraInputs.push({ path: p._resolvedPath, type: 'image' });
        const idx = extraInputs.length; // 1-based (0 is main input)
        const out = next('v');
        const enable = p.start !== undefined || p.end !== undefined
          ? `:enable='between(t,${p.start ?? 0},${p.end ?? 999999})'`
          : '';
        filters.push(`[${idx}:v]scale=${p.width ?? -1}:${p.height ?? -1}[wm${idx}]`);
        filters.push(`[${v}][wm${idx}]overlay=${p.x ?? 0}:${p.y ?? 0}${enable}[${out}]`);
        v = out;
        break;
      }
      case 'audioReplace': {
        extraInputs.push({ path: p._resolvedPath, type: 'audio' });
        const idx = extraInputs.length;
        a = `${idx}:a`;
        break;
      }
      case 'audioMix': {
        extraInputs.push({ path: p._resolvedPath, type: 'audio' });
        const idx = extraInputs.length;
        const out = next('a');
        if (a) {
          filters.push(`[${a}][${idx}:a]amix=inputs=2:duration=first:dropout_transition=2[${out}]`);
        } else {
          filters.push(`[${idx}:a]anull[${out}]`);
        }
        a = out;
        break;
      }
      default:
        throw new Error(`Unknown video operation: "${step.op}"`);
    }
  }

  return { filters, extraInputs, vLabel: v, aLabel: a };
}

async function resolveSource(source) {
  // source: {file: buffer} | {url: string} | {base64: string}
  if (source.buffer) {
    const p = tmpFile(source.ext || 'mp4');
    fs.writeFileSync(p, source.buffer);
    return p;
  }
  if (source.url) {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`Failed to fetch ${source.url}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const p = tmpFile(source.ext || 'mp4');
    fs.writeFileSync(p, buf);
    return p;
  }
  throw new Error('No valid source provided');
}

/**
 * Runs a single-video edit pipeline.
 */
async function runVideoPipeline(inputPath, operations = [], outputOpts = {}) {
  const meta = await probe(inputPath);
  const videoStream = meta.streams.find((s) => s.codec_type === 'video');
  const audioStream = meta.streams.find((s) => s.codec_type === 'audio');
  const info = {
    hasAudio: !!audioStream,
    duration: parseFloat(meta.format.duration || 0),
    width: videoStream ? videoStream.width : undefined,
    height: videoStream ? videoStream.height : undefined,
  };

  // resolve any extra-input operations (watermark image / audioReplace / audioMix source) to temp files first
  const resolvedOps = [];
  for (const step of operations) {
    if (['watermark', 'audioReplace', 'audioMix'].includes(step.op)) {
      const src = step.imageUrl || step.audioUrl
        ? { url: step.imageUrl || step.audioUrl }
        : step.imageBase64 || step.audioBase64
        ? { buffer: Buffer.from((step.imageBase64 || step.audioBase64).replace(/^data:[\w/]+;base64,/, ''), 'base64') }
        : null;
      if (!src) throw new Error(`${step.op} requires imageUrl/imageBase64 or audioUrl/audioBase64`);
      const resolvedPath = await resolveSource({ ...src, ext: step.op === 'watermark' ? 'png' : 'mp3' });
      resolvedOps.push({ ...step, _resolvedPath: resolvedPath });
    } else {
      resolvedOps.push(step);
    }
  }

  const { filters, extraInputs, vLabel, aLabel } = buildGraph(resolvedOps, info);
  const outputPath = tmpFile(outputOpts.format || 'mp4');

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    extraInputs.forEach((ei) => cmd.input(ei.path));

    if (filters.length > 0) {
      cmd.complexFilter(filters);
      cmd.map(`[${vLabel}]`);
      if (aLabel) cmd.map(`[${aLabel}]`);
      else if (!info.hasAudio) {
        // no audio at all, nothing to map
      }
    }

    cmd
      .outputOptions(['-preset', 'veryfast', '-movflags', '+faststart'])
      .videoCodec('libx264')
      .audioCodec(info.hasAudio ? 'aac' : undefined)
      .on('error', reject)
      .on('end', resolve)
      .save(outputPath);
  });

  const buffer = fs.readFileSync(outputPath);

  // cleanup temp files
  [inputPath, outputPath, ...extraInputs.map((e) => e.path)].forEach((p) => {
    fs.unlink(p, () => {});
  });

  return { buffer, format: outputOpts.format || 'mp4' };
}

/**
 * Merges multiple clips with optional crossfade-style transitions between
 * consecutive pairs, using ffmpeg's xfade/acrossfade filters.
 * clips: [{path, duration?}], transitions: [{type, duration}] (length = clips.length - 1)
 */
async function mergeClips(clipPaths, transitions = [], outputOpts = {}) {
  const metas = await Promise.all(clipPaths.map(probe));
  const durations = metas.map((m) => parseFloat(m.format.duration || 0));
  const allHaveAudio = metas.every((m) => m.streams.some((s) => s.codec_type === 'audio'));

  const filters = [];
  let vLabel = '0:v';
  let aLabel = allHaveAudio ? '0:a' : null;
  let runningDuration = durations[0];

  for (let i = 1; i < clipPaths.length; i++) {
    const t = transitions[i - 1] || { type: 'fade', duration: 1 };
    const offset = Math.max(0, runningDuration - t.duration);
    const outV = `xv${i}`;
    filters.push(
      `[${vLabel}][${i}:v]xfade=transition=${t.type || 'fade'}:duration=${t.duration}:offset=${offset.toFixed(2)}[${outV}]`
    );
    vLabel = outV;

    if (aLabel) {
      const outA = `xa${i}`;
      filters.push(`[${aLabel}][${i}:a]acrossfade=d=${t.duration}[${outA}]`);
      aLabel = outA;
    }
    runningDuration = offset + durations[i];
  }

  const outputPath = tmpFile(outputOpts.format || 'mp4');

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    clipPaths.forEach((p) => cmd.input(p));
    cmd.complexFilter(filters);
    cmd.map(`[${vLabel}]`);
    if (aLabel) cmd.map(`[${aLabel}]`);
    cmd
      .outputOptions(['-preset', 'veryfast', '-movflags', '+faststart'])
      .videoCodec('libx264')
      .audioCodec(allHaveAudio ? 'aac' : undefined)
      .on('error', reject)
      .on('end', resolve)
      .save(outputPath);
  });

  const buffer = fs.readFileSync(outputPath);
  [...clipPaths, outputPath].forEach((p) => fs.unlink(p, () => {}));
  return { buffer, format: outputOpts.format || 'mp4' };
}

const availableOps = [
  'trim', 'crop', 'resize', 'rotate', 'flip', 'speed',
  'brightness', 'contrast', 'saturation', 'hue', 'grayscale', 'sepia', 'invert',
  'blur', 'sharpen', 'vignette', 'volume', 'mute', 'fadeIn', 'fadeOut',
  'text', 'watermark', 'audioReplace', 'audioMix',
];

module.exports = { runVideoPipeline, mergeClips, resolveSource, tmpFile, availableOps };
