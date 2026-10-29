#!/usr/bin/env node
// filter_behave.cjs: behavioural tests in real Chromium (Playwright).
//
// The File System Access API, canvas, IndexedDB, wasm and service workers only
// behave properly in a real browser, so this suite serves the repo on localhost
// and drives the app.
//
// The fake folder tree: in place of the real folder picker, each test builds a
// DCIM/Camera folder in Chromium's private origin file system (OPFS). Its
// handles are real FileSystemDirectoryHandles, so the copy and the read back go
// through the browser's own file code. Wrappers on top of it plant faults: a
// disk that changes a byte, a short write, a write that fails part way, a
// listing that stalls. Every picture is synthetic (coloured shapes, a page of
// text, screen-sized PNGs, planted camera data and previews); no real photo is
// used. The two models are swapped for a stand-in that answers by file name, so
// where each photo lands can be checked exactly; one test runs the real models.
//
// Run:            node filter_behave.cjs
// Core only:      FILTER_ONLY=core node filter_behave.cjs   (used by filter_mutate.sh)
// Other page:     FILTER_HTML=/path/to/mutant.html node filter_behave.cjs
// Filter by name: FILTER_GREP=copy node filter_behave.cjs

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
    // A picture of a coloured shape on a plain ground, or one flat colour.
    async picture(i, { w = 320, h = 240, type = 'image/jpeg', flat = null } = {}) {
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d');
      x.fillStyle = flat || ['#2d6a4f', '#1d3557', '#e9c46a', '#8d99ae', '#bc4749', '#6d597a', '#264653', '#f4a261'][i % 8];
      x.fillRect(0, 0, w, h);
      if (!flat) {
        x.fillStyle = ['#ffffff', '#e63946', '#000000', '#ffb703'][i % 4];
        x.beginPath(); x.arc(w * 0.3, h * 0.5, h * 0.25, 0, 7); x.fill();
        x.fillRect(w * 0.6, h * 0.2, w * 0.25, h * 0.3);
      }
      return c.convertToBlob({ type, quality: 0.9 });
    },
    // A page of black text on white.
    async textPage(w = 600, h = 800) {
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#111111'; x.font = '22px sans-serif';
      for (let y = 50; y < h - 30; y += 34) x.fillText('Receipt 29/10/26 item 4.50 total 12.80 paid card', 30, y);
      return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    },
    // Plant camera data (EXIF) straight after the start of a JPEG: make, model,
    // orientation, and optionally a preview picture in IFD1. le: Intel byte order.
    async withExif(jpeg, { make = 'Google', model = 'Pixel 9 Pro XL', orientation = 1, thumb = null, le = false } = {}) {
      const main = new Uint8Array(await jpeg.arrayBuffer());
      const tb = thumb ? new Uint8Array(await thumb.arrayBuffer()) : null;
      const enc = new TextEncoder();
      const mk = enc.encode(make + '\0'), md = enc.encode(model + '\0');
      const ifd0 = 8, n0 = 3, strAt = ifd0 + 2 + n0 * 12 + 4;
      const mkAt = strAt, mdAt = mkAt + (mk.length > 4 ? mk.length : 0);
      let ifd1 = mdAt + (md.length > 4 ? md.length : 0); ifd1 += ifd1 & 1;
      const thAt = ifd1 + (tb ? 2 + 2 * 12 + 4 : 0);
      const t = new Uint8Array(thAt + (tb ? tb.length : 0));
      const dv = new DataView(t.buffer);
      t[0] = t[1] = le ? 0x49 : 0x4D; dv.setUint16(2, 42, le); dv.setUint32(4, ifd0, le);
      const head = (at, tag, type, count) => { dv.setUint16(at, tag, le); dv.setUint16(at + 2, type, le); dv.setUint32(at + 4, count, le); };
      const str = (at, tag, bytes, where) => { head(at, tag, 2, bytes.length); if (bytes.length <= 4) t.set(bytes, at + 8); else { dv.setUint32(at + 8, where, le); t.set(bytes, where); } };
      dv.setUint16(ifd0, n0, le);
      str(ifd0 + 2, 0x010F, mk, mkAt);
      str(ifd0 + 14, 0x0110, md, mdAt);
      head(ifd0 + 26, 0x0112, 3, 1); dv.setUint16(ifd0 + 34, orientation, le);
      dv.setUint32(ifd0 + 2 + n0 * 12, tb ? ifd1 : 0, le);
      if (tb) {
        dv.setUint16(ifd1, 2, le);
        head(ifd1 + 2, 0x0201, 4, 1); dv.setUint32(ifd1 + 10, thAt, le);
        head(ifd1 + 14, 0x0202, 4, 1); dv.setUint32(ifd1 + 22, tb.length, le);
        dv.setUint32(ifd1 + 26, 0, le);
        t.set(tb, thAt);
      }
      const payload = new Uint8Array(6 + t.length);
      payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]); payload.set(t, 6);
      const seg = new Uint8Array(4 + payload.length);
      seg[0] = 0xFF; seg[1] = 0xE1; seg[2] = (payload.length + 2) >> 8; seg[3] = (payload.length + 2) & 255; seg.set(payload, 4);
      const out = new Uint8Array(main.length + seg.length);
      out.set(main.subarray(0, 2)); out.set(seg, 2); out.set(main.subarray(2), 2 + seg.length);
      return new Blob([out], { type: 'image/jpeg' });
    },
    // The standard fake camera folder. Photo names carry dates, newest first;
    // what the stand-in models "see" in each is in __answers.
    async camera() {
      const cam = await this.dir('DCIM/Camera');
      const A = window.__answers = {};
      const photo = async (name, i, answer, opts = {}) => {
        const pic = opts.blob || await this.picture(i);
        await this.put(cam, name, await this.withExif(pic));
        A[name] = answer;
      };
      // Like Gary's classroom photos (30/10/26): small people, faces turned away, a room of tables.
      // On the small preview one person is barely seen; the closer look finds three.
      await photo('PXL_20261029_101000000.jpg', 0, { labels: [{ index: 762, name: 'restaurant', score: 0.5 }],
        objects: [{ name: 'person', score: 0.45, w: 0.1, h: 0.2 }],
        // the closer look finds three, one of them twice (in two overlapping parts)
        closer: { objects: [0.1, 0.4, 0.7].map((x) => ({ name: 'person', score: 0.7, w: 0.15, h: 0.3, x, y: 0.5 }))
          .concat([{ name: 'person', score: 0.65, x: 0.11, y: 0.51, w: 0.14, h: 0.28 }]) } });
      await photo('PXL_20261029_100900000.jpg', 1, { labels: [{ index: 207, name: 'golden retriever', score: 0.4 }, { index: 208, name: 'Labrador retriever', score: 0.2 }] });
      await photo('PXL_20261029_100800000.jpg', 2, { labels: [{ index: 963, name: 'pizza', score: 0.7 }] });
      await photo('PXL_20261029_100700000.jpg', 3, { labels: [{ index: 978, name: 'seashore', score: 0.3 }, { index: 975, name: 'lakeside', score: 0.1 }] });
      await photo('PXL_20261029_100600000.jpg', 4, {}, { blob: await this.textPage() });
      // Like Gary's hand close-up (30/10/26): a false face, seen only in a quarter of the photo.
      // Its closer look "sees" a pizza: the closer look decides people only (third run, 30/10/26).
      // Like the hand with a bottle (fourth run): a "person" filling the frame, and pieces
      // of the hand called people in three of the closer look's parts.
      await photo('PXL_20261029_100500000.jpg', 5, { labels: [{ index: 600, name: 'hook', score: 0.12 }], faces: [{ w: 0.3, h: 0.35, score: 0.8, tile: true }],
        objects: [{ name: 'person', score: 0.89, x: 0.02, y: 0, w: 0.95, h: 0.98 }],
        closer: { objects: [{ name: 'pizza', score: 0.8, x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
          { name: 'person', score: 0.84, x: 0, y: 0, w: 0.4, h: 0.45 }, { name: 'person', score: 0.8, x: 0.55, y: 0, w: 0.4, h: 0.45 },
          { name: 'person', score: 0.75, x: 0.3, y: 0.55, w: 0.4, h: 0.45 }] } });
      await this.put(cam, 'Screenshot_20261029-100400.png', await this.picture(6, { w: 540, h: 1200, type: 'image/png' }));
      await this.put(cam, 'IMG_20261029_100300.png', await this.picture(7, { w: 1344, h: 2992, type: 'image/png' }));
      // Like Gary's suit photos (fifth run, 30/10/26): no face, a "person" filling the frame, and a suit seen.
      await photo('PXL_20261029_100200000.jpg', 6, { objects: [{ name: 'person', score: 0.94, x: 0.03, y: 0, w: 0.94, h: 1 }],
        labels: [{ index: 834, name: 'suit', score: 0.6 }, { index: 906, name: 'Windsor tie', score: 0.1 }] });
      await photo('PXL_20250101_120000000.jpg', 7, { objects: [{ name: 'cat', score: 0.8, w: 0.5, h: 0.4 }], labels: [{ index: 600, name: 'hook', score: 0.2 }] });
      for (let i = 0; i < 2; i++) await this.put(cam, 'PXL_20261029_11' + i + '000000.mp4', this.noise(3000 + i, i + 7));
      await this.put(cam, '.trashed-1767225600-PXL_20261001_090000000.jpg', await this.picture(9));
      await this.put(cam, 'notes.txt', new TextEncoder().encode('not a photo'));
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
    // sub: faults for subfolders by name, e.g. { pets: 'flip' }.
    wrap(dir, fault, ops = [], label = dir.name, sub = {}) {
      const wrapFile = (fh, name) => ({
        kind: 'file', name: fh.name,
        async getFile() { ops.push(label + ' getFile ' + name); return fh.getFile(); },
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
      const self = this;
      return {
        kind: 'directory', name: dir.name,
        async getFileHandle(n, o) { ops.push(label + ' getFileHandle ' + n + (o && o.create ? ' create' : '')); return wrapFile(await dir.getFileHandle(n, o), n); },
        async getDirectoryHandle(n, o) {
          const d = await dir.getDirectoryHandle(n, o);
          return sub[n] ? self.wrap(d, sub[n], ops, n) : d;
        },
        values() {
          const it = dir.values();
          if (!fault || !fault.startsWith('stallAfter')) return it;
          const k = +fault.slice(10); let i = 0;
          return { next() { return i++ >= k ? new Promise(() => {}) : it.next(); }, [Symbol.asyncIterator]() { return this; } };
        },
        async queryPermission() { return 'granted'; },
      };
    },
    // The pixels of an image at a blob: address (a review thumbnail), through
    // an <img>, as the page's CSP allows images from blob: but not fetch.
    async look(url) {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      return { w: img.naturalWidth, h: img.naturalHeight, centre: Array.from(x.getImageData(img.naturalWidth >> 1, img.naturalHeight >> 1, 1, 1).data) };
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
async function newApp({ sw = false, persistent = false, models = 'stand-in', clipboard = false } = {}) {
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
  page.models = models;
  await page.goto(BASE + '/filter.html');
  await ready(page);
  return { ctx, page };
}

// Wait for the app to start; swap in the stand-in models unless the test wants the real ones.
const ready = async (page) => {
  await page.evaluate(() => window.filterReady);
  if (page.models === 'stand-in') await page.evaluate(() => { window.filter.recog.override = (e) => (window.__answers || {})[e.name] || {}; });
};
const idle = (page) => page.waitForFunction(() => window.filter && !window.filter.state.busy, null, { timeout: 120000 });
async function run(page, button) { await page.click(button); await idle(page); }
const screen = (page) => page.evaluate(() => window.filter.state.screen);
const rowsOf = (page, sel) => page.evaluate((sel) => Object.fromEntries([...document.querySelectorAll(sel + ' .r')].map((r) => [r.children[0].textContent, r.children[1].textContent])), sel);
const text = (page, sel) => page.evaluate((sel) => document.querySelector(sel).textContent, sel);
// The plan as { category: [names] }.
const plan = (page) => page.evaluate(() => {
  const out = {};
  for (const p of window.filter.state.plan) (out[p.category] = out[p.category] || []).push(p.name);
  return out;
});
// Seed the standard camera folder and pick it. sub: faults for filter's subfolders.
async function openCamera(page, sub = null) {
  await page.evaluate(async (sub) => {
    const cam = await window.__fx.camera();
    window.__pick = sub ? window.__fx.wrap(cam, null, [], cam.name, sub) : cam;
  }, sub);
  await run(page, '#btn-pick');
}
async function sort(page, n) {
  if (n) await page.fill('#newest', String(n));
  await run(page, '#btn-sort');
}
const camTree = (page) => page.evaluate(async () => window.__fx.tree(await window.__fx.dir('DCIM/Camera')));
const onlyRoot = (tree) => Object.fromEntries(Object.entries(tree).filter(([k]) => !k.includes('/')));
// The files (not the folder entry itself) directly inside a subfolder, as names.
const filesIn = (tree, dir) => Object.keys(tree).filter((k) => k.startsWith(dir + '/') && k !== dir + '/').map((k) => k.slice(dir.length + 1)).sort();
const readLog = (page, name) => page.evaluate(async (n) => JSON.parse(await (await (await (await window.__fx.dir('DCIM/Camera/filter-logs')).getFileHandle(n)).getFile()).text()), name);

const EXPECTED_PLAN = {
  people: ['PXL_20261029_101000000.jpg', 'PXL_20261029_100200000.jpg'],
  pets: ['PXL_20261029_100900000.jpg', 'PXL_20250101_120000000.jpg'],
  food: ['PXL_20261029_100800000.jpg'],
  scenery: ['PXL_20261029_100700000.jpg'],
  documents: ['PXL_20261029_100600000.jpg'],
  other: ['PXL_20261029_100500000.jpg'],
  screenshots: ['Screenshot_20261029-100400.png', 'IMG_20261029_100300.png'],
};
const sortPlan = (p) => Object.fromEntries(Object.keys(p).sort().map((k) => [k, p[k].slice().sort()]));

/* ---------- Core: names, folders, hashes ---------- */

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
  eq([r.first, r.ms, r.n, r.done], [10, 20, 3, true], 'first entry 10 ms after the start, batch 20 ms');
  eq([r.eFirst, r.eDone, r.eN], [null, true, 0], 'an empty folder');
  await ctx.close();
}, { core: true });

test('readBatch reports a stall instead of hanging, and passes listing errors on', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const d = await window.__fx.big('Stall', { photo: 30, video: 0, hidden: 0, other: 0 });
    const t0 = performance.now();
    const b = await window.filter.core.readBatch(window.__fx.wrap(d, 'stallAfter7').values(), { limit: 500, stallMs: 250 });
    const wall = performance.now() - t0;
    let err = 'no error';
    try { await window.filter.core.readBatch({ next: () => Promise.reject(new DOMException('gone', 'NotFoundError')) }, { limit: 5, stallMs: 1000 }); }
    catch (e) { err = e.name; }
    return { n: b.entries.length, stalled: b.stalled, done: b.done, wall, err };
  });
  eq([r.n, r.stalled, r.done], [7, true, false], 'seven entries, then a stall');
  assert(r.wall >= 240 && r.wall < 1000, 'gave up after about 250 ms, took ' + r.wall);
  eq(r.err, 'NotFoundError', 'listing error passed on');
  await ctx.close();
}, { core: true });

