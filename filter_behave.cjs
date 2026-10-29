#!/usr/bin/env node
// filter_behave.cjs: behavioural tests in real Chromium (Playwright).
//
// The File System Access API, canvas, IndexedDB, wasm and service workers only
// behave properly in a real browser, so this suite serves the repo on localhost
// and drives the probe.
//
// The fake folder tree: in place of the real folder picker, each test builds a
// DCIM/Camera folder in Chromium's private origin file system (OPFS). Its
// handles are real FileSystemDirectoryHandles, so the copy, read back and delete
// go through the browser's own file code. Wrappers on top of it plant faults: a
// disk that changes a byte, a short write, a failing or silent delete, an
// original that changes mid-move, a listing that stalls. Every file is
// synthetic (random bytes, coloured shapes); no real photo is used.
//
// Run:            node filter_behave.cjs
// Core only:      FILTER_ONLY=core node filter_behave.cjs   (used by filter_mutate.sh)
// Other page:     FILTER_HTML=/path/to/mutant.html node filter_behave.cjs
// Filter by name: FILTER_GREP=move node filter_behave.cjs

'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const ROOT = __dirname;
const PAGE_FILE = process.env.FILTER_HTML ? path.resolve(process.env.FILTER_HTML) : path.join(ROOT, 'filter.html');
const ONLY_CORE = process.env.FILTER_ONLY === 'core';
const GREP = process.env.FILTER_GREP ? new RegExp(process.env.FILTER_GREP, 'i') : null;

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  const { execSync } = require('child_process');
  const globalRoot = execSync('npm root -g').toString().trim();
  return require(path.join(globalRoot, 'playwright'));
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const VERSION = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/const CACHE_VERSION = '([^']+)'/)[1];

/* ---------- Static server ---------- */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream' };
function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const file = p === '/filter.html' ? PAGE_FILE : path.join(ROOT, p);
      if (!file.startsWith(ROOT) && file !== PAGE_FILE) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(fs.readFileSync(file));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/* ---------- Harness ---------- */

const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });
class Skip extends Error {}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(got, want, msg) { assert(JSON.stringify(got) === JSON.stringify(want), msg + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }

let pw, browser, BASE;
const foreignRequests = [];

// Runs in the page before the app. __fx builds and inspects the fake folder
// tree; showDirectoryPicker hands the app whatever folder the test chose.
function pageFixtures() {
  const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
  const bytesOf = async (d) => (d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset || 0, (d.byteOffset || 0) + d.byteLength) : d));
  window.__fx = {
    async dir(p) {
      let d = await navigator.storage.getDirectory();
      for (const part of p.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create: true });
      return d;
    },
    async put(dir, name, data) {
      const h = await dir.getFileHandle(name, { create: true });
      if (data === undefined) return h;            // an empty file is enough when only the name matters
      const w = await h.createWritable();
      await w.write(data);
      await w.close();
      return h;
    },
    async sha(blob) { return hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())); },
    async shaOf(dir, name) { return this.sha(await (await dir.getFileHandle(name)).getFile()); },
    async has(dir, name) { try { await dir.getFileHandle(name); return true; } catch (e) { return false; } },
    // Every file and folder below dir, with each file's SHA-256.
    async tree(dir, prefix = '') {
      const out = {};
      for await (const h of dir.values()) {
        const p = prefix + h.name;
        if (h.kind === 'directory') { out[p + '/'] = 'dir'; Object.assign(out, await this.tree(h, p + '/')); }
        else out[p] = await this.sha(await h.getFile());
      }
      return Object.fromEntries(Object.entries(out).sort());
    },
    noise(n, seed = 1) {
      const b = new Uint8Array(n); let x = seed >>> 0 || 1;
      for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 255; }
      return b;
    },
    // A decodable JPEG of a coloured shape on a plain ground.
    async jpeg(i) {
      const c = new OffscreenCanvas(160, 120);
      const x = c.getContext('2d');
      x.fillStyle = ['#2d6a4f', '#1d3557', '#e9c46a', '#8d99ae', '#bc4749', '#6d597a', '#264653', '#f4a261'][i % 8];
      x.fillRect(0, 0, 160, 120);
      x.fillStyle = ['#ffffff', '#e63946', '#000000', '#ffb703'][i % 4];
      x.beginPath(); x.arc(40 + i * 10, 60, 25 + i, 0, 7); x.fill();
      x.fillRect(100, 20 + i * 5, 40, 30);
      return c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    },
    // The standard fake camera folder: 8 photos, 4 videos, 3 hidden, 3 other, 2 subfolders.
    async camera() {
      const cam = await this.dir('DCIM/Camera');
      for (let i = 0; i < 8; i++) await this.put(cam, 'PXL_20261029_10' + String(i).padStart(4, '0') + '000.jpg', await this.jpeg(i));
      for (let i = 0; i < 4; i++) await this.put(cam, 'PXL_20261029_11' + String(i).padStart(4, '0') + '000.mp4', this.noise(3000 + i, i + 7));
      await this.put(cam, '.trashed-1767225600-PXL_20261001_090000000.jpg', await this.jpeg(9));
      await this.put(cam, '.trashed-1767225601-PXL_20261001_090100000.jpg', await this.jpeg(10));
      await this.put(cam, '.pending-1767225602-PXL_20261029_120000000.mp4', this.noise(500, 3));
      await this.put(cam, 'notes.txt', new TextEncoder().encode('not a photo'));
      await this.put(cam, 'edit.json', new TextEncoder().encode('{}'));
      await this.put(cam, 'desktop.ini', new TextEncoder().encode('[x]'));
      await cam.getDirectoryHandle('Raw', { create: true });
      await cam.getDirectoryHandle('.thumbnails', { create: true });
      return cam;
    },
    // A big folder of empty files: photos, videos, hidden and other in the given numbers.
    async big(p, n) {
      const d = await this.dir(p);
      const jobs = [];
      for (let i = 0; i < n.photo; i++) jobs.push(this.put(d, 'IMG_' + i + '.jpg'));
      for (let i = 0; i < n.video; i++) jobs.push(this.put(d, 'VID_' + i + '.mp4'));
      for (let i = 0; i < n.hidden; i++) jobs.push(this.put(d, '.trashed-' + i + '.jpg'));
      for (let i = 0; i < n.other; i++) jobs.push(this.put(d, 'note_' + i + '.txt'));
      for (let i = 0; i < (n.folder || 0); i++) jobs.push(d.getDirectoryHandle('sub_' + i, { create: true }));
      await Promise.all(jobs);
      return d;
    },
    // A folder handle with a fault planted. ops records every call, labelled.
    wrap(dir, fault, ops = [], label = dir.name) {
      const seen = {};
      const wrapFile = (fh, name) => ({
        kind: 'file', name: fh.name,
        async getFile() {
          ops.push(label + ' getFile ' + name);
          seen[name] = (seen[name] || 0) + 1;
          const f = await fh.getFile();
          if (fault === 'changesOriginal' && seen[name] > 1) return new File([f], f.name, { lastModified: f.lastModified + 1000 });
          return f;
        },
        async createWritable(o) {
          ops.push(label + ' createWritable ' + name);
          if (fault === 'throwWrite') throw new DOMException('disk full', 'QuotaExceededError');
          const w = await fh.createWritable(o);
          if (fault !== 'flip' && fault !== 'truncate' && fault !== 'failMidWrite') return w;
          return {
            async write(d) {
              const b = await bytesOf(d);
              if (fault === 'failMidWrite') { await w.write(b.subarray(0, 1000)); throw new DOMException('card removed', 'NotReadableError'); }
              if (fault === 'flip') b[7] ^= 1;
              return w.write(fault === 'truncate' ? b.subarray(0, b.length - 100) : b);
            },
            close: () => w.close(),
            abort: () => { ops.push(label + ' abort ' + name); return w.abort(); },
          };
        },
      });
      return {
        kind: 'directory', name: dir.name,
        async getFileHandle(n, o) { ops.push(label + ' getFileHandle ' + n + (o && o.create ? ' create' : '')); return wrapFile(await dir.getFileHandle(n, o), n); },
        getDirectoryHandle: (n, o) => dir.getDirectoryHandle(n, o),
        async removeEntry(n, o) {
          ops.push(label + ' removeEntry ' + n);
          if (fault === 'removeFails') throw new DOMException('not allowed', 'NotAllowedError');
          if (fault === 'removeNoop') return undefined;
          return dir.removeEntry(n, o);
        },
        values() {
          const it = dir.values();
          if (!fault || !fault.startsWith('stallAfter')) return it;
          const n = +fault.slice(10); let i = 0;
          return { next() { return i++ >= n ? new Promise(() => {}) : it.next(); }, [Symbol.asyncIterator]() { return this; } };
        },
        async queryPermission() { return 'granted'; },
      };
    },
  };
  window.showDirectoryPicker = async () => {
    if (!window.__pick) throw new DOMException('The user aborted a request.', 'AbortError');
    return window.__pick;
  };
  // Test switches that must hold from the first line of the app, kept across reloads.
  if (localStorage.getItem('__noPicker')) delete window.showDirectoryPicker;
  if (localStorage.getItem('__askOnReopen') && window.FileSystemHandle) {
    FileSystemHandle.prototype.queryPermission = async () => 'prompt';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
  }
}

