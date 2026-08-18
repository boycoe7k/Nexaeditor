const express = require('express');
const multer = require('multer');
const { runPipeline, availableOps } = require('../lib/imageProcessor');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

const MAX_OPERATIONS = 25;

async function loadInputBuffer(req) {
  if (req.file) {
    return req.file.buffer;
  }
  const imageUrl = req.body.imageUrl || req.query.imageUrl;
  const imageBase64 = req.body.imageBase64;
  if (imageBase64) {
    return Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  }
  if (imageUrl) {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`Failed to fetch imageUrl: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return null;
}

function parseOperations(raw) {
  if (!raw) return [];
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) throw new Error('operations must be an array');
  if (parsed.length > MAX_OPERATIONS) {
    throw new Error(`Too many operations (max ${MAX_OPERATIONS})`);
  }
  return parsed;
}

// POST /api/edit — accepts multipart (field "image") or JSON (imageUrl / imageBase64)
router.post('/edit', upload.single('image'), async (req, res) => {
  try {
    const inputBuffer = await loadInputBuffer(req);
    if (!inputBuffer) {
      return res.status(400).json({
        error: 'No image provided. Send a file under "image", or "imageUrl" / "imageBase64" in the body.',
      });
    }

    const operations = parseOperations(req.body.operations);
    const format = req.body.format || req.query.format;
    const quality = req.body.quality || req.query.quality;

    const { buffer, format: outFormat } = await runPipeline(inputBuffer, operations, {
      format,
      quality,
    });

    res.set('Content-Type', `image/${outFormat}`);
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/operations — self-documenting list for bot developers
router.get('/operations', (req, res) => {
  res.json({ operations: availableOps });
});

module.exports = router;