test('sha256 matches Node for a known string and for random bytes; exists sees files and folders', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const c = window.filter.core;
    const d = await window.__fx.dir('Ex');
    await window.__fx.put(d, 'a.jpg', new Uint8Array([1]));
    await d.getDirectoryHandle('sub', { create: true });
    return {
      abc: await c.sha256(new Blob([new TextEncoder().encode('abc')])),
      empty: await c.sha256(new Blob([])),
      noise: await c.sha256(new Blob([window.__fx.noise(100003, 42)])),
      exists: [await c.exists(d, 'a.jpg'), await c.exists(d, 'b.jpg'), await c.exists(d, 'sub')],
    };
  });
  eq(r.abc, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc")');
  eq(r.empty, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256 of nothing');
  const b = Buffer.alloc(100003); let x = 42;
  for (let i = 0; i < b.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 255; }
  eq(r.noise, sha(b), 'sha256 of 100 kB of noise');
  eq(r.exists, [true, false, true], 'exists');
  await ctx.close();
}, { core: true });

/* ---------- Core: choosing the newest photos ---------- */

test('dateKey reads the date from Pixel, camera and screenshot names', async () => {
  const { ctx, page } = await newApp();
  const got = await page.evaluate(() => ['PXL_20261029_101500123.jpg', 'IMG_20250101_000001.jpg', 'Screenshot_20261029-101500.png',
    'PXL_20261029_101500123.RAW-01.MP.COVER.jpg', 'VID_20240229235959.mp4', 'photo.jpg', 'PXL_2026.jpg', 'IMG_20261329_101500.jpg',
    'IMG_20261000_101500.jpg', 'IMG_20261032_101500.jpg', 'scan 20261029 101500.jpg'].map((n) => window.filter.core.dateKey(n)));
  eq(got, ['20261029101500', '20250101000001', '20261029101500', '20261029101500', '20240229235959', null, null, null, null, null, null], 'keys');
  await ctx.close();
}, { core: true });

test('pickNewest takes the newest not yet sorted, undated last, ties by name', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const p = (name) => ({ name });
    // Same-time and undated names are given in ascending order, so only the name tie-break puts them right.
    const photos = ['PXL_20261029_101500000.jpg', 'IMG_20261030_090000.jpg', 'beach.jpg', 'PXL_20250101_120000000.jpg',
      'holiday.jpg', 'PXL_20261031_080000000.jpg', 'PXL_20261030_090000000.jpg'].map(p);
    const c = window.filter.core;
    const all = c.pickNewest(photos, new Set(), 10);
    const some = c.pickNewest(photos, new Set(['PXL_20261031_080000000.jpg', 'beach.jpg']), 3);
    const none = c.pickNewest(photos, new Set(), 0);
    return { all: all.chosen.map((x) => x.name), some: some.chosen.map((x) => x.name), counts: [some.fresh, some.sorted], none: none.chosen.length };
  });
  eq(r.all, ['PXL_20261031_080000000.jpg', 'PXL_20261030_090000000.jpg', 'IMG_20261030_090000.jpg', 'PXL_20261029_101500000.jpg',
    'PXL_20250101_120000000.jpg', 'holiday.jpg', 'beach.jpg'], 'newest first, same time by name, undated last');
  eq(r.some, ['PXL_20261030_090000000.jpg', 'IMG_20261030_090000.jpg', 'PXL_20261029_101500000.jpg'], 'skips the sorted ones, takes 3');
  eq(r.counts, [5, 2], 'fresh and sorted counts');
  eq(r.none, 0, 'n = 0 takes nothing');
  await ctx.close();
}, { core: true });

/* ---------- Core: reading a photo's header ---------- */