// persistent: a throwaway on-disk profile instead of the usual incognito-style
// context. Chromium's off-the-record mode crashes the whole browser when a
// stored folder handle is read back from IndexedDB (seen with Playwright 1.63,
// 29/10/26); a normal profile, like the one on the phone, does not. Tests that
// reopen the app after picking a folder need it.
async function newApp({ sw = false, clipboard = false, persistent = false } = {}) {
  const opts = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: sw ? 'allow' : 'block' };
  let ctx;
  if (persistent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-profile-'));
    ctx = await pw.chromium.launchPersistentContext(dir, opts);
    const close = ctx.close.bind(ctx);
    ctx.close = async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  } else ctx = await browser.newContext(opts);
  if (clipboard) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  ctx.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'blob:' || u.protocol === 'data:') return;
    if (u.origin !== BASE) foreignRequests.push(r.url());
  });
  await ctx.addInitScript(pageFixtures);
  const page = ctx.pages()[0] || await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(BASE + '/filter.html');
  await ready(page);
  return { ctx, page };
}

const ready = (page) => page.evaluate(() => window.filterReady);
const idle = (page) => page.waitForFunction(() => window.filter && !window.filter.state().busy, null, { timeout: 120000 });
async function run(page, button) { await page.click(button); await idle(page); }
async function section(page, id) {
  return page.evaluate((id) => {
    const s = window.filter.results()[id];
    if (!s) return null;
    return { verdict: s.verdict, rows: Object.fromEntries(s.rows.map(([k, v, t]) => [k, { v, t }])), list: s.rows };
  }, id);
}
// Choose the folder the fake picker will hand over, then press "Pick folder".
async function pick(page, p) {
  await page.evaluate(async (p) => { window.__pick = await window.__fx.dir(p); }, p);
  await run(page, '#btn-pick');
}

/* ---------- Core: names into kinds ---------- */

