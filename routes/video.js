const express = require('express');
const multer = require('multer');
const { runVideoPipeline, mergeClips, resolveSource, availableOps } = require('../lib/videoProcessor');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

const MAX_OPERATIONS = 25;
const TRANSITION_TYPES = [
  'fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown', 'circleopen', 'circleclose', 'dissolve',
];

function parseJsonField(raw, fallback) {
  if (!raw) return fallback;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// POST /api/video/edit — single clip pipeline (trim, crop, filters, text, audio, etc.)
router.post('/edit', upload.single('video'), async (req, res) => {
  let inputPath;
  try {
    if (req.file) {
      inputPath = await resolveSource({ buffer: req.file.buffer, ext: 'mp4' });
    } else if (req.body.videoUrl) {
      inputPath = await resolveSource({ url: req.body.videoUrl });
    } else {
      return res.status(400).json({
        error: 'No video provided. Send a file under "video", or "videoUrl" in the body.',
      });
    }

    const operations = parseJsonField(req.body.operations, []);
    if (!Array.isArray(operations)) throw new Error('operations must be an array');
    if (operations.length > MAX_OPERATIONS) throw new Error(`Too many operations (max ${MAX_OPERATIONS})`);

    const format = req.body.format || 'mp4';
    const { buffer, format: outFormat } = await runVideoPipeline(inputPath, operations, { format });

    res.set('Content-Type', `video/${outFormat}`);
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/video/merge — concatenate clips with transitions between them
// multipart: files under "clips" (multiple), OR JSON/form field "clipUrls": ["url1","url2",...]
// "transitions": [{type, duration}, ...]  (length = clips.length - 1)
router.post('/merge', upload.array('clips', 10), async (req, res) => {
  try {
    let sources = [];
    if (req.files && req.files.length > 0) {
      sources = req.files.map((f) => ({ buffer: f.buffer, ext: 'mp4' }));
    } else if (req.body.clipUrls) {
      const urls = parseJsonField(req.body.clipUrls, []);
      sources = urls.map((u) => ({ url: u }));
    }

    if (sources.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 clips (via "clips" files or "clipUrls").' });
    }

    const transitions = parseJsonField(req.body.transitions, []);
    transitions.forEach((t) => {
      if (t.type && !TRANSITION_TYPES.includes(t.type)) {
        throw new Error(`Unknown transition type "${t.type}". Valid: ${TRANSITION_TYPES.join(', ')}`);
      }
    });

    const clipPaths = await Promise.all(sources.map((s) => resolveSource(s)));
    const format = req.body.format || 'mp4';
    const { buffer, format: outFormat } = await mergeClips(clipPaths, transitions, { format });

    res.set('Content-Type', `video/${outFormat}`);
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/video/operations
router.get('/operations', (req, res) => {
  res.json({ operations: availableOps, transitionTypes: TRANSITION_TYPES });
});

module.exports = router;