test('imageInfo reads size, camera, orientation and the preview from a JPEG, both byte orders', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const fx = window.__fx, c = window.filter.core;
    const thumb = await fx.picture(1, { w: 320, h: 240 });
    const tb = new Uint8Array(await thumb.arrayBuffer());
    const out = {};
    for (const le of [false, true]) {
      const j = new Uint8Array(await (await fx.withExif(await fx.picture(0, { w: 1600, h: 1200 }), { orientation: 6, thumb, le })).arrayBuffer());
      const info = c.imageInfo(j);
      const slice = j.subarray(info.thumb.start, info.thumb.start + info.thumb.length);
      out[le ? 'le' : 'be'] = { format: info.format, w: info.width, h: info.height, make: info.make, model: info.model, o: info.orientation,
        thumbSame: slice.length === tb.length && slice.every((x, i) => x === tb[i]) };
    }
    const short = c.imageInfo(new Uint8Array(await (await fx.withExif(await fx.picture(0), { make: 'LG', model: 'G8', orientation: 3 })).arrayBuffer()));
    out.short = [short.make, short.model, short.orientation, short.thumb, short.width, short.height];
    const bare = c.imageInfo(new Uint8Array(await (await fx.picture(2, { w: 400, h: 300 })).arrayBuffer()));
    out.bare = [bare.format, bare.width, bare.height, bare.make, bare.orientation, bare.thumb];
    const png = c.imageInfo(new Uint8Array(await (await fx.picture(3, { w: 1344, h: 2992, type: 'image/png' })).arrayBuffer()));
    out.png = [png.format, png.width, png.height, png.make];
    out.webp = c.imageInfo(new Uint8Array(await (await fx.picture(3, { type: 'image/webp' })).arrayBuffer())).format;
    out.junk = c.imageInfo(fx.noise(5000, 3)).format;
    // Cut off part way through the camera data: no crash, no wild preview.
    const full = new Uint8Array(await (await fx.withExif(await fx.picture(0, { w: 1600, h: 1200 }), { thumb })).arrayBuffer());
    const cut = c.imageInfo(full.subarray(0, 300));
    out.cut = [cut.format, cut.make, cut.thumb];
    const bad = full.slice(); bad[15] = 0x99;   // break the TIFF magic number (42)
    out.bad = c.imageInfo(bad).make;
    const fill = new Uint8Array(full.length + 1); fill.set(full.subarray(0, 2)); fill[2] = 0xFF; fill.set(full.subarray(2), 3);   // a fill byte, allowed before any marker
    const fi = c.imageInfo(fill);
    out.fill = [fi.make, fi.width];
    out.o9 = c.imageInfo(new Uint8Array(await (await fx.withExif(await fx.picture(0), { orientation: 9 })).arrayBuffer())).orientation;
    return out;
  });
  for (const k of ['be', 'le']) eq(r[k], { format: 'jpeg', w: 1600, h: 1200, make: 'Google', model: 'Pixel 9 Pro XL', o: 6, thumbSame: true }, k);
  eq(r.short, ['LG', 'G8', 3, null, 320, 240], 'short strings stored inside the entry');
  eq(r.bare, ['jpeg', 400, 300, null, 1, null], 'no camera data');
  eq(r.png, ['png', 1344, 2992, null], 'PNG size');
  eq(r.webp, 'webp', 'WebP');
  eq(r.junk, null, 'not a picture');
  eq(r.cut, ['jpeg', 'Google', null], 'cut short: what was read, no preview');
  eq(r.bad, null, 'broken camera data ignored');
  eq(r.fill, ['Google', 1600], 'fill bytes before a marker are skipped');
  eq(r.o9, 1, 'an orientation outside 1 to 8 is ignored');
  await ctx.close();
}, { core: true });

test('tiles and facesFrom: five looks, a quarter needs more confidence, never counted twice', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const c = window.filter.core;
    const t = c.tiles(500, 400);
    const runs = [
      { full: true, dets: [{ w: 100, h: 90, score: 0.9 }, { w: 30, h: 30, score: 0.95 }, { w: 80, h: 80, score: 0.74 }] },   // one counts
      { full: false, dets: [{ w: 60, h: 60, score: 0.86 }, { w: 50, h: 45, score: 0.9 }] },                                  // two in one quarter
      { full: false, dets: [{ w: 120, h: 120, score: 0.84 }] },                                                              // big but not sure enough for a quarter
    ];
    const one = (full, d) => c.facesFrom([{ full, dets: [d] }], 500, 400);
    return { t, f: c.facesFrom(runs, 500, 400),
      small: one(true, { w: 39, h: 31, score: 0.99 }), fullEdge: one(true, { w: 40, h: 10, score: 0.75 }), fullUnder: one(true, { w: 200, h: 200, score: 0.749 }),
      tileEdge: one(false, { w: 200, h: 200, score: 0.85 }), tileUnder: one(false, { w: 200, h: 200, score: 0.849 }), tall: one(true, { w: 10, h: 32, score: 0.8 }) };
  });
  eq(r.t, [{ x: 0, y: 0, w: 500, h: 400, full: true }, { x: 0, y: 0, w: 300, h: 240 }, { x: 200, y: 0, w: 300, h: 240 },
    { x: 0, y: 160, w: 300, h: 240 }, { x: 200, y: 160, w: 300, h: 240 }], 'tiles');
  eq(r.f, { count: 2, size: 0.225, score: 0.9 }, 'faces');
  eq(r.small.count, 0, 'too small (under 8 % of width and height)');
  eq([r.fullEdge.count, r.fullUnder.count], [1, 0], 'whole photo: 0.75 counts, just under does not');
  eq([r.tileEdge.count, r.tileUnder.count], [1, 0], 'a quarter: 0.85 counts, just under does not');
  eq([r.tall.count, r.tall.size], [1, 0.08], 'tall face measured against the height');
  await ctx.close();
}, { core: true });

test('objectsFrom: boxes per folder, confident and big enough, biggest and best kept', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const c = window.filter.core;
    const d = (name, score, w, h) => ({ name, score, x: 0, y: 0, w, h });
    // The biggest boxes come first, so keeping the last one's size instead of the biggest would show.
    return c.objectsFrom([d('person', 0.7, 0.9, 0.899), d('cat', 0.9, 0.95, 0.95), d('person', 0.6, 0.9, 0.9),
      d('person', 0.9, 0.2, 0.5), d('person', 0.49, 0.6, 0.75), d('person', 0.95, 0.1, 0.0995),
      d('dog', 0.7, 0.25, 0.5), d('cat', 0.8, 0.12, 0.15), d('pizza', 0.65, 0.2, 0.25), d('laptop', 0.99, 0.6, 0.5), d('bowl', 0.9, 0.4, 0.5), d('person', 0.5, 0.1, 0.2)]);
  });
  eq(r.people, { count: 3, area: 0.8091, score: 0.9, name: 'person', best: 0.95, filled: 1, fillScore: 0.6 },
    'people: three count (one unsure, one too small); one fills the frame at 0.9 x 0.9; one just short of it counts');
  eq(r.pets, { count: 3, area: 0.9025, score: 0.9, name: 'cat', best: 0.9, filled: 0, fillScore: 0 }, 'pets: a cat filling the frame is still a cat');
  eq(r.food, { count: 1, area: 0.05, score: 0.65, name: 'pizza', best: 0.65, filled: 0, fillScore: 0 }, 'food: a bowl is not food');
  const near = await page.evaluate(() => window.filter.core.closerPeople([
    { name: 'person', score: 0.7, x: 0, y: 0, w: 0.3, h: 0.4 }, { name: 'person', score: 0.7, x: 0, y: 0, w: 0.3, h: 0.401 },
    { name: 'dog', score: 0.9, x: 0, y: 0, w: 0.1, h: 0.1 }, { name: 'person', score: 0.5, x: 0, y: 0, w: 0.1, h: 0.2 }]).map((b) => b.name + ' ' + b.h));
  eq(near, ['person 0.4', 'person 0.2'], 'the closer look adds people up to 12 % of the photo, and nothing else');
  await ctx.close();
}, { core: true });