test('kindOf: photos, videos, Android hidden files and other', async () => {
  const { ctx, page } = await newApp();
  const got = await page.evaluate(() => {
    const names = ['PXL_20261029_101500123.jpg', 'IMG_1.JPEG', 'a.png', 'b.webp', 'c.heic', 'd.HEIF', 'e.avif', 'f.gif', 'g.dng',
      'PXL_20261029_101500123.mp4', 'h.MOV', 'i.webm', 'j.3gp', 'k.mkv', 'l.m4v',
      '.trashed-1767225600-PXL_1.jpg', '.pending-1767225600-PXL_2.mp4', '.nomedia',
      'notes.txt', 'desktop.ini', 'noextension', 'jpg', 'photo.jpg.txt', 'archive.zip'];
    return names.map((n) => window.filter.core.kindOf(n));
  });
  eq(got, ['photo', 'photo', 'photo', 'photo', 'photo', 'photo', 'photo', 'photo', 'photo',
    'video', 'video', 'video', 'video', 'video', 'video',
    'hidden', 'hidden', 'hidden',
    'other', 'other', 'other', 'other', 'other', 'other'], 'kinds');
  await ctx.close();
}, { core: true });

/* ---------- Core: reading a folder in batches ---------- */

test('readBatch stops at the limit, carries on from there, and counts every kind exactly', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const d = await window.__fx.big('Big', { photo: 400, video: 150, hidden: 50, other: 15, folder: 5 });
    const it = d.values();
    const c = window.filter.core;
    const a = await c.readBatch(it, { limit: 500, stallMs: 5000 });
    const b = await c.readBatch(it, { limit: 500, stallMs: 5000 });
    const z = await c.readBatch(it, { limit: 500, stallMs: 5000 });
    const sum = {};
    for (const k of Object.keys(a.counts)) sum[k] = a.counts[k] + b.counts[k];
    const names = new Set([...a.entries, ...b.entries].map((e) => e.name));
    return { a: [a.entries.length, a.done, a.stalled], b: [b.entries.length, b.done, b.stalled], z: [z.entries.length, z.done],
      sum, distinct: names.size, aSum: Object.values(a.counts).reduce((s, x) => s + x, 0),
      kindsMatch: [...a.entries, ...b.entries].every((e) => e.kind === (e.handle.kind === 'directory' ? 'folder' : c.kindOf(e.name))) };
  });
  eq(r.a, [500, false, false], 'first batch');
  eq(r.b, [120, true, false], 'second batch');
  eq(r.z, [0, true], 'a finished listing');
  eq(r.sum, { photo: 400, video: 150, folder: 5, hidden: 50, other: 15 }, 'counts over both batches');
  assert(r.distinct === 620, 'every entry read once, got ' + r.distinct);
  assert(r.aSum === 500, 'first batch counts add up to 500, got ' + r.aSum);
  assert(r.kindsMatch, 'each entry carries its kind');
  await ctx.close();
}, { core: true });

test('readBatch times the first entry and the whole batch', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const c = window.filter.core;
    const d = await window.__fx.big('Timed', { photo: 3, video: 0, hidden: 0, other: 0 });
    let t = 0; const now = () => (t += 10);
    const b = await c.readBatch(d.values(), { limit: 500, stallMs: 5000, now });
    const e = await c.readBatch((await window.__fx.dir('Empty')).values(), { limit: 500, stallMs: 5000, now });
    return { first: b.firstMs, ms: b.ms, n: b.entries.length, done: b.done, eFirst: e.firstMs, eDone: e.done, eN: e.entries.length };
  });
  // Clock calls: start (10), first entry (20), end (30).
  eq([r.first, r.ms, r.n, r.done], [10, 20, 3, true], 'first entry 10 ms after the start, batch 20 ms');
  eq([r.eFirst, r.eDone, r.eN], [null, true, 0], 'an empty folder');
  await ctx.close();
}, { core: true });

test('readBatch reports a stall instead of hanging', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const d = await window.__fx.big('Stall', { photo: 30, video: 0, hidden: 0, other: 0 });
    const t0 = performance.now();
    const b = await window.filter.core.readBatch(window.__fx.wrap(d, 'stallAfter7').values(), { limit: 500, stallMs: 250 });
    return { n: b.entries.length, stalled: b.stalled, done: b.done, wall: performance.now() - t0, ms: b.ms };
  });
  eq([r.n, r.stalled, r.done], [7, true, false], 'seven entries, then a stall');
  assert(r.wall >= 240 && r.wall < 1000, 'gave up after about 250 ms, took ' + r.wall);
  assert(r.ms >= 240, 'batch time includes the wait, got ' + r.ms);
  await ctx.close();
}, { core: true });

test('readBatch passes a listing error on', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const it = { next: () => Promise.reject(new DOMException('gone', 'NotFoundError')) };
    try { await window.filter.core.readBatch(it, { limit: 5, stallMs: 1000 }); return 'no error'; }
    catch (e) { return e.name; }
  });
  eq(r, 'NotFoundError', 'error');
  await ctx.close();
}, { core: true });

/* ---------- Core: hashing and lookups ---------- */

test('sha256 matches Node for a known string and for random bytes', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const c = window.filter.core;
    const abc = await c.sha256(new Blob([new TextEncoder().encode('abc')]));
    const empty = await c.sha256(new Blob([]));
    const n = window.__fx.noise(100003, 42);
    return { abc, empty, noise: await c.sha256(new Blob([n])), bytes: Array.from(n.subarray(0, 8)) };
  });
  eq(r.abc, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc")');
  eq(r.empty, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256 of nothing');
  // Rebuild the same noise in Node and hash it independently.
  const b = Buffer.alloc(100003); let x = 42;
  for (let i = 0; i < b.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 255; }
  eq(Array.from(b.subarray(0, 8)), r.bytes, 'same noise');
  eq(r.noise, sha(b), 'sha256 of 100 kB of noise');
  await ctx.close();
}, { core: true });

