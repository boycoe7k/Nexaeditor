# Darkroom — Image Edit API

Stateless image editing REST API for bot/backend use, plus a browser console
(`/`) for building and testing pipelines by hand.

Built on [sharp](https://sharp.pixelplumbing.com) — no native canvas
dependency, so it deploys cleanly on Render.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

## Deploy on Render

1. Push this folder to a GitHub repo.
2. New → Web Service → connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Render sets `PORT` automatically — the server already reads `process.env.PORT`.

## API

### `POST /api/edit`

Runs a pipeline of operations over an image and returns the edited image
as binary (`Content-Type: image/png|jpeg|webp`).

**Image input** — one of:
- `multipart/form-data` with a file field named `image`
- `imageUrl` (form field or JSON) — a public URL the server will fetch
- `imageBase64` (form field or JSON) — a base64 or data-URI string

**Pipeline** — `operations`: a JSON array (as a string in form-data, or a
real array in JSON), applied in order:

```json
[
  { "op": "rotate", "angle": 90 },
  { "op": "grayscale" },
  { "op": "text", "text": "sent from Darkroom", "x": 20, "y": 40, "fontSize": 28, "color": "#ffffff" }
]
```

Optional: `format` (`png` | `jpeg` | `webp`, default `png`), `quality` (1-100).

**Example — multipart (file upload):**

```bash
curl -X POST https://your-app.onrender.com/api/edit \
  -F "image=@photo.jpg" \
  -F 'operations=[{"op":"grayscale"},{"op":"vignette","intensity":50}]' \
  -F "format=jpeg" \
  -o edited.jpg
```

**Example — JSON with a hosted image URL:**

```bash
curl -X POST https://your-app.onrender.com/api/edit \
  -H "Content-Type: application/json" \
  -d '{
        "imageUrl": "https://example.com/photo.jpg",
        "operations": [{"op":"pixelate","size":16}],
        "format": "webp"
      }' \
  -o edited.webp
```

### `GET /api/operations`

Returns the list of supported operation names — useful for validating bot
input before sending a request.

## Supported operations

| Category | Ops |
|---|---|
| Transform | `crop`, `rotate`, `straighten`, `flip`, `resize` |
| Adjustments | `brightness`, `contrast`, `saturation`, `hue`, `exposure`, `sharpen`, `blur`, `grayscale`, `sepia`, `invert`, `temperature`, `tint`, `opacity` |
| Effects | `pixelate` / `mosaic`, `posterize`, `edgeDetect`, `emboss`, `noiseReduction`, `vignette` |
| Text | `text` (font size, color, stroke, shadow, rotation, alignment) |
| Shapes | `rectangle`, `circle`, `line`, `arrow` |
| Compositing | `watermark` (overlay a second image, from URL or base64) |

See the **Video API** section below for the video pipeline (trim, speed,
transitions, filters, text, audio mixing) — same request shape, separate
endpoints since images and video need very different processing.

Each op's parameters are listed in `lib/imageProcessor.js`. Unknown params
are ignored; unknown op names return a 400 error.

**Not included** (these need an interactive canvas session, which doesn't
fit a stateless bot API): layers, undo/redo history, freehand/lasso
selection, magic-wand selection, clone stamp, healing brush, clipboard
paste, pan/zoom. If you ever want those as a *human-facing* editor, that'd
be a separate project from this API.

## Video API

Built on `fluent-ffmpeg` + `ffmpeg-static`/`ffprobe-static` (bundled static
binaries — no system `ffmpeg` install needed, works on Render as-is).

### `POST /api/video/edit`

Single-clip pipeline. Same shape as the image API.

- Input: `video` file field (multipart) or `videoUrl`
- `operations`: JSON array, applied in order
- `format`: output container, default `mp4`

```bash
curl -X POST https://your-app.onrender.com/api/video/edit \
  -F "video=@clip.mp4" \
  -F 'operations=[{"op":"trim","start":2,"end":8},{"op":"grayscale"},{"op":"text","text":"hi","x":20,"y":40,"fontSize":32,"color":"white"}]' \
  -o edited.mp4
```

**Operations**: `trim`, `crop`, `resize`, `rotate`, `flip`, `speed`,
`brightness`, `contrast`, `saturation`, `hue`, `grayscale`, `sepia`,
`invert`, `blur`, `sharpen`, `vignette`, `volume`, `mute`, `fadeIn`,
`fadeOut`, `text`, `watermark` (image overlay, via `imageUrl`/`imageBase64`
on the op), `audioReplace`, `audioMix` (both via `audioUrl`/`audioBase64`
on the op).

### `POST /api/video/merge`

Concatenates 2+ clips with a transition between each pair (crossfade-style,
via ffmpeg's `xfade`/`acrossfade`).

- Input: `clips` files (multipart, up to 10) or `clipUrls` (JSON array of URLs)
- `transitions`: JSON array, length = clips.length − 1, each `{type, duration}`
- Transition types: `fade`, `fadeblack`, `fadewhite`, `wipeleft`, `wiperight`,
  `wipeup`, `wipedown`, `slideleft`, `slideright`, `slideup`, `slidedown`,
  `circleopen`, `circleclose`, `dissolve`

```bash
curl -X POST https://your-app.onrender.com/api/video/merge \
  -F "clips=@intro.mp4" -F "clips=@main.mp4" \
  -F 'transitions=[{"type":"wipeleft","duration":0.75}]' \
  -o merged.mp4
```

### `GET /api/video/operations`

Lists supported ops and transition types.

### Render considerations for video

- Video encoding is CPU-heavy. Render's free/starter tiers are slow for
  this — expect a 30s clip to take a while on a small instance. Size up the
  instance if latency matters for your bot.
- Render's default request timeout can cut off long renders. Keep clips
  short, or move heavy jobs to a background worker + webhook callback if
  you need longer videos later.
- `xfade`/`acrossfade` (used by `/merge`) expect clips with matching
  resolution and framerate — normalize your inputs before merging if
  they come from different sources.

## Calling it from a Baileys WhatsApp bot

```js
const FormData = require('form-data');
const fetch = require('node-fetch');

async function editImage(buffer, operations, format = 'jpeg') {
  const form = new FormData();
  form.append('image', buffer, 'input.jpg');
  form.append('operations', JSON.stringify(operations));
  form.append('format', format);

  const res = await fetch('https://your-app.onrender.com/api/edit', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return Buffer.from(await res.arrayBuffer());
}

// in a message handler, after downloading the incoming image buffer:
const edited = await editImage(imageBuffer, [
  { op: 'grayscale' },
  { op: 'text', text: 'via WhatsApp bot', x: 20, y: 40, fontSize: 28, color: '#fff' },
]);

await sock.sendMessage(jid, { image: edited });
```

## Notes / limits

- Max upload size: 20MB (`routes/edit.js`, `multer` limit).
- Max 25 operations per request.
- `watermark` and URL-based input fetch remote images server-side — only
  point it at URLs you trust.