test('grid, normBoxes and dedupe: parts edge to edge, boxes back on the whole photo, one thing counted once', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const c = window.filter.core;
    const b = (name, score, x, y, w, h) => ({ name, score, x, y, w, h });
    const kept = (boxes) => c.dedupe(boxes).map((k) => k.name + ' ' + k.score);
    return {
      g: c.grid(1000, 800, 3, 0.45), one: c.grid(100, 80, 1, 1),
      norm: c.normBoxes([{ name: 'person', score: 0.8, x: 50, y: 40, w: 100, h: 200 }], 1000, 800, 550, 440),
      // a person seen in two overlapping parts, a person cut by a part's edge, two people side by side
      twice: kept([b('person', 0.7, 0.10, 0.10, 0.20, 0.40), b('person', 0.8, 0.12, 0.11, 0.20, 0.40)]),
      cut: kept([b('person', 0.9, 0.10, 0.10, 0.20, 0.40), b('person', 0.6, 0.10, 0.10, 0.08, 0.40)]),
      side: kept([b('person', 0.7, 0.10, 0.10, 0.20, 0.40), b('person', 0.8, 0.31, 0.10, 0.20, 0.40)]),
      touching: kept([b('person', 0.7, 0.10, 0.10, 0.20, 0.40), b('person', 0.8, 0.30, 0.10, 0.20, 0.40)]),
      // two 0.5 x 0.5 boxes 0.2 apart overlap by 0.43 (intersection over union): one; 0.23 apart, 0.37: two
      overlapSame: kept([b('person', 0.9, 0, 0, 0.5, 0.5), b('person', 0.8, 0.2, 0, 0.5, 0.5)]),
      overlapApart: kept([b('person', 0.9, 0, 0, 0.5, 0.5), b('person', 0.8, 0.23, 0, 0.5, 0.5)]),
      stacked: kept([b('person', 0.7, 0.10, 0.05, 0.20, 0.40), b('person', 0.8, 0.10, 0.50, 0.20, 0.40)]),
      labels: kept([b('person', 0.7, 0.10, 0.10, 0.20, 0.40), b('dog', 0.8, 0.10, 0.10, 0.20, 0.40)]),
      order: kept([b('person', 0.5, 0, 0, 0.2, 0.2), b('person', 0.9, 0.01, 0, 0.2, 0.2), b('person', 0.7, 0.02, 0, 0.2, 0.2)]),
    };
  });
  eq(r.g.length, 9, 'nine parts');
  eq(r.g[0], { x: 0, y: 0, w: 450, h: 360 }, 'first part at the top left');
  eq(r.g[4], { x: 275, y: 220, w: 450, h: 360 }, 'middle part centred');
  eq(r.g[8], { x: 550, y: 440, w: 450, h: 360 }, 'last part reaches the bottom right edge');
  eq(r.one, [{ x: 0, y: 0, w: 100, h: 80 }], 'a 1 x 1 grid is the whole photo');
  eq(r.norm, [{ name: 'person', score: 0.8, x: 0.6, y: 0.6, w: 0.1, h: 0.25 }], 'a box in a part, as shares of the whole photo');
  eq(r.twice, ['person 0.8'], 'seen twice, counted once, the surer box kept');
  eq(r.cut, ['person 0.9'], 'a box mostly inside another is the same person');
  eq(r.side, ['person 0.8', 'person 0.7'], 'two people side by side stay two');
  eq(r.touching, ['person 0.8', 'person 0.7'], 'boxes that only touch stay two');
  eq(r.labels, ['dog 0.8', 'person 0.7'], 'a dog and a person in one place stay apart');
  eq(r.overlapSame, ['person 0.9'], 'overlap over the sameBox bar: one');
  eq(r.overlapApart, ['person 0.9', 'person 0.8'], 'overlap under the bar: two');
  eq(r.stacked, ['person 0.8', 'person 0.7'], 'one above the other, same column: two');
  eq(r.order, ['person 0.9'], 'surest first');
  await ctx.close();
}, { core: true });

test('textLike: a page of text yes; plain, colourful, noisy and chequered pictures no', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const look = async (draw, w = 128, h = 170) => {
      const c = new OffscreenCanvas(w, h); const x = c.getContext('2d', { willReadFrequently: true });
      await draw(x, w, h);
      return window.filter.core.textLike(x.getImageData(0, 0, w, h).data, w, h);
    };
    const page = await look(async (x, w, h) => x.drawImage(await createImageBitmap(await window.__fx.textPage()), 0, 0, w, h));
    const white = await look((x, w, h) => { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); });
    const shapes = await look(async (x, w, h) => x.drawImage(await createImageBitmap(await window.__fx.picture(4)), 0, 0, w, h));
    const noise = await look((x, w, h) => { const d = x.createImageData(w, h); d.data.set(window.__fx.noise(w * h * 4, 5)); for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255; x.putImageData(d, 0, 0); });
    const chequer = await look((x, w, h) => { for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? '#000' : '#fff'; x.fillRect(i * w / 4, j * h / 4, w / 4, h / 4); } });
    const yellow = await look((x, w, h) => { x.fillStyle = '#ffd040'; x.fillRect(0, 0, w, h); x.fillStyle = '#111'; x.font = '9px sans-serif'; for (let y = 10; y < h; y += 12) x.fillText('total 12.80 paid card', 4, y); });
    const dark = await look((x, w, h) => { x.fillStyle = '#222'; x.fillRect(0, 0, w, h); x.fillStyle = '#eee'; x.font = '9px sans-serif'; for (let y = 10; y < h; y += 12) x.fillText('total 12.80 paid card', 4, y); });
    // Each of these passes every rule but one.
    const stripes = await look((x, w, h) => { for (let i = 0; i < w; i += 2) { x.fillStyle = '#fff'; x.fillRect(i, 0, 1, h); x.fillStyle = '#000'; x.fillRect(i + 1, 0, 1, h); } });   // too much dark
    const block = await look((x, w, h) => { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.fillStyle = '#000'; x.fillRect(20, 30, 50, 60); });   // no strokes, few edges
    const greyPaper = await look((x, w, h) => { x.fillStyle = '#969696'; x.fillRect(0, 0, w, h); x.fillStyle = '#111'; x.font = '9px sans-serif'; for (let y = 10; y < h; y += 12) x.fillText('total 12.80 paid card', 4, y); });   // not bright
    return { page, white: white.isText, shapes: shapes.isText, noise: noise.isText, chequer: chequer.isText, yellow, dark: dark.isText, stripes, block, greyPaper };
  });
  assert(r.page.isText, 'text page: ' + JSON.stringify(r.page));
  for (const k of ['white', 'shapes', 'noise', 'chequer', 'dark']) eq(r[k], false, k);
  assert(!r.stripes.isText && r.stripes.dark > 0.3 && r.stripes.bright >= 0.5 && r.stripes.edges >= 0.04, 'stripes fail on dark only: ' + JSON.stringify(r.stripes));
  assert(!r.block.isText && r.block.edges < 0.04 && r.block.dark >= 0.02 && r.block.dark <= 0.3, 'a black block fails on edges only: ' + JSON.stringify(r.block));
  assert(!r.greyPaper.isText && r.greyPaper.bright < 0.5 && r.greyPaper.edges >= 0.04 && r.greyPaper.sat <= 0.18, 'grey paper fails on brightness only: ' + JSON.stringify(r.greyPaper));
  assert(r.yellow.sat > 0.18 && !r.yellow.isText, 'text on strongly coloured paper does not count: ' + JSON.stringify(r.yellow));
  await ctx.close();
}, { core: true });