test('exists: a file, a missing name, and a folder of that name', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const d = await window.__fx.dir('Ex');
    await window.__fx.put(d, 'a.jpg', new Uint8Array([1]));
    await d.getDirectoryHandle('sub', { create: true });
    const c = window.filter.core;
    return [await c.exists(d, 'a.jpg'), await c.exists(d, 'b.jpg'), await c.exists(d, 'sub')];
  });
  eq(r, [true, false, true], 'exists');
  await ctx.close();
}, { core: true });

/* ---------- Core: the safe move ---------- */

// Runs core.safeMove in the page on a fresh A -> A/to pair holding one file of
// random bytes. fault: { from, to } names a fault for either side.
async function moveCase(page, { size = 300000, fault = {}, alter = false, clash = false, missing = false } = {}) {
  return page.evaluate(async ({ size, fault, alter, clash, missing }) => {
    const fx = window.__fx, c = window.filter.core;
    const tag = 'M' + Math.random().toString(36).slice(2, 8);
    const from = await fx.dir(tag), to = await fx.dir(tag + '/to');
    const name = 'PXL_20261029_101500123.jpg';
    const bytes = fx.noise(size, 9);
    if (!missing) await fx.put(from, name, bytes);
    if (clash) await fx.put(to, name, fx.noise(1234, 5));
    const before = { from: await fx.tree(from), to: await fx.tree(to) };
    const ops = [];
    const f = fault.from ? fx.wrap(from, fault.from, ops, 'from') : fx.wrap(from, null, ops, 'from');
    const t = fault.to ? fx.wrap(to, fault.to, ops, 'to') : fx.wrap(to, null, ops, 'to');
    const steps = [];
    const opts = { onStep: (st) => steps.push(st) };
    if (alter) opts.alterCopy = async (file) => { const b = new Uint8Array(await file.arrayBuffer()); b[b.length >> 1] ^= 0xFF; return b; };
    const log = await c.safeMove(f, name, t, opts);
    return {
      log, ops, before, name, steps,
      srcSha: missing ? null : await fx.sha(new Blob([bytes])),
      fromHas: await fx.has(from, name), toHas: await fx.has(to, name),
      fromSha: (await fx.has(from, name)) ? await fx.shaOf(from, name) : null,
      toSha: (await fx.has(to, name)) ? await fx.shaOf(to, name) : null,
      toSize: (await fx.has(to, name)) ? (await (await to.getFileHandle(name)).getFile()).size : null,
      after: { from: await fx.tree(from), to: await fx.tree(to) },
    };
  }, { size, fault, alter, clash, missing });
}

test('safe move: copies, reads back, checks size and SHA-256, then deletes the original', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page);
  const L = r.log;
  eq([L.ok, L.step, L.kept, L.originalGone], [true, 'done', 'copy', true], 'outcome');
  eq([L.size, L.copySize], [300000, 300000], 'sizes');
  eq(L.sha256, r.srcSha, 'hash of the original');
  eq(L.copySha256, r.srcSha, 'hash of the copy');
  eq([r.fromHas, r.toHas, r.toSha], [false, true, r.srcSha], 'original gone, copy byte-identical');
  for (const k of ['hash', 'copy', 'readBack', 'delete']) assert(typeof L.ms[k] === 'number' && L.ms[k] >= 0, 'time for ' + k);
  assert(!L.reason, 'no reason on success: ' + L.reason);
  eq(r.steps, ['read original', 'check target', 'copy', 'read back', 'compare', 'recheck original', 'delete original', 'done'], 'each step reported as it starts');
  await ctx.close();
}, { core: true });

test('safe move: a forced bad copy (one byte changed) stops and keeps both', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page, { alter: true });
  const L = r.log;
  eq([L.ok, L.step, L.kept, L.reason], [false, 'compare', 'both', 'SHA-256 differs'], 'outcome');
  eq([r.fromHas, r.fromSha], [true, r.srcSha], 'original kept, unchanged');
  assert(r.toHas && r.toSha !== r.srcSha && r.toSize === 300000, 'the bad copy is left beside it, same size, different bytes');
  assert(!r.ops.some((o) => o.includes('removeEntry')), 'nothing deleted');
  eq(r.steps, ['read original', 'check target', 'copy', 'read back', 'compare'], 'steps stop at the compare');
  await ctx.close();
}, { core: true });

test('safe move: a disk that changes a byte is caught the same way', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page, { fault: { to: 'flip' } });
  const L = r.log;
  eq([L.ok, L.step, L.kept, L.reason], [false, 'compare', 'both', 'SHA-256 differs'], 'outcome');
  eq([r.fromHas, r.fromSha], [true, r.srcSha], 'original kept, unchanged');
  assert(r.toSha !== r.srcSha, 'copy really differs');
  await ctx.close();
}, { core: true });

test('safe move: a short copy is caught by the size check', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page, { fault: { to: 'truncate' } });
  const L = r.log;
  eq([L.ok, L.step, L.kept, L.copySize], [false, 'compare', 'both', 299900], 'outcome');
  assert(/^size differs/.test(L.reason), 'reason names the size: ' + L.reason);
  eq([r.fromHas, r.fromSha], [true, r.srcSha], 'original kept, unchanged');
  await ctx.close();
}, { core: true });

test('safe move: never overwrites a file already in the target folder', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page, { clash: true });
  const L = r.log;
  eq([L.ok, L.step, L.kept], [false, 'check target', 'original'], 'outcome');
  eq(r.after, r.before, 'both folders exactly as before');
  assert(!r.ops.some((o) => /createWritable|removeEntry/.test(o)), 'nothing written or deleted: ' + r.ops.join(', '));
  await ctx.close();
}, { core: true });

