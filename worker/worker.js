/**
 * Lists the .glb files in your R2 bucket and returns them as JSON
 * for the BelowJS viewer to read, and optionally serves those files too.
 *
 * You paste this into a Cloudflare Worker and never touch it again.
 *
 * One setting is configured in the Cloudflare dashboard, not in this file:
 *   MODELS  - an R2 bucket binding pointing at your bucket
 *
 * The filename becomes the model's display name:
 *   "Euro.glb"  ->  "Euro"
 *
 * To set a credit, a starting camera angle, or turn measuring off, upload an
 * optional file called metadata.json to the same bucket. If it isn't there,
 * everything still works.
 *
 * Optional second binding, AR_MODELS: a bucket of lighter copies for AR, each
 * with the same file name as its model. When one exists, the model's entry
 * gains arUrl (served from /ar/...) and arSizeMb. Without the binding the list
 * is exactly as before.
 */

// When true, the Worker serves the .glb files itself from /f/<filename>.
// This keeps every request on the Worker's own address (workers.dev or
// models.southernoceanexploration.com).
// Set to false to go back to serving from the custom domain below.
const SERVE_FILES_FROM_WORKER = true;

// Only used when SERVE_FILES_FROM_WORKER is false.
const DEFAULT_BASE_URL = 'https://models.abeachsomewhere.net';

const CACHE_SECONDS = 60; // how long browsers hold the model list before re-checking

function slug(text) {
  let s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) s = 'model';
  if (/^\d/.test(s)) s = 'm-' + s; // keys starting with a digit get reordered by JS
  return s;
}

function encodePath(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

async function loadMetadata(bucket) {
  try {
    const obj = await bucket.get('metadata.json');
    if (!obj) return {};
    const parsed = await obj.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.log('metadata.json could not be read, ignoring it:', err.message);
    return {};
  }
}

async function listGlbFiles(bucket) {
  const found = [];
  let cursor;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const obj of page.objects) {
      if (obj.key.toLowerCase().endsWith('.glb')) found.push(obj);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return found;
}

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (!env.MODELS) {
      return new Response(
        JSON.stringify({
          error: 'Worker is missing its bucket. Check that the R2 binding is named exactly MODELS.'
        }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...cors } }
      );
    }

    const url = new URL(request.url);

    // ---- serve a model file straight out of the bucket ----
    // The model list links to /f/v/<version>/<file>. The version changes
    // whenever a file is replaced, so browsers fetch the new file instead of
    // reusing a cached copy. Plain /f/<file> links still work.
    // AR copies (lighter files for tabletop AR) are served the same way from
    // /ar/, out of the optional AR_MODELS bucket.
    const arPath = env.AR_MODELS && url.pathname.startsWith('/ar/');
    if (SERVE_FILES_FROM_WORKER && (url.pathname.startsWith('/f/') || arPath)) {
      const bucket = arPath ? env.AR_MODELS : env.MODELS;
      const rest = url.pathname.slice(arPath ? 4 : 3);
      const versioned = rest.match(/^v\/[^/]+\/(.+)$/);
      const key = decodeURIComponent(versioned ? versioned[1] : rest);
      let obj;
      try {
        obj = await bucket.get(key, { onlyIf: request.headers });
      } catch (err) {
        return new Response('Error reading ' + key + ': ' + err.message, {
          status: 502,
          headers: cors
        });
      }
      if (!obj) {
        return new Response('Not found: ' + key, { status: 404, headers: cors });
      }

      const headers = new Headers(cors);
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      if (key.toLowerCase().endsWith('.glb')) {
        headers.set('Content-Type', 'model/gltf-binary');
      }
      // A versioned link never changes content, so browsers can keep it.
      // A plain link is kept for a day, then checked against its ETag.
      headers.set('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=86400');

      // onlyIf matched the browser's cached ETag, so there is no body to send.
      if (!('body' in obj)) {
        return new Response(null, { status: 304, headers });
      }

      if (request.method === 'HEAD') {
        headers.set('Content-Length', String(obj.size));
        return new Response(null, { headers });
      }
      return new Response(obj.body, { headers });
    }

    // ---- otherwise, return the model list ----
    const base = SERVE_FILES_FROM_WORKER
      ? `${url.origin}/f`
      : (env.PUBLIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

    let files, meta, arFiles;
    try {
      [files, meta, arFiles] = await Promise.all([
        listGlbFiles(env.MODELS),
        loadMetadata(env.MODELS),
        env.AR_MODELS ? listGlbFiles(env.AR_MODELS) : []
      ]);
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Could not read the bucket: ' + err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // An AR copy has the same file name as its model ("Euro.glb" in both buckets).
    const arByKey = new Map(arFiles.map((obj) => [obj.key, obj]));

    const entries = files.map((obj) => {
      const filename = obj.key.split('/').pop();
      const displayBase = filename.replace(/\.glb$/i, '');
      const m = meta[obj.key] || meta[filename] || meta[displayBase] || {};
      const ar = arByKey.get(obj.key);
      return {
        arUrl: ar && SERVE_FILES_FROM_WORKER
          ? `${url.origin}/ar/v/${encodeURIComponent(ar.etag.slice(0, 12))}/${encodePath(ar.key)}`
          : null,
        arSizeMb: ar ? Math.round((ar.size / (1024 * 1024)) * 10) / 10 : null,
        slugBase: displayBase,
        url: SERVE_FILES_FROM_WORKER
          ? `${base}/v/${encodeURIComponent(obj.etag.slice(0, 12))}/${encodePath(obj.key)}`
          : `${base}/${encodePath(obj.key)}`,
        name: m.name || displayBase,
        credit: m.credit || '',
        measurable: typeof m.measurable === 'boolean' ? m.measurable : true,
        initialPositions: m.initialPositions || null,
        order: typeof m.order === 'number' ? m.order : Number.MAX_SAFE_INTEGER,
        sizeMb: Math.round((obj.size / (1024 * 1024)) * 10) / 10
      };
    });

    entries.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

    const models = {};
    const taken = new Set();
    for (const entry of entries) {
      let key = slug(entry.slugBase);
      let n = 2;
      while (taken.has(key)) key = `${slug(entry.slugBase)}-${n++}`;
      taken.add(key);

      const model = {
        url: entry.url,
        name: entry.name,
        measurable: entry.measurable,
        sizeMb: entry.sizeMb
      };
      if (entry.arUrl) {
        model.arUrl = entry.arUrl;
        model.arSizeMb = entry.arSizeMb;
      }
      if (entry.credit) model.credit = entry.credit;
      if (entry.initialPositions) model.initialPositions = entry.initialPositions;
      models[key] = model;
    }

    return new Response(JSON.stringify({ count: entries.length, models }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        ...cors
      }
    });
  }
};