test('categorize: the rules in order, each threshold at its edge', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const c = window.filter.core;
    const none = { count: 0, size: 0, score: 0 }, face = { count: 1, size: 0.3, score: 0.91 }, two = { count: 2, size: 0.2, score: 0.8 };
    const base = { name: 'PXL_20261029_101500000.jpg', format: 'jpeg', make: 'Google', width: 4080, height: 3072, faces: none, labels: [], text: false };
    const L = (index, name, score) => ({ index, name, score });
    const cases = {
      shotName: { ...base, name: 'Screenshot_20261029-101500.png', faces: face },
      shotShape: { ...base, name: 'IMG_1.png', format: 'png', make: null, width: 1344, height: 2992, faces: face },
      shotLandscape: { ...base, name: 'IMG_1.png', format: 'png', make: null, width: 2992, height: 1344 },
      shotEdges: { ...base, name: 'IMG_1.png', format: 'png', make: null, width: 800, height: 1600 },
      pngWithCamera: { ...base, name: 'IMG_1.png', format: 'png', width: 1344, height: 2992 },
      jpegScreenShape: { ...base, make: null, width: 1344, height: 2992 },
      pngSmall: { ...base, name: 'IMG_1.png', format: 'png', make: null, width: 672, height: 1496 },
      pngSquare: { ...base, name: 'IMG_1.png', format: 'png', make: null, width: 2000, height: 2000 },
      pngWide: { ...base, name: 'IMG_1.png', format: 'png', make: null, width: 1000, height: 2992 },
      pngNarrow: { ...base, name: 'IMG_1.png', format: 'png', make: null, width: 1530, height: 3000 },
      people: { ...base, faces: face, text: true, labels: [L(207, 'golden retriever', 0.9)] },
      people2: { ...base, faces: two },
      text: { ...base, text: true, labels: [L(963, 'pizza', 0.9)] },
      dogs: { ...base, labels: [L(207, 'golden retriever', 0.15), L(963, 'pizza', 0.2), L(208, 'Labrador retriever', 0.12)] },
      food: { ...base, labels: [L(963, 'pizza', 0.25)] },
      pizzaWins: { ...base, labels: [L(207, 'golden retriever', 0.3), L(963, 'pizza', 0.5)] },
      foodUnder: { ...base, labels: [L(963, 'pizza', 0.24)] },
      scenery: { ...base, labels: [L(978, 'seashore', 0.2), L(975, 'lakeside', 0.1)] },
      docs: { ...base, labels: [L(922, 'menu', 0.4)] },
      cat: { ...base, labels: [L(285, 'Egyptian cat', 0.3)] },
      eleventh: { ...base, labels: [...Array.from({ length: 10 }, (_, i) => L(600 + i, 'x' + i, 0.01)), L(963, 'pizza', 0.9)] },
      ends: { ...base, labels: [L(151, 'Chihuahua', 0.13), L(268, 'Mexican hairless', 0.13)] },
      outside: { ...base, labels: [L(269, 'timber wolf', 0.6), L(150, 'sea lion', 0.6), L(958, 'hay', 0.9)] },
      empty: { ...base },
      crowd: { ...base, objects: { people: { count: 2, area: 0.02, score: 0.55, name: 'person' } } },
      onePersonBig: { ...base, objects: { people: { count: 1, area: 0.08, score: 0.65, name: 'person' } } },
      onePersonSmall: { ...base, objects: { people: { count: 1, area: 0.079, score: 0.9, name: 'person' } } },
      onePersonUnsure: { ...base, objects: { people: { count: 1, area: 0.5, score: 0.649, name: 'person' } } },
      textOverDog: { ...base, text: true, objects: { pets: { count: 1, area: 0.5, score: 0.9, name: 'dog' } } },
      dogSeen: { ...base, objects: { pets: { count: 1, area: 0.03, score: 0.6, name: 'dog' } }, labels: [L(963, 'pizza', 0.9)] },
      dogSmall: { ...base, objects: { pets: { count: 1, area: 0.029, score: 0.9, name: 'dog' } } },
      dogUnsure: { ...base, objects: { pets: { count: 1, area: 0.3, score: 0.59, name: 'dog' } } },
      cakeSeen: { ...base, objects: { food: { count: 1, area: 0.2, score: 0.7, name: 'cake' } } },
      petsBeforeFood: { ...base, objects: { pets: { count: 1, area: 0.1, score: 0.7, name: 'cat' }, food: { count: 1, area: 0.4, score: 0.9, name: 'pizza' } } },
      restaurant: { ...base, labels: [L(762, 'restaurant', 0.6), L(567, 'frying pan', 0.2), L(909, 'wok', 0.2)] },
      weakPerson: { ...base, labels: [L(526, 'desk', 0.16)], objects: { people: { count: 0, area: 0, score: 0, name: null, best: 0.41 } } },
      weakPersonOnly: { ...base, objects: { people: { count: 0, area: 0, score: 0, name: null, best: 0.38 } } },
      closeUp: { ...base, labels: [L(600, 'hook', 0.1)], objects: { people: { count: 0, area: 0, score: 0, name: null, best: 0.89, filled: 1, fillScore: 0.89 } } },
      portrait: { ...base, text: true, labels: [L(834, 'suit', 0.6)], objects: { people: { count: 0, area: 0, score: 0, name: null, best: 0.94, filled: 1, fillScore: 0.94 } } },
      portraitEdge: { ...base, labels: [L(834, 'suit', 0.15), L(457, 'bow tie', 0.1)], objects: { people: { count: 0, area: 0, score: 0, name: null, best: 0.65, filled: 1, fillScore: 0.65 } } },
      portraitThin: { ...base, labels: [L(834, 'suit', 0.15), L(457, 'bow tie', 0.09)], objects: { people: { count: 0, area: 0, score: 0, name: null, best: 0.9, filled: 1, fillScore: 0.9 } } },
      portraitUnsure: { ...base, labels: [L(834, 'suit', 0.8)], objects: { people: { count: 0, area: 0, score: 0, name: null, best: 0.649, filled: 1, fillScore: 0.649 } } },
      jeans: { ...base, labels: [L(608, 'jean', 0.5), L(630, 'Loafer', 0.3)], objects: { people: { count: 0, area: 0, score: 0, name: null, best: 0.9, filled: 1, fillScore: 0.9 } } },
      suitNoPerson: { ...base, labels: [L(834, 'suit', 0.9)] },
    };
    return Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, c.categorize(v)]));
  });
  const cat = (k) => r[k].category;
  eq(['shotName', 'shotShape', 'shotLandscape', 'shotEdges'].map(cat), ['screenshots', 'screenshots', 'screenshots', 'screenshots'], 'screenshots first, even with a face');
  eq([r.shotName.reason, r.shotShape.reason], ['screenshot by its name', 'screen-sized picture with no camera data'], 'screenshot reasons');
  eq(['pngWithCamera', 'jpegScreenShape', 'pngSmall', 'pngSquare', 'pngWide', 'pngNarrow'].map(cat), ['other', 'other', 'other', 'other', 'other', 'other'], 'not screenshots');
  eq([cat('people'), r.people.reason], ['people', '1 face, 0.91'], 'a face beats text and labels');
  eq(r.people2.reason, '2 faces, 0.80', 'two faces');
  eq([cat('text'), r.text.reason], ['documents', 'mostly text'], 'text beats labels');
  eq([cat('dogs'), r.dogs.reason], ['pets', 'golden retriever 0.15, pets 0.27'], 'dog breeds add up and beat a single pizza');
  eq([cat('food'), cat('foodUnder')], ['food', 'other'], 'labelMin edge');
  eq(cat('pizzaWins'), 'food', 'the highest sum wins, whatever the group order');
  eq([cat('scenery'), cat('docs'), cat('cat')], ['scenery', 'documents', 'pets'], 'groups');
  eq(cat('eleventh'), 'other', 'only the top 10 labels count');
  eq(cat('ends'), 'pets', 'both ends of a range count');
  eq([cat('outside'), r.outside.reason], ['other', 'nothing clear (best guess: timber wolf 0.60)'], 'labels just outside the groups');
  eq([cat('empty'), r.empty.reason], ['other', 'nothing clear'], 'nothing at all');
  eq([cat('crowd'), r.crowd.reason], ['people', '2 people, 0.55'], 'two person boxes are people');
  eq([cat('onePersonBig'), r.onePersonBig.reason], ['people', 'a person, 0.65'], 'one big sure person, at both edges');
  eq([cat('onePersonSmall'), cat('onePersonUnsure')], ['other', 'other'], 'one person too small or too unsure');
  eq(cat('textOverDog'), 'documents', 'text comes before a seen dog');
  eq([cat('dogSeen'), r.dogSeen.reason], ['pets', 'dog 0.60 (seen)'], 'a seen dog beats food labels, at both edges');
  eq([cat('dogSmall'), cat('dogUnsure')], ['other', 'other'], 'a dog too small or too unsure');
  eq([cat('cakeSeen'), cat('petsBeforeFood')], ['food', 'pets'], 'seen food; pets before food');
  eq(cat('restaurant'), 'other', 'a restaurant, a frying pan or a wok is not food');
  eq(r.weakPerson.reason, 'nothing clear (best guess: desk 0.16; best person 0.41)', 'other shows the best person score');
  eq(r.weakPersonOnly.reason, 'nothing clear (best person 0.38)', 'with no labels too');
  eq([cat('portrait'), r.portrait.reason], ['people', 'a person filling the frame, 0.94 (suit 0.60)'], 'a tight portrait in a suit: people, before text');
  eq([cat('portraitEdge'), cat('portraitThin'), cat('portraitUnsure')], ['people', 'other', 'other'], 'clothes add up to 0.25 at a person score of 0.65: both edges');
  eq([cat('jeans'), cat('suitNoPerson')], ['other', 'other'], 'jeans and shoes are not worn-clothes evidence; a suit with no person is not people');
  eq([cat('closeUp'), r.closeUp.reason], ['other', 'nothing clear (best guess: hook 0.10; best person 0.89; a person fills the frame: a close-up, not counted)'], 'a close-up is said so');
  await ctx.close();
}, { core: true });

test('mapAhead keeps order, never runs more than depth ahead, stops on request, passes errors on', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const c = window.filter.core;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    let inflight = 0, maxIn = 0;
    const load = async (x) => { inflight++; maxIn = Math.max(maxIn, inflight); await sleep(x % 3 ? 5 : 20); inflight--; return x * 10; };
    const seen = [];
    await c.mapAhead([1, 2, 3, 4, 5, 6, 7], 3, load, async (v, i) => { seen.push([v, i]); await sleep(2); });
    const stopped = [], loaded = [];
    await c.mapAhead([1, 2, 3, 4, 5, 6, 7, 8], 2, async (x) => { loaded.push(x); return x; }, (v) => { stopped.push(v); return v < 3; });
    let err = 'none';
    try { await c.mapAhead([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('bad ' + x); return x; }, () => {}); } catch (e) { err = e.message; }
    const empty = [];
    await c.mapAhead([], 3, async (x) => x, (v) => empty.push(v));
    return { seen, maxIn, stopped, loaded: loaded.length, err, empty: empty.length };
  });
  eq(r.seen, [[10, 0], [20, 1], [30, 2], [40, 3], [50, 4], [60, 5], [70, 6]], 'results in order');
  eq(r.maxIn, 3, 'at most 3 loading at once');
  eq(r.stopped, [1, 2, 3], 'stops when each returns false');
  assert(r.loaded <= 5, 'stopped early, loaded ' + r.loaded);
  eq(r.err, 'bad 2', 'a load error is passed on');
  eq(r.empty, 0, 'nothing to do');
  await ctx.close();
}, { core: true });

/* ---------- Core: the safe copy ---------- */

// Runs core.safeCopy in the page on a fresh A -> A/to pair holding one file of
// random bytes. fault names a fault for the target folder.
async function copyCase(page, { size = 300000, fault = null, existing = false, clash = false, missing = false } = {}) {
  return page.evaluate(async ({ size, fault, existing, clash, missing }) => {
    const fx = window.__fx, c = window.filter.core;
    const tag = 'C' + Math.random().toString(36).slice(2, 8);
    const from = await fx.dir(tag), to = await fx.dir(tag + '/to');
    const name = 'PXL_20261029_101500123.jpg';
    const bytes = fx.noise(size, 9);
    await fx.put(from, name, bytes);
    const src = await from.getFileHandle(name);
    if (missing) await from.removeEntry(name);
    if (clash) await fx.put(to, name, fx.noise(1234, 5));
    const before = { from: await fx.tree(from), to: await fx.tree(to) };
    const ops = [], steps = [];
    const t = fx.wrap(to, fault, ops, 'to');
    const log = await c.safeCopy(src, name, t, { existing: new Set(existing ? [name] : []), onStep: (s) => steps.push(s) });
    return {
      log, ops, steps, before, name,
      srcSha: await fx.sha(new Blob([bytes])),
      fromSha: (await fx.has(from, name)) ? await fx.shaOf(from, name) : null,
      toSha: (await fx.has(to, name)) ? await fx.shaOf(to, name) : null,
      toSize: (await fx.has(to, name)) ? (await (await to.getFileHandle(name)).getFile()).size : null,
      after: { from: await fx.tree(from), to: await fx.tree(to) },
    };
  }, { size, fault, existing, clash, missing });
}