test('safe move: a failed write keeps the original', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page, { fault: { to: 'throwWrite' } });
  const L = r.log;
  eq([L.ok, L.step, L.kept], [false, 'copy', 'both'], 'outcome');
  assert(/QuotaExceededError/.test(L.reason), 'reason carries the error: ' + L.reason);
  eq([r.fromHas, r.fromSha], [true, r.srcSha], 'original kept, unchanged');
  assert(!r.ops.some((o) => o.includes('removeEntry')), 'nothing deleted');
  await ctx.close();
}, { core: true });

test('safe move: a write that fails part way is abandoned and reported', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page, { fault: { to: 'failMidWrite' } });
  const L = r.log;
  eq([L.ok, L.step, L.kept], [false, 'copy', 'both'], 'outcome');
  assert(/NotReadableError: card removed/.test(L.reason), 'reason carries the error: ' + L.reason);
  assert(r.ops.includes('to abort ' + r.name), 'the half-written copy was abandoned');
  assert(!r.ops.some((o) => o.startsWith('to getFile ')), 'no read back after a failed write');
  eq([r.fromHas, r.fromSha], [true, r.srcSha], 'original kept, unchanged');
  await ctx.close();
}, { core: true });

test('safe move: a refused delete keeps both and says so', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page, { fault: { from: 'removeFails' } });
  const L = r.log;
  eq([L.ok, L.step, L.kept], [false, 'delete original', 'both'], 'outcome');
  assert(/NotAllowedError/.test(L.reason), 'reason: ' + L.reason);
  eq([r.fromSha, r.toSha], [r.srcSha, r.srcSha], 'original and good copy both there');
  await ctx.close();
}, { core: true });

test('safe move: a delete that silently does nothing is caught', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page, { fault: { from: 'removeNoop' } });
  const L = r.log;
  eq([L.ok, L.kept, L.originalGone], [false, 'both', false], 'outcome');
  assert(/still listed/.test(L.reason), 'reason: ' + L.reason);
  eq([r.fromSha, r.toSha], [r.srcSha, r.srcSha], 'both there');
  await ctx.close();
}, { core: true });

test('safe move: an original that changes during the copy is not deleted', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page, { fault: { from: 'changesOriginal' } });
  const L = r.log;
  eq([L.ok, L.step, L.kept], [false, 'recheck original', 'both'], 'outcome');
  assert(r.fromHas, 'original still there');
  assert(!r.ops.some((o) => o.includes('removeEntry')), 'nothing deleted');
  await ctx.close();
}, { core: true });

test('safe move: the delete is the last step, on the original only, after the copy is read back', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page);
  const ops = r.ops, n = r.name;
  const del = ops.filter((o) => o.includes('removeEntry'));
  eq(del, ['from removeEntry ' + n], 'one delete, of the original');
  const at = (s) => ops.lastIndexOf(s);
  assert(at('to createWritable ' + n) > at('from getFile ' + n) - 999, 'copy written');
  assert(ops.indexOf('to getFile ' + n) > ops.indexOf('to createWritable ' + n), 'copy read back after writing');
  assert(ops.indexOf('from removeEntry ' + n) > ops.indexOf('to getFile ' + n), 'delete after the read back');
  assert(ops.indexOf('from removeEntry ' + n) > ops.lastIndexOf('from getFile ' + n), 'delete after the original is re-checked');
  eq(ops.filter((o) => o === 'from getFile ' + n).length, 2, 'original read twice (hash, then re-check)');
  await ctx.close();
}, { core: true });

test('safe move: a missing original creates nothing and never throws', async () => {
  const { ctx, page } = await newApp();
  const r = await moveCase(page, { missing: true });
  const L = r.log;
  eq([L.ok, L.step, L.kept], [false, 'read original', 'original'], 'outcome');
  assert(/NotFoundError/.test(L.reason), 'reason: ' + L.reason);
  eq(r.after.to, {}, 'target folder still empty');
  await ctx.close();
}, { core: true });

/* ---------- Probe: the page ---------- */

