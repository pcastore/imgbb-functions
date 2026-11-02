/**
 * PCA Image Worker (Cloudflare D1) - replaces imgbb completely.
 *
 * Same contract as the old imgbb-functions Worker, so admin.html / the store
 * keep working with NO client change if you deploy this under the same
 * Worker name (imgbb-functions):
 *
 *   POST /            multipart form, field "image"
 *                     -> { success: true, data: { url } }
 *   GET  /i/<id>[.ext] -> the image (edge-cached, immutable, 1 year)
 *   GET  /health
 *
 * Setup (once):
 *   1. Cloudflare dashboard -> Storage & Databases -> D1 -> Create database
 *      (name: pca-images).
 *   2. This Worker -> Settings -> Bindings -> Add -> D1 database
 *      Variable name: DB   Database: pca-images
 *   3. Deploy. The table is created automatically on the first request.
 *
 * Optional variables:
 *   ALLOWED_ORIGINS  comma-separated origins allowed to upload from a browser
 *                    (default: any). Example: https://a.vercel.app,https://b.com
 *   PUBLIC_BASE      base URL used in returned links (default: this Worker's origin)
 *
 * Limits: D1 allows ~2 MB per row. Images are stored as base64 text, so the
 * practical cap is MAX_BYTES (1.4 MB) per image. admin.html already
 * compresses photos to ~20-100 KB before upload.
 */

const MAX_BYTES = 1400 * 1024;
const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

let schemaReady = false;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true }, 200, cors);
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/i/')) {
        return await serveImage(request, env, ctx, url);
      }
      if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/upload')) {
        return await uploadImage(request, env, url, cors);
      }
      return json({ success: false, error: { message: 'Not found' } }, 404, cors);
    } catch (err) {
      console.error('image-worker error:', err);
      return json({ success: false, error: { message: 'Internal error: ' + (err && err.message || err) } }, 500, cors);
    }
  },
};

async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new Error('D1 binding "DB" is missing on this Worker');
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)'
  ).run();
  schemaReady = true;
}

async function uploadImage(request, env, url, cors) {
  await ensureSchema(env);

  let file;
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('multipart/form-data')) {
    const form = await request.formData();
    file = form.get('image');
  } else {
    return json({ success: false, error: { message: 'Send multipart form field "image"' } }, 400, cors);
  }
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return json({ success: false, error: { message: 'No image provided' } }, 400, cors);
  }
  if (file.size > MAX_BYTES) {
    return json({ success: false, error: { message: 'Image too large (max ' + Math.round(MAX_BYTES / 1024) + ' KB)' } }, 413, cors);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime) return json({ success: false, error: { message: 'Unsupported image type' } }, 415, cors);

  const saved = await saveImage(env, bytes, mime);
  const base = (env.PUBLIC_BASE || url.origin).replace(/\/$/, '');
  return json({ success: true, data: { url: base + '/i/' + saved.id + '.' + TYPES[mime], id: saved.id } }, 200, cors);
}

async function saveImage(env, bytes, mime) {
  const id = crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare('INSERT INTO images (id, mime, size, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, mime, bytes.length, toBase64(bytes), Date.now())
    .run();
  return { id };
}

async function serveImage(request, env, ctx, url) {
  const cache = caches.default;
  const cacheKey = new Request(url.origin + url.pathname, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return request.method === 'HEAD' ? new Response(null, hit) : hit;

  await ensureSchema(env);
  const id = url.pathname.slice(3).replace(/\.\w+$/, '');
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Not found', { status: 404 });

  const row = await env.DB.prepare('SELECT mime, data FROM images WHERE id = ?1').bind(id).first();
  if (!row) return new Response('Not found', { status: 404 });

  const res = new Response(fromBase64(row.data), {
    status: 200,
    headers: {
      'Content-Type': row.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return request.method === 'HEAD' ? new Response(null, res) : res;
}

function sniffMime(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 5 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

function toBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
  const allow = !list.length ? '*' : (list.includes(origin) ? origin : '');
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