test('safe copy: copies, reads the copy back, checks size and SHA-256, leaves the original as it was', async () => {
  const { ctx, page } = await newApp();
  const r = await copyCase(page);
  const L = r.log;
  eq([L.ok, L.skipped, L.step, L.copyMade], [true, false, 'done', true], 'outcome');
  eq([L.size, L.copySize], [300000, 300000], 'sizes');
  eq([L.sha256, L.copySha256], [r.srcSha, r.srcSha], 'hashes');
  eq([r.fromSha, r.toSha], [r.srcSha, r.srcSha], 'original unchanged, copy byte-identical');
  const top = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('to/')));
  eq(top(r.after.from), top(r.before.from), 'source folder exactly as before');
  eq(r.steps, ['read original', 'check target', 'copy', 'read back', 'compare', 'done'], 'each step reported as it starts');
  assert(!L.reason, 'no reason on success: ' + L.reason);
  for (const k of ['hash', 'copy', 'readBack']) assert(typeof L.ms[k] === 'number' && L.ms[k] >= 0, 'time for ' + k);
  await ctx.close();
}, { core: true });

test('safe copy: a name already listed in the target folder is skipped, nothing written', async () => {
  const { ctx, page } = await newApp();
  const r = await copyCase(page, { existing: true });
  eq([r.log.ok, r.log.skipped, r.log.step, r.log.copyMade, r.log.reason], [false, true, 'check target', false, 'already in the target folder'], 'outcome');
  eq(r.after, r.before, 'both folders as before');
  assert(!r.ops.some((o) => /createWritable|create$/.test(o)), 'nothing written: ' + r.ops.join(', '));
  await ctx.close();
}, { core: true });

test('safe copy: a file the listing missed is still never overwritten', async () => {
  const { ctx, page } = await newApp();
  const r = await copyCase(page, { clash: true });
  eq([r.log.ok, r.log.skipped, r.log.step], [false, true, 'check target'], 'outcome');
  eq(r.after, r.before, 'the file already there keeps its bytes');
  assert(!r.ops.some((o) => /createWritable/.test(o)), 'nothing written');
  await ctx.close();
}, { core: true });

test('safe copy: a disk that changes a byte is caught, both files kept', async () => {
  const { ctx, page } = await newApp();
  const r = await copyCase(page, { fault: 'flip' });
  const L = r.log;
  eq([L.ok, L.skipped, L.step, L.reason, L.copyMade], [false, false, 'compare', 'SHA-256 differs', true], 'outcome');
  eq(r.fromSha, r.srcSha, 'original unchanged');
  assert(r.toSha && r.toSha !== r.srcSha && r.toSize === 300000, 'the bad copy is left, same size, different bytes');
  await ctx.close();
}, { core: true });

test('safe copy: a short copy is caught by the size check', async () => {
  const { ctx, page } = await newApp();
  const r = await copyCase(page, { fault: 'truncate' });
  eq([r.log.ok, r.log.step, r.log.copySize], [false, 'compare', 299900], 'outcome');
  assert(/^size differs/.test(r.log.reason), 'reason names the size: ' + r.log.reason);
  eq(r.fromSha, r.srcSha, 'original unchanged');
  await ctx.close();
}, { core: true });

test('safe copy: a write that fails part way is abandoned and reported', async () => {
  const { ctx, page } = await newApp();
  const r = await copyCase(page, { fault: 'failMidWrite' });
  eq([r.log.ok, r.log.skipped, r.log.step], [false, false, 'copy'], 'outcome');
  assert(/NotReadableError: card removed/.test(r.log.reason), 'reason: ' + r.log.reason);
  assert(r.ops.includes('to abort ' + r.name), 'the half-written copy was abandoned');
  assert(!r.ops.some((o) => o.startsWith('to getFile ')), 'no read back after a failed write');
  eq(r.fromSha, r.srcSha, 'original unchanged');
  await ctx.close();
}, { core: true });

test('safe copy: a refused write and a missing original are reported, never thrown', async () => {
  const { ctx, page } = await newApp();
  const a = await copyCase(page, { fault: 'throwWrite' });
  eq([a.log.ok, a.log.step], [false, 'copy'], 'write refused');
  assert(/QuotaExceededError/.test(a.log.reason), 'reason: ' + a.log.reason);
  const b = await copyCase(page, { missing: true });
  eq([b.log.ok, b.log.skipped, b.log.step, b.log.copyMade], [false, false, 'read original', false], 'original gone');
  assert(/NotFoundError/.test(b.log.reason), 'reason: ' + b.log.reason);
  eq(b.after.to, {}, 'nothing created in the target');
  await ctx.close();
}, { core: true });

/* ---------- App ---------- */