test('page opens clean: darkroom, four questions, buttons wait for a folder', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    cards: [...document.querySelectorAll('.card h2')].map((h) => h.textContent),
    disabled: ['#btn-read', '#btn-count', '#btn-move', '#btn-recog'].map((s) => document.querySelector(s).disabled),
    pick: document.querySelector('#btn-pick').disabled,
    status: document.querySelector('#status').textContent,
    device: window.filter.results().device.rows.map((r) => r[1]),
    reopen: window.filter.results().reopen.rows[0],
    small: [...document.querySelectorAll('button:not([hidden])')].filter((b) => b.offsetParent && (b.offsetWidth < 44 || b.offsetHeight < 44)).map((b) => b.id || b.textContent),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  eq(r.bg, 'rgb(11, 11, 11)', 'stage colour');
  eq(r.cards, ['This phone', 'Folder', 'Safe move', 'Reopen', 'Recognition'], 'cards');
  eq(r.disabled, [true, true, true, true], 'folder buttons disabled');
  eq(r.pick, false, 'pick enabled');
  eq(r.status, 'no folder yet', 'status');
  assert(/^\d+\.\d+\.\d+\.\d+$/.test(r.device[0]) && !/\.0\.0\.0$/.test(r.device[0]), 'full Chrome version from client hints: ' + r.device[0]);
  eq(r.device[1], 'not Android', 'Android row on a desktop test browser');
  assert(/no folder yet/.test(r.reopen[1]), 'reopen says nothing stored yet');
  eq(r.small, [], 'tap targets under 44 px');
  eq(r.overflow, false, 'no sideways scroll at phone width');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('01 folder: counts the fake camera folder exactly and times it', async () => {
  const { ctx, page } = await newApp();
  await page.evaluate(() => window.__fx.camera());
  await pick(page, 'DCIM/Camera');
  const s = await section(page, 'folder');
  eq(s.verdict, 'pass', 'verdict');
  eq(s.rows.Folder.v, 'Camera', 'folder');
  eq(s.rows.Entries.v, '20, the whole folder', 'entries');
  eq([s.rows.Photos.v, s.rows.Videos.v, s.rows.Subfolders.v, s.rows.Other.v], ['8', '4', '2', '3'], 'counts');
  assert(/^3 /.test(s.rows.Hidden.v), 'hidden: ' + s.rows.Hidden.v);
  assert(/ms$/.test(s.rows['First entry'].v) && /per entry/.test(s.rows['Read time'].v), 'timed');
  eq(s.rows.Stall.v, 'none', 'no stall');
  assert(/^12 files, /.test(s.rows['File sizes'].v), 'sizes read for 12 media files: ' + s.rows['File sizes'].v);
  const st = await page.evaluate(() => [document.querySelector('#btn-move').disabled, document.querySelector('#status').textContent]);
  eq(st, [false, 'folder ▸ Camera'], 'buttons enabled, status');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('01 folder: stops at 500 in a big folder, and count all reads it all in batches', async () => {
  const { ctx, page } = await newApp();
  await page.evaluate(() => window.__fx.big('DCIM/Big', { photo: 900, video: 250, hidden: 60, other: 20, folder: 4 }));
  await pick(page, 'DCIM/Big');
  let s = await section(page, 'folder');
  eq(s.rows.Entries.v, '500, stopped at 500, there are more', 'first batch');
  const sum = ['Photos', 'Videos', 'Subfolders', 'Other'].reduce((a, k) => a + +s.rows[k].v, 0) + parseInt(s.rows.Hidden.v, 10);
  eq(sum, 500, 'counts in the first batch add up');
  await run(page, '#btn-count');
  s = await section(page, 'folder');
  eq(s.verdict, 'pass', 'verdict');
  eq(s.rows['All entries'].v, '1234, whole folder', 'all entries');
  eq(s.rows['All counts'].v, '900 photos, 250 videos, 4 subfolders, 60 hidden, 20 other', 'all counts');
  assert(/ in 3 batches, slowest batch /.test(s.rows['All time'].v), 'batches: ' + s.rows['All time'].v);
  await run(page, '#btn-count');
  s = await section(page, 'folder');
  eq(s.list.filter((r) => r[0] === 'All entries').length, 1, 'a second count replaces the first');
  await ctx.close();
});

test('01 folder: a stalling folder is reported as a stall, not a hang', async () => {
  const { ctx, page } = await newApp();
  await page.evaluate(async () => {
    const d = await window.__fx.big('DCIM/Slow', { photo: 40, video: 0, hidden: 0, other: 0 });
    window.filter.config.stallMs = 300;
    window.__pick = window.__fx.wrap(d, 'stallAfter7');
  });
  await run(page, '#btn-pick');
  const s = await section(page, 'folder');
  eq(s.verdict, 'fail', 'verdict');
  eq(s.rows.Stall.v, 'nothing new for 0.3 s after 7 entries', 'stall row');
  eq(s.rows.Stall.t, 'fail', 'stall tone');
  await ctx.close();
});

test('01 folder: closing the picker changes nothing; no picker at all is a clear fail', async () => {
  const { ctx, page } = await newApp();
  await run(page, '#btn-pick');                 // __pick unset: the fake picker reports AbortError
  eq(await section(page, 'folder'), null, 'nothing recorded after closing the picker');
  await page.evaluate(() => localStorage.setItem('__noPicker', '1'));
  await page.reload(); await ready(page);
  await run(page, '#btn-pick');
  const s = await section(page, 'folder');
  eq([s.verdict, s.rows.Picker.t], ['fail', 'fail'], 'no picker');
  await ctx.close();
});

test('02 safe move: the full test passes, cleans up, and leaves the real files untouched', async () => {
  const { ctx, page } = await newApp();
  await page.evaluate(() => window.__fx.camera());
  await pick(page, 'DCIM/Camera');
  const before = await page.evaluate(async () => window.__fx.tree(await window.__fx.dir('DCIM/Camera')));
  await page.evaluate(() => { window.filter.config.testImageSide = 160; });
  await run(page, '#btn-move');
  const s = await section(page, 'move');
  const fails = s.list.filter((r) => r[2] === 'fail');
  eq(fails, [], 'no failing rows');
  eq(s.verdict, 'pass', 'verdict');
  assert(/created/.test(s.rows.Subfolder.v), 'subfolder created: ' + s.rows.Subfolder.v);
  assert(/^filter-probe-move-\d{6}-\d{6}\.png, /.test(s.rows['Test file'].v), 'test file named by the probe: ' + s.rows['Test file'].v);
  eq(s.rows['Safe move'].v, 'done: copied, checked, original deleted', 'move');
  assert(/ on both$/.test(s.rows['SHA-256'].v), 'hashes match: ' + s.rows['SHA-256'].v);
  assert(/^caught: SHA-256 differs/.test(s.rows['Bad copy'].v), 'bad copy caught: ' + s.rows['Bad copy'].v);
  const originals = s.list.filter((r) => r[0] === 'Original').map((r) => r[1]);
  eq(originals, ['deleted, and no longer listed in the folder', 'kept, unchanged (same SHA-256 as before)'], 'originals');
  assert(/^[\d.]+ ms, [\d.]+ MB\/s$/.test(s.rows['Whole move'].v), 'whole move: ' + s.rows['Whole move'].v);
  assert(/^hash [\d.]+ ms, copy [\d.]+ ms, read back and hash [\d.]+ ms, delete [\d.]+ ms, then the check it is gone$/.test(s.rows.Times.v), 'times: ' + s.rows.Times.v);
  assert(/^20 entries in [\d.]+ ms$/.test(s.rows['Full listing'].v), 'full listing: ' + s.rows['Full listing'].v);
  eq(s.rows.Leftovers.v, 'none', 'no leftovers');
  assert(/^[\d.]+ ms in Camera, [\d.]+ ms in filter-probe\/$/.test(s.rows['Name lookup'].v), 'lookups: ' + s.rows['Name lookup'].v);
  eq(s.rows['Clean up'].v, '4 removed', 'clean up: the moved copy, the bad copy, its original, and the subfolder');
  const after = await page.evaluate(async () => window.__fx.tree(await window.__fx.dir('DCIM/Camera')));
  eq(after, before, 'the camera folder is exactly as it was, file for file and hash for hash');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('02 safe move: an existing filter-probe folder and its contents are left alone', async () => {
  const { ctx, page } = await newApp();
  await page.evaluate(async () => {
    const cam = await window.__fx.camera();
    const sub = await cam.getDirectoryHandle('filter-probe', { create: true });
    await window.__fx.put(sub, 'keep.jpg', await window.__fx.jpeg(3));
  });
  await pick(page, 'DCIM/Camera');
  const before = await page.evaluate(async () => window.__fx.tree(await window.__fx.dir('DCIM/Camera')));
  await page.evaluate(() => { window.filter.config.testImageSide = 128; });
  await run(page, '#btn-move');
  const s = await section(page, 'move');
  eq(s.verdict, 'pass', 'verdict');
  eq(s.rows.Subfolder.v, 'filter-probe was already there, kept', 'subfolder');
  eq(s.rows['Clean up'].v, '3 removed, filter-probe/ kept: it holds other files', 'only the probe files removed');
  const after = await page.evaluate(async () => window.__fx.tree(await window.__fx.dir('DCIM/Camera')));
  eq(after, before, 'folder and keep.jpg as before');
  await ctx.close();
});

test('02 safe move: leftovers from a run cut off part way are cleaned up first', async () => {
  const { ctx, page } = await newApp();
  const clean = await page.evaluate(async () => { const cam = await window.__fx.camera(); return window.__fx.tree(cam); });
  await page.evaluate(async () => {
    const fx = window.__fx, cam = await fx.dir('DCIM/Camera');
    const sub = await cam.getDirectoryHandle('filter-probe', { create: true });
    await fx.put(cam, 'filter-probe-move-261030-010438.png', fx.noise(2000, 4));
    await fx.put(sub, 'filter-probe-move-261030-010438.png', fx.noise(900, 4));
    await fx.put(sub, 'filter-probe-move-261030-010438.png.crswap', fx.noise(500, 4));
    window.filter.config.testImageSide = 128;
  });
  await pick(page, 'DCIM/Camera');
  await run(page, '#btn-move');
  const s = await section(page, 'move');
  eq(s.verdict, 'pass', 'verdict');
  assert(/^22 entries in /.test(s.rows['Full listing'].v), 'listing counts the leftovers too: ' + s.rows['Full listing'].v);
  assert(/^3 from an earlier run removed: /.test(s.rows.Leftovers.v) && s.rows.Leftovers.v.includes('.crswap'), 'leftovers: ' + s.rows.Leftovers.v);
  eq(s.rows.Subfolder.v, 'filter-probe was already there, kept', 'subfolder');
  eq(s.rows['Clean up'].v, '4 removed', 'then the run cleans up, including the now empty subfolder');
  const after = await page.evaluate(async () => window.__fx.tree(await window.__fx.dir('DCIM/Camera')));
  eq(after, clean, 'camera folder back to exactly the real files');
  await ctx.close();
});

test('03 reopen: a stored folder comes back after a reload without asking', async () => {
  const { ctx, page } = await newApp({ persistent: true });
  await page.evaluate(() => window.__fx.camera());
  await pick(page, 'DCIM/Camera');
  await page.reload(); await ready(page);
  const s = await section(page, 'reopen');
  eq(s.verdict, 'pass', 'verdict');
  assert(/^Camera, picked \d\d\/\d\d\/\d\d \d{4} hrs$/.test(s.rows.Stored.v), 'stored: ' + s.rows.Stored.v);
  assert(/browser tab, permission granted without asking, read ok in [\d.]+ ms$/.test(s.rows['Open 1'].v), 'open 1: ' + s.rows['Open 1'].v);
  const st = await page.evaluate(() => [document.querySelector('#btn-move').disabled, document.querySelector('#status').textContent, document.querySelector('#btn-ask').hidden]);
  eq(st, [false, 'folder ▸ Camera', true], 'folder usable straight away');
  await page.reload(); await ready(page);
  const s2 = await section(page, 'reopen');
  assert(s2.rows['Open 1'] && s2.rows['Open 2'], 'each opening recorded');
  await ctx.close();
});

test('03 reopen: when Chrome asks again, the probe records it and the ask button works', async () => {
  const { ctx, page } = await newApp({ persistent: true });
  await page.evaluate(() => window.__fx.camera());
  await pick(page, 'DCIM/Camera');
  await page.evaluate(() => localStorage.setItem('__askOnReopen', '1'));
  await page.reload(); await ready(page);
  let s = await section(page, 'reopen');
  eq(s.verdict, 'watch', 'verdict before asking');
  assert(/permission prompt without asking$/.test(s.rows['Open 1'].v), 'open 1: ' + s.rows['Open 1'].v);
  let st = await page.evaluate(() => [document.querySelector('#btn-ask').hidden, document.querySelector('#btn-move').disabled]);
  eq(st, [false, true], 'ask shown, folder not yet usable');
  await run(page, '#btn-ask');
  s = await section(page, 'reopen');
  assert(/permission granted after asking \(granted in [\d.]+ ms\), read ok in [\d.]+ ms$/.test(s.rows['Open 1'].v), 'after asking: ' + s.rows['Open 1'].v);
  eq(s.verdict, 'watch', 'asking is noted, not a pass');
  st = await page.evaluate(() => [document.querySelector('#btn-ask').hidden, document.querySelector('#btn-move').disabled]);
  eq(st, [true, false], 'folder usable after asking');
  await ctx.close();
});

test('04 recognition: the real classifier runs offline on five photos read in place', async () => {
  const { ctx, page } = await newApp();
  await page.evaluate(() => window.__fx.camera());
  await pick(page, 'DCIM/Camera');
  const before = await page.evaluate(async () => window.__fx.tree(await window.__fx.dir('DCIM/Camera')));
  await run(page, '#btn-recog');
  const s = await section(page, 'recog');
  assert(s.verdict === 'pass' || s.verdict === 'watch', 'verdict ' + s.verdict + ': ' + JSON.stringify(s.list));
  assert(/^5 from Camera/.test(s.rows.Photos.v), 'photos: ' + s.rows.Photos.v);
  assert(/ms to load the model$/.test(s.rows['CPU start'].v), 'cpu start');
  for (let i = 1; i <= 5; i++) {
    const v = (s.rows['CPU #' + i] || {}).v || '';
    assert(/^decode [\d.]+ ms, classify [\d.]+ ms, top "[^"]+" (0|1)\.\d\d$/.test(v), 'CPU #' + i + ': ' + v);
  }
  assert(/min per 1000 photos$/.test(s.rows['CPU mean'].v), 'cpu mean: ' + s.rows['CPU mean'].v);
  const gpu = s.list.filter((r) => r[0].startsWith('GPU'));
  console.log('      GPU in headless Chromium: ' + (gpu.length ? gpu[gpu.length - 1][1] : 'no rows'));
  const after = await page.evaluate(async () => window.__fx.tree(await window.__fx.dir('DCIM/Camera')));
  eq(after, before, 'photos only read, folder unchanged');
  // MediaPipe's wasm prints this start-up note through console.error; it is not a fault.
  const real = page.errors.filter((e) => e !== 'INFO: Created TensorFlow Lite XNNPACK delegate for CPU.');
  assert(real.length === 0, real.join('; '));
  await ctx.close();
});

test('results: kept across a reload, copied as text, cleared with two taps', async () => {
  const { ctx, page } = await newApp({ clipboard: true, persistent: true });
  await page.evaluate(() => window.__fx.camera());
  await pick(page, 'DCIM/Camera');
  await page.reload(); await ready(page);
  const folder = await section(page, 'folder');
  eq(folder && folder.rows.Entries.v, '20, the whole folder', 'folder result survived the reload');
  await page.click('#btn-copy');
  await page.waitForSelector('#notice:not([hidden])');
  const [clip, text] = await page.evaluate(async () => [await navigator.clipboard.readText(), window.filter.reportText()]);
  const body = (t) => t.split('\n').slice(1).join('\n');
  eq(body(clip), body(text), 'clipboard holds the report');
  assert(new RegExp('^filter F0 probe v' + VERSION.replace(/\./g, '\\.') + ', report made \\d\\d/\\d\\d/\\d\\d \\d{4} hrs$').test(clip.split('\n')[0]), 'header: ' + clip.split('\n')[0]);
  for (const h of ['00 THIS PHONE', '01 FOLDER [PASS]', '02 SAFE MOVE: not run', '03 REOPEN [PASS]', '04 RECOGNITION: not run']) assert(clip.includes(h), 'report has ' + h);
  assert(clip.includes('  Photos: 8'), 'report has the counts');
  assert(!clip.includes('—'), 'no em dashes');
  await page.click('#btn-clear');
  eq(await section(page, 'folder') !== null, true, 'one tap does not clear');
  await page.click('#btn-clear');
  eq(await section(page, 'folder'), null, 'two taps clear');
  await ctx.close();
});

test('offline: the service worker caches the app, MediaPipe and the model', async () => {
  const { ctx, page } = await newApp({ sw: true });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async (version) => {
    const keys = await caches.keys();
    if (!keys.includes('filter-v' + version)) return false;
    const v = keys.find((k) => k.startsWith('filter-mediapipe-'));
    return v && (await (await caches.open(v)).keys()).length === 4;
  }, VERSION, { timeout: 60000, polling: 250 });
  await ctx.setOffline(true);
  await page.reload(); await ready(page);
  const r = await page.evaluate(async () => {
    const font = await document.fonts.load('600 14px "Barlow Semi Condensed"');
    return { title: document.title, font: font.length, model: !!(await caches.match('vendor/mediapipe/efficientnet_lite0.tflite')) };
  });
  eq(r, { title: 'filter', font: 1, model: true }, 'offline page, font and model');
  await ctx.close();
});

/* ---------- Runner ---------- */

(async () => {
  pw = loadPlaywright();
  const srv = await startServer();
  BASE = 'http://127.0.0.1:' + srv.address().port;
  browser = await pw.chromium.launch();
  let pass = 0, fail = 0, skipped = 0;
  const t0 = Date.now();
  for (const t of tests) {
    if (ONLY_CORE && !t.core) continue;
    if (GREP && !GREP.test(t.name)) continue;
    const s = Date.now();
    try {
      await t.fn();
      pass++;
      console.log('PASS ' + t.name + '  (' + (Date.now() - s) + ' ms)');
    } catch (e) {
      if (e instanceof Skip) { skipped++; console.log('SKIP ' + t.name + ': ' + e.message); continue; }
      fail++;
      console.log('FAIL ' + t.name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n      '));
    }
  }
  if (!ONLY_CORE && !GREP) {
    if (foreignRequests.length) { fail++; console.log('FAIL no requests to other origins\n      ' + foreignRequests.join('\n      ')); }
    else { pass++; console.log('PASS no requests to other origins during the whole run'); }
  }
  await browser.close();
  srv.close();
  console.log('\nfilter_behave: ' + pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
