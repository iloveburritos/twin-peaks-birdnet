// Twin Peaks BirdNET - public archive + site backend (Cloudflare Worker).
//
// The Raspberry Pi pushes detections OUT to this Worker. Nothing here can
// reach back into the Pi. Write routes need the INGEST_TOKEN secret; read
// routes are public and only ever return what the Pi chose to send:
// date, time, species, confidence, and the clip. No coordinates.
//
// Bindings (wrangler.toml): DB (D1), CLIPS (R2), ASSETS (static site)
// Vars: PUBLISH_DELAY_HOURS, STATION_NAME.  Secret: INGEST_TOKEN

import { speciesAbout } from './wiki.js';
import EBIRD from './ebird-codes.json';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS detections (
     file TEXT PRIMARY KEY,
     date TEXT NOT NULL,
     time TEXT NOT NULL,
     ts   INTEGER NOT NULL,
     sci  TEXT NOT NULL,
     com  TEXT NOT NULL,
     conf REAL,
     has_clip INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS detections_ts ON detections (ts DESC)`,
  `CREATE INDEX IF NOT EXISTS detections_sci ON detections (sci, ts DESC)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER)`,
];

// The Pi checks in every 5 minutes. If it has been silent this long, the
// site says the station is offline.
const OFFLINE_AFTER_SECS = 30 * 60;

function markSeen(env) {
  return env.DB.prepare(
    `INSERT INTO meta (k, v) VALUES ('last_seen', ?1)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(Math.floor(Date.now() / 1000)).run();
}

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  schemaReady = true;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function slugify(sci) {
  return String(sci).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Detections only become public after a review window, so a false positive
// (a TV, a ringtone) can be deleted on the Pi before anyone sees it.
function cutoff(env) {
  const hours = Number(env.PUBLISH_DELAY_HOURS ?? 24);
  return Math.floor(Date.now() / 1000) - Math.max(0, hours) * 3600;
}

async function authorized(request, env) {
  const expected = env.INGEST_TOKEN;
  if (!expected || expected.length < 24) return false;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const FILE_OK = /^[^\/\\\u0000-\u001f]{5,200}\.(mp3|wav|flac|ogg)$/i;

// ---------------------------------------------------------------- writes

async function ingest(request, env) {
  const body = await request.json().catch(() => null);
  const rows = body && Array.isArray(body.detections) ? body.detections : null;
  if (!rows || rows.length > 500) return json({ error: 'bad payload' }, 400);
  const stmt = env.DB.prepare(
    `INSERT INTO detections (file, date, time, ts, sci, com, conf)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(file) DO UPDATE SET
       date = excluded.date, time = excluded.time, ts = excluded.ts,
       sci = excluded.sci, com = excluded.com, conf = excluded.conf`
  );
  const batch = [];
  for (const r of rows) {
    if (!r || !FILE_OK.test(r.file || '')) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') || !/^\d{2}:\d{2}:\d{2}$/.test(r.time || '')) continue;
    const ts = Number(r.ts);
    if (!Number.isFinite(ts) || !r.sci || !r.com) continue;
    batch.push(stmt.bind(r.file, r.date, r.time, Math.floor(ts),
      String(r.sci).slice(0, 100), String(r.com).slice(0, 100),
      Number.isFinite(Number(r.conf)) ? Number(r.conf) : null));
  }
  if (batch.length) await env.DB.batch(batch);
  return json({ ok: true, stored: batch.length });
}

async function putClip(request, env, url) {
  const file = url.searchParams.get('file') || '';
  if (!FILE_OK.test(file)) return json({ error: 'bad file name' }, 400);
  const known = await env.DB.prepare('SELECT 1 FROM detections WHERE file = ?1').bind(file).first();
  if (!known) return json({ error: 'unknown detection' }, 404);
  const size = Number(request.headers.get('content-length') || 0);
  if (!size || size > 25 * 1024 * 1024) return json({ error: 'bad size' }, 413);
  await env.CLIPS.put(`clips/${file}`, request.body, {
    httpMetadata: { contentType: 'audio/mpeg' },
  });
  await env.DB.prepare('UPDATE detections SET has_clip = 1 WHERE file = ?1').bind(file).run();
  return json({ ok: true });
}

async function removeDetections(request, env) {
  const body = await request.json().catch(() => null);
  const files = body && Array.isArray(body.files) ? body.files.filter((f) => FILE_OK.test(f)) : null;
  if (!files || files.length > 500) return json({ error: 'bad payload' }, 400);
  if (files.length) {
    await env.DB.batch(files.map((f) => env.DB.prepare('DELETE FROM detections WHERE file = ?1').bind(f)));
    await env.CLIPS.delete(files.map((f) => `clips/${f}`));
  }
  return json({ ok: true, removed: files.length });
}

// ----------------------------------------------------------------- reads

function publicRow(r) {
  return {
    date: r.date, time: r.time, ts: r.ts, sci: r.sci, com: r.com,
    conf: r.conf, slug: slugify(r.sci),
    clip: r.has_clip ? `/clips/${encodeURIComponent(r.file)}` : null,
  };
}

async function summary(env) {
  const c = cutoff(env);
  const [totals, recent, species, daily, hourly] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS detections, COUNT(DISTINCT sci) AS species,
              MIN(date) AS first_date, MAX(ts) AS last_ts
         FROM detections WHERE ts <= ?1`).bind(c),
    env.DB.prepare(
      `SELECT * FROM detections WHERE ts <= ?1 ORDER BY ts DESC LIMIT 40`).bind(c),
    env.DB.prepare(
      `SELECT sci, MAX(com) AS com, COUNT(*) AS n, MAX(ts) AS last_ts,
              MAX(conf) AS best_conf, MIN(date) AS first_date,
              SUM(CASE WHEN ts > ?1 - 604800 THEN 1 ELSE 0 END) AS n_week
         FROM detections WHERE ts <= ?1 GROUP BY sci ORDER BY n DESC`).bind(c),
    env.DB.prepare(
      `SELECT date, COUNT(*) AS n, COUNT(DISTINCT sci) AS species
         FROM detections WHERE ts <= ?1 GROUP BY date ORDER BY date DESC LIMIT 30`).bind(c),
    env.DB.prepare(
      `SELECT CAST(substr(time, 1, 2) AS INTEGER) AS hour, COUNT(*) AS n
         FROM detections WHERE ts <= ?1 GROUP BY hour`).bind(c),
  ]);
  const hours = new Array(24).fill(0);
  for (const h of hourly.results) if (h.hour >= 0 && h.hour < 24) hours[h.hour] = h.n;
  return json({
    station: env.STATION_NAME || 'Birds of Twin Peaks',
    delay_hours: Number(env.PUBLISH_DELAY_HOURS ?? 24),
    totals: totals.results[0] || {},
    recent: recent.results.map(publicRow),
    species: species.results.map((s) => ({ ...s, slug: slugify(s.sci), img: `/birds/${slugify(s.sci)}.webp` })),
    daily: daily.results.reverse(),
    hourly: hours,
  }, 200, { 'cache-control': 'public, max-age=60' });
}

// Time windows the site can show. `bucket` sets the timeline resolution in
// seconds; 'day' groups by the Pi's local calendar date instead.
const WINDOWS = {
  '1h': { secs: 3600, bucket: 300 },
  '12h': { secs: 43200, bucket: 3600 },
  '24h': { secs: 86400, bucket: 3600 },
  '7d': { secs: 604800, bucket: 'day' },
  all: { secs: null, bucket: 'day' },
};

async function windowView(env, url) {
  const key = url.searchParams.get('w') || '24h';
  const win = WINDOWS[key];
  if (!win) return json({ error: 'bad window' }, 400);
  const c = cutoff(env);
  const now = Math.floor(Date.now() / 1000);
  const start = win.secs ? now - win.secs : 0;
  const bucketSql = win.bucket === 'day'
    ? `SELECT date AS b, COUNT(*) AS n, COUNT(DISTINCT sci) AS species
         FROM detections WHERE ts > ?1 AND ts <= ?2 GROUP BY date ORDER BY date`
    : `SELECT CAST((ts - CAST(?1 AS INTEGER)) / ${win.bucket} AS INTEGER) AS b, COUNT(*) AS n, COUNT(DISTINCT sci) AS species
         FROM detections WHERE ts > ?1 AND ts <= ?2 GROUP BY b ORDER BY b`;
  const [species, clips, recent, buckets, hourly, seen] = await env.DB.batch([
    // Every species ever heard, with its count inside this window.
    env.DB.prepare(
      `SELECT sci, MAX(com) AS com, COUNT(*) AS n_all,
              SUM(CASE WHEN ts > ?1 THEN 1 ELSE 0 END) AS n,
              MAX(ts) AS last_ts, MIN(date) AS first_date, MIN(ts) AS first_ts,
              MAX(conf) AS best_conf
         FROM detections WHERE ts <= ?2 GROUP BY sci`).bind(start, c),
    // Best-scoring recording per species (SQLite returns the MAX row's file).
    env.DB.prepare(
      `SELECT sci, file, MAX(conf) AS conf FROM detections
        WHERE has_clip = 1 AND ts <= ?1 GROUP BY sci`).bind(c),
    env.DB.prepare(
      `SELECT * FROM detections WHERE ts > ?1 AND ts <= ?2
        ORDER BY ts DESC LIMIT 40`).bind(start, c),
    env.DB.prepare(bucketSql).bind(start, c),
    env.DB.prepare(
      `SELECT CAST(substr(time, 1, 2) AS INTEGER) AS hour, COUNT(*) AS n
         FROM detections WHERE ts > ?1 AND ts <= ?2 GROUP BY hour`).bind(start, c),
    env.DB.prepare(`SELECT v FROM meta WHERE k = 'last_seen'`),
  ]);
  // null until the Pi has checked in at least once (older uploaders don't).
  const lastSeen = seen.results[0] ? seen.results[0].v : null;
  const clipBySci = {};
  for (const r of clips.results) clipBySci[r.sci] = `/clips/${encodeURIComponent(r.file)}`;
  const hours = new Array(24).fill(0);
  for (const h of hourly.results) if (h.hour >= 0 && h.hour < 24) hours[h.hour] = h.n;
  const list = species.results.map((s) => ({
    ...s, slug: slugify(s.sci), img: `/birds/${slugify(s.sci)}.webp`, clip: clipBySci[s.sci] || null,
  }));
  const inWindow = list.filter((s) => s.n > 0);
  return json({
    station: env.STATION_NAME || 'Birds of Twin Peaks',
    delay_hours: Number(env.PUBLISH_DELAY_HOURS ?? 24),
    window: key,
    start, cutoff: c, bucket: win.bucket,
    online: lastSeen === null ? null : now - lastSeen < OFFLINE_AFTER_SECS,
    totals: {
      detections: inWindow.reduce((a, s) => a + s.n, 0),
      species: inWindow.length,
      all_detections: list.reduce((a, s) => a + s.n_all, 0),
      all_species: list.length,
      first_date: list.reduce((m, s) => (!m || s.first_date < m ? s.first_date : m), null),
    },
    species: list,
    recent: recent.results.map(publicRow),
    timeline: buckets.results,
    hourly: hours,
  }, 200, { 'cache-control': 'public, max-age=60' });
}

async function speciesDetail(env, url) {
  const sci = url.searchParams.get('sci') || '';
  if (!sci || sci.length > 100) return json({ error: 'bad species' }, 400);
  const rows = await env.DB.prepare(
    `SELECT * FROM detections WHERE sci = ?1 AND ts <= ?2
      ORDER BY has_clip DESC, conf DESC, ts DESC LIMIT 60`).bind(sci, cutoff(env)).all();
  return json({ sci, detections: rows.results.map(publicRow) }, 200,
    { 'cache-control': 'public, max-age=300' });
}

// Wikipedia description + eBird code for one species, cached at the edge for
// a week so Wikipedia is asked at most once per species per week.
async function about(request, env, ctx, url) {
  const sci = (url.searchParams.get('sci') || '').trim();
  if (!/^[A-Za-z]{2,40}(?: [a-z]{2,40}){1,3}$/.test(sci)) return json({ error: 'invalid sci' }, 400);
  const cache = caches.default;
  const key = new Request(`https://cache.internal/about/v1/${encodeURIComponent(sci)}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  let body;
  try {
    body = await speciesAbout(sci);
  } catch (err) {
    console.error(err);
    return json({ sci, ebird: EBIRD[sci] || null, paragraphs: [], distinctive: null, source: null }, 200,
      { 'cache-control': 'public, max-age=300' });
  }
  const res = json({ sci, ebird: EBIRD[sci] || null, ...body }, 200,
    { 'cache-control': 'public, max-age=86400' });
  ctx.waitUntil(cache.put(key, new Response(res.clone().body, {
    headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=604800' },
  })));
  return res;
}

async function exportCsv(env) {
  const rows = await env.DB.prepare(
    `SELECT date, time, sci, com, conf, file, has_clip FROM detections
      WHERE ts <= ?1 ORDER BY ts`).bind(cutoff(env)).all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['date,time,scientific_name,common_name,confidence,clip_url'];
  for (const r of rows.results) {
    lines.push([r.date, r.time, esc(r.sci), esc(r.com), r.conf ?? '',
      r.has_clip ? esc(`/clips/${encodeURIComponent(r.file)}`) : ''].join(','));
  }
  return new Response(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="twin-peaks-birdnet-detections.csv"',
      'cache-control': 'public, max-age=900',
    },
  });
}