test('start: clean darkroom page, one amber button, nothing to tap under 44 px', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    screen: window.filter.state.screen,
    pick: [document.querySelector('#btn-pick').textContent, document.querySelector('#btn-pick').classList.contains('btn-primary')],
    allow: document.querySelector('#btn-allow').hidden,
    status: document.querySelector('#status').textContent,
    small: [...document.querySelectorAll('button')].filter((b) => b.offsetParent && (b.offsetWidth < 44 || b.offsetHeight < 44)).map((b) => b.id || b.textContent),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  eq(r.bg, 'rgb(11, 11, 11)', 'stage colour');
  eq([r.screen, r.pick, r.allow, r.status], ['start', ['Pick a folder', true], true, 'no folder yet'], 'start screen');
  eq(r.small, [], 'tap targets under 44 px');
  eq(r.overflow, false, 'no sideways scroll at phone width');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('setup: picking the camera folder lists it and counts what is new', async () => {
  const { ctx, page } = await newApp();
  await openCamera(page);
  eq(await screen(page), 'setup', 'screen');
  const r = await rowsOf(page, '#setup-rows');
  assert(/^14 in [\d.]+ s$/.test(r.Entries), 'entries: ' + r.Entries);
  eq([r.Photos, r['Already sorted'], r['Not yet sorted']], ['10', '0', '10'], 'counts (videos, hidden files and text left out)');
  const st = await page.evaluate(() => [document.querySelector('#newest').value, document.querySelector('#btn-sort').disabled, document.querySelector('#status').textContent]);
  eq(st, ['10', false, 'folder ▸ Camera'], 'newest set to what is there, sort enabled');
  await ctx.close();
});

test('run and review: each photo lands in the right folder, grid per folder, other stays', async () => {
  const { ctx, page } = await newApp();
  await openCamera(page);
  await page.evaluate(() => {
    window.__calls = {};
    window.filter.recog.override = (e) => { window.__calls[e.name] = (window.__calls[e.name] || 0) + 1; return window.__answers[e.name] || {}; };
  });
  await sort(page);
  const calls = await page.evaluate(() => [window.__calls, window.filter.state.lastRun.closer]);
  const twice = Object.keys(calls[0]).filter((n) => calls[0][n] === 2).sort();
  eq(twice, ['PXL_20250101_120000000.jpg', 'PXL_20261029_100600000.jpg', 'PXL_20261029_100700000.jpg',
    'PXL_20261029_100800000.jpg', 'PXL_20261029_100900000.jpg', 'PXL_20261029_101000000.jpg'], 'closer look for everything not already people or a screenshot');
  eq([calls[0]['PXL_20261029_100200000.jpg'], calls[0]['Screenshot_20261029-100400.png'], calls[0]['IMG_20261029_100300.png'], calls[0]['PXL_20261029_100500000.jpg'], calls[1]],
    [1, 1, 1, 1, 6], 'people, screenshots and close-ups (a person filling the frame) skip it');
  eq(await screen(page), 'review', 'screen');
  eq(sortPlan(await plan(page)), sortPlan(EXPECTED_PLAN), 'plan');
  const r = await page.evaluate(() => ({
    heads: [...document.querySelectorAll('.group-head')].map((h) => h.textContent),
    thumbs: [...document.querySelectorAll('.ph img')].map((i) => i.src.slice(0, 5)),
    copy: [document.querySelector('#btn-copy').textContent, document.querySelector('#btn-copy').hidden],
    edge: document.querySelector('#bar-edge').textContent,
    reasons: Object.fromEntries(window.filter.state.plan.map((p) => [p.name, p.reason])),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  eq(r.heads, ['people ▸ 2', 'pets ▸ 2', 'food ▸ 1', 'screenshots ▸ 2', 'documents ▸ 1', 'scenery ▸ 1', 'other ▸ 1stay here, not copied'], 'groups in order');
  assert(r.thumbs.length === 10 && r.thumbs.every((s) => s === 'blob:'), 'a thumbnail for every photo');
  eq(r.copy, ['Copy 9', false], 'copy button');
  eq(r.edge, '10 photos ▸ 1 stay', 'film edge');
  eq(r.reasons['PXL_20261029_100900000.jpg'], 'golden retriever 0.40, pets 0.60', 'reason kept for the sheet');
  eq(r.reasons['IMG_20261029_100300.png'], 'screen-sized picture with no camera data', 'screenshot by shape');
  eq(r.reasons['PXL_20261029_100600000.jpg'], 'mostly text', 'text page found by the real text check');
  eq(r.reasons['PXL_20261029_101000000.jpg'], '3 people, 0.70 (closer look)', 'the classroom: people found by the closer look, not food from "restaurant"');
  eq(r.reasons['PXL_20261029_100500000.jpg'], 'nothing clear (best guess: hook 0.12; best person 0.89; a person fills the frame: a close-up, not counted)',
    'the hand close-up: a quarter-only face at 0.80, a frame-filling "person" and big pieces in the closer look are not people');
  eq(r.reasons['PXL_20250101_120000000.jpg'], 'cat 0.80 (seen)', 'a cat box');
  eq(r.reasons['PXL_20261029_100200000.jpg'], 'a person filling the frame, 0.94 (suit 0.60)', 'a tight portrait in a suit is people');
  eq(r.overflow, false, 'no sideways scroll');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('review: tapping a photo and choosing a folder sends it there, marked in amber', async () => {
  const { ctx, page } = await newApp();
  await openCamera(page);
  await sort(page);
  await page.click('.group[data-category="other"] .ph');
  const sheet = await page.evaluate(() => ({
    open: !document.querySelector('#sheet').hidden,
    name: document.querySelector('#sheet-name').textContent,
    why: document.querySelector('#sheet-why').textContent,
    pressed: [...document.querySelectorAll('#sheet-targets button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.category),
    targets: [...document.querySelectorAll('#sheet-targets button')].map((b) => b.textContent),
  }));
  eq([sheet.open, sheet.name, sheet.pressed], [true, 'PXL_20261029_100500000.jpg', ['other']], 'sheet');
  eq(sheet.why, 'filter said other: nothing clear (best guess: hook 0.12; best person 0.89; a person fills the frame: a close-up, not counted)', 'why');
  eq(sheet.targets, ['people', 'pets', 'food', 'screenshots', 'documents', 'scenery', 'other (stays)'], 'folders offered');
  await page.click('#sheet-targets button[data-category="food"]');
  const p = await plan(page);
  eq(p.food.slice().sort(), ['PXL_20261029_100500000.jpg', 'PXL_20261029_100800000.jpg'], 'moved to food');
  eq(p.other, undefined, 'other now empty');
  const r = await page.evaluate(() => ({ changed: document.querySelectorAll('.ph.changed').length, copy: document.querySelector('#btn-copy').textContent, sheet: document.querySelector('#sheet').hidden }));
  eq(r, { changed: 1, copy: 'Copy 10', sheet: true }, 'marked, counted, sheet closed');
  await page.click('.group[data-category="pets"] .ph');
  await page.click('#sheet-cancel');
  eq((await plan(page)).pets.length, 2, 'cancel changes nothing');
  await ctx.close();
});

test('copy: every copy lands in its folder byte-identical, originals untouched, log and run details written', async () => {
  const { ctx, page } = await newApp({ clipboard: true });
  await openCamera(page);
  const before = await camTree(page);
  await sort(page);
  await page.click('.group[data-category="pets"] .ph');   // send the newest pet photo to other
  await page.click('#sheet-targets button[data-category="other"]');
  await run(page, '#btn-copy');
  eq(await screen(page), 'done', 'screen');
  const after = await camTree(page);
  eq(onlyRoot(after), onlyRoot(before), 'the camera folder itself is exactly as before');
  const want = { ...EXPECTED_PLAN, pets: ['PXL_20250101_120000000.jpg'] };
  for (const [c, names] of Object.entries(want)) {
    if (c === 'other') continue;
    eq(filesIn(after, c), names.slice().sort(), c + '/ holds exactly its photos');
    for (const n of names) eq(after[c + '/' + n], before[n], c + '/' + n + ' is byte-identical');
  }
  assert(!Object.keys(after).some((k) => k.startsWith('other/')), 'no other/ folder: those photos stay');
  const logs = filesIn(after, 'filter-logs');
  assert(logs.length === 1 && /^run-\d{6}-\d{6}\.json$/.test(logs[0]), 'one log: ' + logs.join(', '));
  const log = await readLog(page, logs[0]);
  eq([log.app, log.version, log.mode, log.folder], ['filter', VERSION, 'copy', 'Camera'], 'log header');
  eq(log.result, { copied: 8, skipped: 0, stayed: 2, stopped: null }, 'log result');
  eq(log.items.length, 8, 'one line per copy');
  eq(log.decisions.length, 10, 'every decision logged, copied or not');
  eq(log.decisions.find((x) => x.name === 'PXL_20261029_100900000.jpg'), { name: 'PXL_20261029_100900000.jpg', folder: 'other', suggested: 'pets', reason: 'golden retriever 0.40, pets 0.60' }, 'a changed decision');
  for (const it of log.items) {
    eq([it.ok, it.sha256, it.copySha256, it.from], [true, before[it.name], before[it.name], '.'], it.name + ' logged with its hashes');
    assert(want[it.to].includes(it.name), it.name + ' logged in the right folder');
  }
  const d = await rowsOf(page, '#done-rows');
  eq(d.Copied, '8 of 8, each read back and checked (size and SHA-256)', 'done: copied');
  eq([d['Already there'], d.Stayed, d['You changed'], d.Log], ['0', '2 in other, not copied', '1 of 10', 'filter-logs/' + logs[0]], 'done rows');
  eq(await text(page, '#done-title'), 'Done', 'title');
  await page.click('#btn-details');
  await page.waitForSelector('#notice:not([hidden])');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const lines = clip.split('\n');
  assert(new RegExp('^filter v' + VERSION.replace(/\./g, '\\.') + ' run \\d\\d/\\d\\d/\\d\\d \\d{4} hrs, 10 photos, ').test(lines[0]), 'details header: ' + lines[0]);
  eq(lines.length, 11, 'a line per photo');
  assert(lines.includes('PXL_20261029_100900000.jpg ▸ other (filter said pets): golden retriever 0.40, pets 0.60'), 'changed photo line');
  assert(lines.includes('PXL_20261029_101000000.jpg ▸ people: 3 people, 0.70 (closer look)'), 'classroom line');
  assert(/, closer look for 6$/.test(lines[0]), 'closer look count in the header: ' + lines[0]);
  eq(await text(page, '#details-text'), clip, 'the same text on screen');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('run details can be copied from the review, before anything is copied', async () => {
  const { ctx, page } = await newApp({ clipboard: true });
  await openCamera(page);
  const before = await camTree(page);
  await sort(page);
  await page.click('.group[data-category="other"] .ph');
  await page.click('#sheet-targets button[data-category="food"]');
  await page.click('#btn-review-details');
  await page.waitForSelector('#notice:not([hidden])');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const lines = clip.split('\n');
  assert(/^filter v[\d.]+ run \d\d\/\d\d\/\d\d \d{4} hrs, 10 photos, /.test(lines[0]), 'header: ' + lines[0]);
  eq(lines.length, 11, 'a line per photo');
  assert(lines.includes('PXL_20261029_100500000.jpg ▸ food (filter said other): nothing clear (best guess: hook 0.12; best person 0.89; a person fills the frame: a close-up, not counted)'), 'the change shows');
  eq(await text(page, '#review-details-text'), clip, 'the same text on the review screen');
  eq(await camTree(page), before, 'nothing written');
  await ctx.close();
});

test('a re-check includes photos already sorted, copies nothing, and says where each already is', async () => {
  const { ctx, page } = await newApp({ clipboard: true });
  await openCamera(page);
  await sort(page, 3);
  await run(page, '#btn-copy');
  await run(page, '#btn-again');
  eq(await page.evaluate(() => [document.querySelector('#newest').value, document.querySelector('#btn-sort').textContent]), ['7', 'Sort photos'], 'a normal run counts the 7 not yet sorted');
  await page.check('#recheck');
  eq(await page.evaluate(() => [document.querySelector('#newest').value, document.querySelector('#btn-sort').textContent, document.querySelector('#btn-sort').disabled]),
    ['10', 'Re-check photos', false], 'a re-check counts all 10');
  const before = await camTree(page);
  await sort(page, 4);
  eq(Object.values(await plan(page)).flat().sort(), ['PXL_20261029_100700000.jpg', 'PXL_20261029_100800000.jpg', 'PXL_20261029_100900000.jpg', 'PXL_20261029_101000000.jpg'],
    'the 4 newest, the 3 copied ones included');
  const r = await page.evaluate(() => ({ copy: document.querySelector('#btn-copy').hidden, edge: document.querySelector('#bar-edge').textContent, cap: document.querySelector('#review-cap').textContent }));
  eq(r, { copy: true, edge: 're-check ▸ 4 photos ▸ nothing copied', cap: 'A re-check: nothing will be copied. Copy the run details to compare.' }, 'nothing can be copied');
  await page.click('#btn-review-details');
  await page.waitForSelector('#notice:not([hidden])');
  const lines = (await page.evaluate(() => navigator.clipboard.readText())).split('\n');
  assert(/^filter v[\d.]+ re-check /.test(lines[0]), 'marked as a re-check: ' + lines[0]);
  assert(lines.includes('PXL_20261029_101000000.jpg ▸ people: 3 people, 0.70 (closer look) [already in people]'), 'where it already is');
  assert(lines.includes('PXL_20261029_100700000.jpg ▸ scenery: seashore 0.30, scenery 0.40'), 'not yet sorted: no mark');
  eq(await camTree(page), before, 'nothing written by a re-check');
  await page.click('#btn-restart'); await page.click('#btn-restart');
  await page.uncheck('#recheck');
  eq(await page.evaluate(() => document.querySelector('#newest').value), '7', 'switch off: back to the photos not yet sorted');
  await ctx.close();
});

test('a second run skips what is already copied and takes the next newest', async () => {
  const { ctx, page } = await newApp();
  await openCamera(page);
  await sort(page, 3);
  eq(Object.values(await plan(page)).flat().sort(), ['PXL_20261029_100800000.jpg', 'PXL_20261029_100900000.jpg', 'PXL_20261029_101000000.jpg'], 'the 3 newest');
  await run(page, '#btn-copy');
  await run(page, '#btn-again');
  const r = await rowsOf(page, '#setup-rows');
  eq([r.Photos, r['Already sorted'], r['Not yet sorted']], ['10', '3', '7'], 'counts after the first run');
  await sort(page, 2);
  eq(Object.values(await plan(page)).flat().sort(), ['PXL_20261029_100600000.jpg', 'PXL_20261029_100700000.jpg'], 'the next 2 newest');
  await run(page, '#btn-copy');
  eq(filesIn(await camTree(page), 'filter-logs').length, 2, 'a log per run, none replaced');
  await ctx.close();
});

test('photos are decoded upright from their camera data', async () => {
  const { ctx, page } = await newApp();
  await page.evaluate(async () => {
    const fx = window.__fx, cam = await fx.dir('DCIM/Camera');
    window.__answers = {};
    const blue = await fx.picture(0, { w: 1600, h: 1200, flat: '#1030c0' });
    await fx.put(cam, 'PXL_20261029_120000000.jpg', await fx.withExif(blue, { orientation: 6 }));
    await fx.put(cam, 'PXL_20261029_110000000.jpg', await fx.withExif(blue, { orientation: 1 }));
    window.__pick = cam;
  });
  await run(page, '#btn-pick');
  await sort(page);
  const r = await page.evaluate(async () => {
    const out = {};
    for (const p of window.filter.state.plan) { const l = await window.__fx.look(p.thumb); out[p.name] = [l.w, l.h, l.centre[2] > 150]; }
    return out;
  });
  eq(r['PXL_20261029_120000000.jpg'], [150, 200, true], 'turned upright: portrait');
  eq(r['PXL_20261029_110000000.jpg'], [200, 150, true], 'left as it is');
  await ctx.close();
});

test('stop during recognition goes to review with the photos done so far', async () => {
  const { ctx, page } = await newApp();
  await page.evaluate(() => { window.filter.config.prefetch = 1; });
  await openCamera(page);
  await page.evaluate(() => {
    const seen = new Set();   // photos, not calls: the closer look asks the models again about the same photo
    window.filter.recog.override = (e) => { seen.add(e.name); if (seen.size === 3) window.filter.state.stopRequested = true; return window.__answers[e.name] || {}; };
  });
  await sort(page);
  eq(await screen(page), 'review', 'screen');
  eq(await page.evaluate(() => window.filter.state.plan.length), 3, 'three photos in the plan');
  await ctx.close();
});

test('models that fail to load send the run back to the folder, nothing changed', async () => {
  const { ctx, page } = await newApp();
  await openCamera(page);
  const before = await camTree(page);
  await page.evaluate(() => { window.filter.recog.load = () => Promise.reject(new Error('broken model')); });
  await sort(page);
  eq(await screen(page), 'setup', 'back on the folder screen');
  eq(await text(page, '#setup-note'), 'The models did not load: Error: broken model. Try again; nothing was changed.', 'says why');
  eq(await camTree(page), before, 'folder untouched');
  await ctx.close();
});

test('a bad copy stops the run: nothing after it is copied, the original is untouched, the log says why', async () => {
  const { ctx, page } = await newApp();
  await openCamera(page, { pets: 'flip' });
  const before = await camTree(page);
  await sort(page);
  await run(page, '#btn-copy');
  eq(await text(page, '#done-title'), 'Stopped', 'title');
  eq(await text(page, '#done-note'), 'Stopped at PXL_20261029_100900000.jpg (compare): SHA-256 differs. The original is untouched. The faulty copy is in the folder beside it; nothing was deleted.', 'note');
  const after = await camTree(page);
  eq(onlyRoot(after), onlyRoot(before), 'camera folder as before');
  eq(Object.keys(after).filter((k) => /^(people|food|scenery|documents|screenshots)\/./.test(k)), ['people/PXL_20261029_101000000.jpg'], 'only the photo before the failure was copied');
  assert(after['pets/PXL_20261029_100900000.jpg'] && after['pets/PXL_20261029_100900000.jpg'] !== before['PXL_20261029_100900000.jpg'], 'the bad copy is there, different bytes');
  eq((await rowsOf(page, '#done-rows')).Copied, '1 of 9, each read back and checked (size and SHA-256)', 'copied count');
  const log = await readLog(page, filesIn(after, 'filter-logs')[0]);
  eq(log.result.stopped, 'PXL_20261029_100900000.jpg: SHA-256 differs', 'log says why');
  eq(log.items.map((i) => [i.name, i.ok]), [['PXL_20261029_101000000.jpg', true], ['PXL_20261029_100900000.jpg', false]], 'log lines');
  await ctx.close();
});

test('reopen: after a restart one tap on Allow brings the folder back', async () => {
  const { ctx, page } = await newApp({ persistent: true });
  await openCamera(page);
  await page.evaluate(() => localStorage.setItem('__askOnReopen', '1'));
  await page.reload(); await ready(page);
  const r = await page.evaluate(() => ({
    screen: window.filter.state.screen,
    allow: [document.querySelector('#btn-allow').hidden, document.querySelector('#btn-allow').textContent],
    pick: [document.querySelector('#btn-pick').textContent, document.querySelector('#btn-pick').classList.contains('btn-primary')],
    note: document.querySelector('#start-note').textContent,
    status: document.querySelector('#status').textContent,
  }));
  eq(r, { screen: 'start', allow: [false, 'Allow access to Camera'], pick: ['Pick another folder', false],
    note: 'Chrome asks again after every restart. One tap on Allow brings Camera back.', status: 'access needed' }, 'start screen asks once');
  await run(page, '#btn-allow');
  eq(await screen(page), 'setup', 'straight to the folder');
  eq((await rowsOf(page, '#setup-rows')).Photos, '10', 'folder read');
  await ctx.close();
});

test('reopen: when access is still there, the app opens straight on the folder', async () => {
  const { ctx, page } = await newApp({ persistent: true });
  await openCamera(page);
  await page.reload(); await ready(page);
  eq(await screen(page), 'setup', 'no tap needed');
  eq((await rowsOf(page, '#setup-rows')).Photos, '10', 'folder read');
  await ctx.close();
});

test('closing the picker changes nothing; no picker at all says so', async () => {
  const { ctx, page } = await newApp();
  await run(page, '#btn-pick');
  eq([await screen(page), await text(page, '#start-note')], ['start', ''], 'picker closed');
  await page.evaluate(() => localStorage.setItem('__noPicker', '1'));
  await page.reload(); await ready(page);
  await run(page, '#btn-pick');
  eq(await text(page, '#start-note'), 'This browser cannot open folders. Use Chrome on Android.', 'no picker');
  await ctx.close();
});

test('start over needs two taps', async () => {
  const { ctx, page } = await newApp();
  await openCamera(page);
  await sort(page, 2);
  await page.click('#btn-restart');
  eq([await screen(page), await text(page, '#btn-restart')], ['review', 'Sure?'], 'one tap asks');
  await page.click('#btn-restart');
  eq([await screen(page), await page.evaluate(() => window.filter.state.plan.length)], ['setup', 0], 'two taps start over');
  await ctx.close();
});

test('real models: the classifier, face detector and object detector run offline on synthetic photos', async () => {
  const { ctx, page } = await newApp({ models: 'real' });
  await page.evaluate(async () => {
    const fx = window.__fx, cam = await fx.dir('DCIM/Camera');
    await fx.put(cam, 'PXL_20261029_120000000.jpg', await fx.withExif(await fx.picture(2, { w: 1600, h: 1200 }), { thumb: await fx.picture(2, { w: 320, h: 240 }) }));
    await fx.put(cam, 'PXL_20261029_110000000.jpg', await fx.withExif(await fx.picture(5, { w: 900, h: 1200 })));
    window.__pick = cam;
  });
  await run(page, '#btn-pick');
  await sort(page);
  eq(await screen(page), 'review', 'screen');
  const r = await page.evaluate(() => window.filter.state.plan.map((p) => [p.category, p.reason, !!p.thumb]));
  eq(r.length, 2, 'both photos');
  for (const [c, reason, thumb] of r) assert(c && reason.length > 5 && thumb, 'recognised: ' + c + ', ' + reason);
  console.log('      real models on synthetic shapes: ' + r.map((x) => x[0] + ' (' + x[1] + ')').join('; '));
  const real = page.errors.filter((e) => e !== 'INFO: Created TensorFlow Lite XNNPACK delegate for CPU.');
  assert(real.length === 0, real.join('; '));
  await ctx.close();
});

test('offline: the service worker caches the app, MediaPipe and the three models', async () => {
  const { ctx, page } = await newApp({ sw: true });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async (version) => {
    const keys = await caches.keys();
    if (!keys.includes('filter-v' + version)) return false;
    const v = keys.find((k) => k.startsWith('filter-mediapipe-'));
    return v && (await (await caches.open(v)).keys()).length === 6;
  }, VERSION, { timeout: 60000, polling: 250 });
  await ctx.setOffline(true);
  await page.reload(); await ready(page);
  const r = await page.evaluate(async () => {
    const font = await document.fonts.load('600 14px "Barlow Semi Condensed"');
    return { title: document.title, font: font.length,
      models: await Promise.all(['efficientnet_lite0', 'blaze_face_short_range', 'efficientdet_lite0'].map(async (m) => !!(await caches.match('vendor/mediapipe/' + m + '.tflite')))) };
  });
  eq(r, { title: 'filter', font: 1, models: [true, true, true] }, 'offline page, font and the three models');
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