async function serveClip(request, env, file) {
  if (!FILE_OK.test(file)) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare(
    'SELECT 1 FROM detections WHERE file = ?1 AND has_clip = 1 AND ts <= ?2').bind(file, cutoff(env)).first();
  if (!row) return new Response('Not found', { status: 404 });
  return serveObject(request, env, `clips/${file}`, 'public, max-age=86400');
}

async function serveObject(request, env, key, cacheControl) {
  const range = request.headers.has('range') ? { range: request.headers } : {};
  const obj = await env.CLIPS.get(key, range);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', cacheControl);
  headers.set('access-control-allow-origin', '*');
  if (obj.range && request.headers.has('range')) {
    const start = obj.range.offset ?? 0;
    const len = obj.range.length ?? obj.size - start;
    headers.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
    headers.set('content-length', String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path.startsWith('/api/') || path.startsWith('/clips/')) {
        await ensureSchema(env);
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (path === '/api/summary') return summary(env);
        if (path === '/api/window') return windowView(env, url);
        if (path === '/api/species') return speciesDetail(env, url);
        if (path === '/api/about') return about(request, env, ctx, url);
        if (path === '/api/export.csv') return exportCsv(env);
        if (path.startsWith('/clips/')) return serveClip(request, env, decodeURIComponent(path.slice(7)));
      } else if (path.startsWith('/api/')) {
        if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);
        ctx.waitUntil(markSeen(env));
        if (request.method === 'POST' && path === '/api/heartbeat') return json({ ok: true });
        if (request.method === 'POST' && path === '/api/ingest') return ingest(request, env);
        if (request.method === 'PUT' && path === '/api/clip') return putClip(request, env, url);
        if (request.method === 'POST' && path === '/api/delete') return removeDetections(request, env);
      }
      if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: 'server error' }, 500);
    }
  },
};
