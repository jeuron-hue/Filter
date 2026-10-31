#!/usr/bin/env bash
# filter_mutate.sh: mutation run over the core functions: folder reading, choosing
# the newest photos and videos, reading photo headers, the sorting rules, comparing
# photos with Gary's examples (F2), a video's frames and their vote (F3), the
# SHA-256, the safe copy and the safe move, and undo's rules (F4).
#
# The idea: plant one small, deliberate bug (a "mutant") in the CORE block of
# filter.html, run the core behaviour tests against it, and expect them to
# fail. A mutant the tests do not notice has "survived", which means the
# tests are too loose and need tightening. Every mutant should be killed.
# For the safe copy and move this matters most: each "copy:", "move:", "remove:",
# "gone:", "undo:" and "drop:" mutant is a way a file could be overwritten,
# passed off damaged, or lost, and the tests must catch every one.
#
# Each line below is: name ||| exact text in CORE ||| replacement.
# The text must appear exactly once between "// CORE:BEGIN" and "// CORE:END".
#
# Run: bash filter_mutate.sh          (a few minutes)
#      JOBS=4 bash filter_mutate.sh   (run four mutants at a time)

set -u
cd "$(dirname "$0")"
JOBS="${JOBS:-2}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MUTANTS=$(cat <<'EOF'
kind: hidden files counted as photos ||| if (name.startsWith('.')) return 'hidden'; ||| if (name.startsWith('..')) return 'hidden';
kind: capital extensions missed ||| const ext = m ? m[1].toLowerCase() : ''; ||| const ext = m ? m[1] : '';
kind: extension read from the start ||| const m = /\.([a-z0-9]+)$/i.exec(name); ||| const m = /\.([a-z0-9]+)/i.exec(name);
kind: videos counted as photos ||| if (core.VIDEO_EXT.includes(ext)) return 'video'; ||| if (core.VIDEO_EXT.includes(ext)) return 'photo';
kind: HEIC not a photo ||| core.PHOTO_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic', ||| core.PHOTO_EXT = ['jpg', 'jpeg', 'png', 'webp',
stall: a stall looks like the end ||| const timer = setTimeout(() => resolve({ stalled: true }), stallMs); ||| const timer = setTimeout(() => resolve({ done: true }), stallMs);
stall: timer ten times too long ||| const timer = setTimeout(() => resolve({ stalled: true }), stallMs); ||| const timer = setTimeout(() => resolve({ stalled: true }), stallMs * 10);
stall: listing errors swallowed ||| (e) => { clearTimeout(timer); reject(e); }); ||| (e) => { clearTimeout(timer); resolve({ done: true }); });
batch: one entry too many ||| while (b.entries.length < limit) { ||| while (b.entries.length <= limit) {
batch: stall ignored ||| if (r.stalled) { b.stalled = true; break; } ||| if (r.stalled) { break; }
batch: end not marked ||| if (r.done) { b.done = true; break; } ||| if (r.done) { break; }
batch: first-entry time keeps moving ||| if (b.firstMs === null) b.firstMs = now() - t0; ||| b.firstMs = now() - t0;
batch: folders counted by name ||| const kind = h.kind === 'directory' ? 'folder' : core.kindOf(h.name); ||| const kind = core.kindOf(h.name);
hash: hex digits not padded ||| x.toString(16).padStart(2, '0') ||| x.toString(16)
hash: SHA-1 instead of SHA-256 ||| crypto.subtle.digest('SHA-256', ||| crypto.subtle.digest('SHA-1',
exists: missing counts as there ||| if (e && e.name === 'NotFoundError') return false; ||| if (e && e.name === 'NotFoundError') return true;
exists: a folder of that name ignored ||| if (e && e.name === 'TypeMismatchError') return true; ||| if (e && e.name === 'TypeMismatchError') return false;
date: month not checked ||| if (!m || +m[2] < 1 || +m[2] > 12 || ||| if (!m ||
date: day not checked ||| || +m[3] < 1 || +m[3] > 31) return null; ||| ) return null;
date: separator required ||| /(20\d\d)(\d\d)(\d\d)[_-]?(\d\d)(\d\d)(\d\d)/ ||| /(20\d\d)(\d\d)(\d\d)[_-](\d\d)(\d\d)(\d\d)/
pick: sorted photos not skipped ||| const fresh = photos.filter((p) => !sorted.has(p.name)); ||| const fresh = photos.slice();
pick: oldest first ||| return ka < kb ? 1 : -1; ||| return ka < kb ? -1 : 1;
pick: undated first ||| if (ka === null) return 1; ||| if (ka === null) return -1;
pick: one too many ||| fresh.slice(0, Math.max(0, n)) ||| fresh.slice(0, Math.max(0, n + 1))
pick: same time not ordered by name ||| return a.name < b.name ? 1 : a.name > b.name ? -1 : 0; ||| return 0;
info: PNG height read as width ||| info.height = u32(20); ||| info.height = u32(16);
info: JPEG width and height swapped ||| info.height = u16(i + 5); info.width = u16(i + 7); ||| info.height = u16(i + 7); info.width = u16(i + 5);
info: fill bytes stop the reading ||| if (m === 0xFF) { i++; continue; } ||| if (m === 0xFF) break;
info: camera data never read ||| if (m === 0xE1 && ascii(i + 4, 6) === 'Exif\0\0') core.readExif ||| if (false) core.readExif
info: segment length ignored ||| i += 2 + len; ||| i += 2;
exif: byte order ignored ||| const le = b[t] === 0x49 && b[t + 1] === 0x49; ||| const le = false;
exif: magic number not checked ||| if (!inside(t, 8) || u16(t + 2) !== 42) return; ||| if (!inside(t, 8)) return;
exif: model read as the make ||| else if (tag === 0x0110) info.model = text(e); ||| else if (tag === 0x0110) info.make = text(e);
exif: orientation out of range kept ||| if (o >= 1 && o <= 8) info.orientation = o; ||| info.orientation = o;
exif: short strings read from an offset ||| at = n <= 4 ? e + 8 : t + u32(e + 8) ||| at = t + u32(e + 8)
exif: preview offset not from the TIFF start ||| if (u16(e) === 0x0201) start = t + u32(e + 8); ||| if (u16(e) === 0x0201) start = u32(e + 8);
exif: next IFD from the wrong place ||| const next = ifd0 + 2 + n0 * 12; ||| const next = ifd0 + n0 * 12;
exif: preview past the end accepted ||| if (start !== null && length > 0 && inside(start, length)) ||| if (start !== null && length > 0)
tiles: corners too small ||| core.tiles = (w, h, k = 0.6) => { ||| core.tiles = (w, h, k = 0.5) => {
tiles: right corner at the left ||| { x: w - tw, y: 0, w: tw, h: th } ||| { x: 0, y: 0, w: tw, h: th }
faces: confidence ignored ||| if (d.score < min || size < rules.faceSize) continue; ||| if (size < rules.faceSize) continue;
faces: size ignored ||| if (d.score < min || size < rules.faceSize) continue; ||| if (d.score < min) continue;
faces: confidence edge excluded ||| if (d.score < min || ||| if (d.score <= min ||
faces: a quarter as easy as the whole ||| const min = run.full ? rules.faceScore : rules.faceScoreTile; ||| const min = rules.faceScore;
faces: the whole as hard as a quarter ||| const min = run.full ? rules.faceScore : rules.faceScoreTile; ||| const min = rules.faceScoreTile;
objects: confidence ignored ||| if (d.score < rules.objectScore || area < rules.objectArea) continue; ||| if (area < rules.objectArea) continue;
objects: size ignored ||| if (d.score < rules.objectScore || area < rules.objectArea) continue; ||| if (d.score < rules.objectScore) continue;
objects: biggest not kept ||| o.area = Math.max(o.area, area); ||| o.area = area;
objects: best not kept ||| if (d.score > o.score) { o.score = d.score; o.name = d.name; } ||| { o.score = d.score; o.name = d.name; }
objects: every label in every group ||| if (!groups[g].includes(d.name)) continue; ||| /* removed */
faces: height not measured ||| const size = Math.max(d.w / W, d.h / H); ||| const size = d.w / W;
faces: counted twice across looks ||| out.count = Math.max(out.count, n); ||| out.count += n;
text: colour not checked ||| m.sat <= rules.satMax && m.edges >= rules.edgeMin; ||| m.edges >= rules.edgeMin;
text: too much dark allowed ||| m.dark <= rules.darkMax && ||| true &&
text: edges not needed ||| m.sat <= rules.satMax && m.edges >= rules.edgeMin; ||| m.sat <= rules.satMax;
text: brightness not needed ||| m.isText = m.bright >= rules.bright && ||| m.isText =
rules: screenshot name ignored ||| if (/^screenshot/i.test(p.name)) return ||| if (false) return
rules: any picture can be a screenshot ||| if (p.format === 'png' && !p.make && p.width && p.height) { ||| if (!p.make && p.width && p.height) {
rules: camera data ignored ||| if (p.format === 'png' && !p.make && p.width && p.height) { ||| if (p.format === 'png' && p.width && p.height) {
rules: small screens accepted ||| if (long >= rules.screenLong && ||| if (
rules: wide pictures accepted ||| short / long >= rules.screenRatio[0] ||| short / long >= 0
rules: square pictures accepted ||| short / long <= rules.screenRatio[1] ||| short / long <= 1
rules: faces ignored ||| if (p.faces && p.faces.count > 0) { ||| if (false) {
rules: person boxes ignored ||| if (pp && (pp.count >= rules.peopleCount || ||| if (pp && (false ||
rules: one person box enough ||| pp.count >= rules.peopleCount ||| pp.count >= 1
rules: one small person enough ||| (pp.area >= rules.personArea && pp.score >= rules.personScore) ||| (pp.score >= rules.personScore)
rules: one unsure person enough ||| (pp.area >= rules.personArea && pp.score >= rules.personScore) ||| (pp.area >= rules.personArea)
rules: seen pets and food ignored ||| if (o && o.count && o.score >= rules.thingScore && o.area >= rules.thingArea) return ||| if (false) return
rules: unsure things accepted ||| o.count && o.score >= rules.thingScore && ||| o.count &&
rules: small things accepted ||| o.area >= rules.thingArea) return ||| true) return
rules: food before pets ||| for (const g of ['pets', 'food']) { ||| for (const g of ['food', 'pets']) {
grid: parts not spread to the edge ||| x: n > 1 ? Math.round(i * (w - tw) / (n - 1)) : 0 ||| x: n > 1 ? Math.round(i * w / n) : 0
grid: rows spread by the width ||| y: n > 1 ? Math.round(j * (h - th) / (n - 1)) : 0 ||| y: n > 1 ? Math.round(j * (w - tw) / (n - 1)) : 0
grid: part size ignores k ||| const tw = Math.round(w * k), th = Math.round(h * k), out = []; ||| const tw = Math.round(w / n), th = Math.round(h / n), out = [];
objects: best of any box not tracked ||| if (groups[g].includes(d.name)) out[g].best = Math.max(out[g].best, d.score); ||| if (groups[g].includes(d.name)) out[g].best = 0;
hash: big files hashed whole ||| if (blob.size <= whole) return ||| if (true) return
hash: a piece skipped ||| at < blob.size; at += piece) ||| at < blob.size; at += piece + 1)
hash: the leftover of a piece dropped ||| used = data.length - i; ||| used = 0;
hash: a part-filled block joined wrong ||| buf.set(data.subarray(0, i), used); ||| buf.set(data.subarray(0, i), 0);
hash: end marker in the wrong place ||| tail[used] = 0x80; ||| tail[used + 1] = 0x80;
hash: no room left for the length ||| used < 56 ? 64 : 128 ||| used <= 56 ? 64 : 128
hash: length in bytes, not bits ||| bits = total * 8; ||| bits = total;
hash: a round constant wrong ||| core.SHA_K = [0x428a2f98, ||| core.SHA_K = [0x428a2f99,
hash: a rotation wrong ||| ((e >>> 6) | (e << 26)) ||| ((e >>> 6) | (e << 25))
hash: schedule added without carry ||| W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0; ||| W[i] = (W[i - 16] ^ s0 ^ W[i - 7] ^ s1) | 0;
hash: a word's bytes in the wrong order ||| (lo >>> (24 - 8 * k)) & 255 ||| (lo >>> (8 * k)) & 255
frames: times not scaled by the length ||| at.map((k) => k * duration) ||| at.map((k) => k)
frames: an endless video accepted ||| Number.isFinite(duration) && duration > 0 ? ||| duration > 0 ?
vote: frames that see nothing vote too ||| for (const f of frames) if (f.category !== stay) n[f.category] ||| for (const f of frames) n[f.category]
vote: a tie goes to the first ||| if (ranked.length > 1 && n[ranked[1]] === n[ranked[0]]) return ||| if (false) return
vote: nothing seen not caught ||| if (!ranked.length) return { category: stay, ||| if (false) return { category: stay,
vote: reason from the wrong frame ||| frames.find((f) => f.category === top).reason ||| frames[0].reason
vote: disagreeing frames go to the first ||| return { category: stay, reason: 'frames disagree: ' ||| return { category: frames[0].category, reason: 'frames disagree: '
mean: first frame only ||| for (const v of vecs) for ||| for (const v of vecs.slice(0, 1)) for
mean: summed, not averaged ||| m[i] += v[i] / vecs.length; ||| m[i] += v[i];
rules: best person left out of other ||| if (ob.people && ob.people.best) notes.push ||| if (false) notes.push
objects: area from the width alone ||| const area = d.w * d.h; ||| const area = d.w;
norm: part corner ignored ||| x: (d.x + ox) / W, y: (d.y + oy) / H, ||| x: d.x / W, y: d.y / H,
norm: height measured by the width ||| w: d.w / W, h: d.h / H })); ||| w: d.w / W, h: d.h / W }));
dedupe: nothing merged ||| if (!same) kept.push(b); ||| kept.push(b);
dedupe: different labels merged ||| if (k.name !== b.name) return false; ||| if (false) return false;
dedupe: least sure kept ||| boxes.slice().sort((p, q) => q.score - p.score) ||| boxes.slice().sort((p, q) => p.score - q.score)
dedupe: overlap measure off ||| inter / (ka + ba - inter) >= rules.sameBox ||| inter / (ka + ba) >= rules.sameBox
dedupe: cut boxes kept apart ||| || inter / Math.min(ka, ba) >= rules.sameInside; ||| ;
dedupe: rows ignored ||| const ih = Math.min(k.y + k.h, b.y + b.h) - Math.max(k.y, b.y); ||| const ih = 1;
objects: frame-filling people counted ||| if (g === 'people' && d.w >= rules.fillFrame && d.h >= rules.fillFrame) { o.filled++; ||| if (false) { o.filled++;
objects: filling either way is enough ||| d.w >= rules.fillFrame && d.h >= rules.fillFrame ||| (d.w >= rules.fillFrame || d.h >= rules.fillFrame)
objects: frame filling applies to cats too ||| if (g === 'people' && d.w ||| if (d.w
closer: big people added ||| groups.people.includes(b.name) && b.w * b.h <= rules.closeMaxArea ||| groups.people.includes(b.name)
closer: everything added ||| boxes.filter((b) => groups.people.includes(b.name) && ||| boxes.filter((b) =>
closer: size edge excluded ||| b.w * b.h <= rules.closeMaxArea ||| b.w * b.h < rules.closeMaxArea
rules: close-up not said ||| if (ob.people && ob.people.filled) notes.push ||| if (false) notes.push
portrait: clothes ignored ||| if (worn.length && sum >= rules.clothesMin) { ||| if (false) {
portrait: any clothes enough ||| if (worn.length && sum >= rules.clothesMin) { ||| if (worn.length) {
portrait: unsure person enough ||| if (pp && pp.filled && pp.fillScore >= rules.personScore) { ||| if (pp && pp.filled) {
portrait: every label is clothes ||| const worn = top.filter((l) => core.inGroup(l.index, clothes)); ||| const worn = top;
portrait: fill score not kept ||| o.fillScore = Math.max(o.fillScore, d.score); ||| o.fillScore = 0;
rules: text ignored ||| if (p.text) return { category: 'documents' ||| if (false) return { category: 'documents'
rules: all labels counted ||| const top = (p.labels || []).slice(0, rules.topLabels); ||| const top = (p.labels || []);
rules: first group wins ||| if (mine.length && (!best || sum > best.sum)) ||| if (mine.length && !best)
rules: threshold ignored ||| if (best && best.sum >= rules.labelMin) { ||| if (best) {
rules: range end excluded ||| ranges.some(([a, z]) => index >= a && index <= z) ||| ranges.some(([a, z]) => index >= a && index < z)
ahead: no limit ||| while (next < items.length && pending.length < depth) { ||| while (next < items.length && pending.length < depth + 5) {
ahead: stop ignored ||| if ((await each(r, i)) === false) break; ||| await each(r, i);
ahead: no refill ||| const r = await pending.shift();\n    fill(); ||| const r = await pending.shift();
copy: listed names ignored ||| if ((opts.existing && opts.existing.has(name)) || ||| if (false ||
copy: no lookup in the target ||| || await core.exists(toDir, name)) { ||| ) {
copy: reads back the original ||| const copy = await dst.getFile(); ||| const copy = await src.getFile();
copy: hashes the original twice ||| log.copySha256 = await core.sha256(copy, ||| log.copySha256 = await core.sha256(orig,
copy: size check skipped ||| if (copy.size !== orig.size) { log.reason ||| if (false) { log.reason
copy: hash check skipped ||| if (log.copySha256 !== log.sha256) { log.reason = 'SHA-256 differs'; return log; } ||| if (false) { log.reason = 'SHA-256 differs'; return log; }
copy: mismatch carries on ||| log.reason = 'SHA-256 differs'; return log; } ||| log.reason = 'SHA-256 differs'; }
copy: failed write not reported ||| try { await w.abort(); } catch (_) { /* already closed */ }\n      throw e; ||| try { await w.abort(); } catch (_) { /* already closed */ }
copy: skip not marked ||| log.skipped = true; ||| log.skipped = false;
copy: copy not marked as made ||| log.copyMade = true; ||| log.copyMade = false;
copy: steps not reported ||| const at = (s) => { log.step = s; if (opts.onStep) opts.onStep(s); }; ||| const at = (s) => { log.step = s; };
copy: ok before the compare ||| at('compare'); ||| at('compare'); log.ok = true;
move: a copy deletes too ||| if (opts.from) { ||| if (true) {
move: original not checked again ||| if (again.size !== log.size || again.lastModified !== log.modified) { log.reason = 'the original changed during the copy'; return log; } ||| /* not checked */
move: a change of time ignored ||| again.size !== log.size || again.lastModified !== log.modified ||| again.size !== log.size
move: never deletes ||| log.deletedBy = await core.removeFile(src, opts.from, name); ||| log.deletedBy = 'handle';
move: not marked as moved ||| log.moved = true; ||| log.moved = false;
remove: own handle never used ||| if (typeof h.remove === 'function') { ||| if (false) {
remove: any refusal deletes by name ||| if (!(e instanceof TypeError || (e && e.name === 'NotSupportedError'))) throw e; ||| /* any refusal */
remove: no handle support not a fallback ||| e instanceof TypeError || ||| false ||
remove: says handle when by name ||| return 'name'; ||| return 'handle';
list: stall not reported ||| if (b.stalled) return { names, stalled: true }; ||| if (b.stalled) return { names, stalled: false };
list: first batch only ||| if (b.done) return { names, stalled: false }; ||| return { names, stalled: false };
gone: every name counted as still there ||| deleted.filter((n) => listed.has(n)) ||| deleted.slice()
gone: none counted as still there ||| deleted.filter((n) => listed.has(n)) ||| []
undo: skipped files taken back ||| (it.copyMade || it.ok) && ||| true &&
undo: logs before F4 left out ||| (it.copyMade || it.ok) && ||| (it.copyMade) &&
undo: no folder named ||| typeof it.to === 'string' && it.to && ||| true &&
undo: a path accepted ||| !/[/\\]/.test(it.to) && ||| true &&
undo: filter's own folders reached ||| && !core.exampleProblem(it.to) ||| && true
undo: a copy beside its original moved back ||| (inSub ? (atRoot ? 'drop copy' : 'move back') ||| (inSub ? (atRoot ? 'move back' : 'move back')
undo: a lone copy dropped ||| (inSub ? (atRoot ? 'drop copy' : 'move back') ||| (inSub ? (atRoot ? 'drop copy' : 'drop copy')
undo: missing called nothing ||| (atRoot ? 'nothing' : 'missing') ||| (atRoot ? 'nothing' : 'nothing')
drop: size not compared ||| if (c.size !== o.size) { log.differs = true; ||| if (false) { log.differs = true;
drop: hash not compared ||| if (log.copySha256 !== log.sha256) { log.differs = true; ||| if (false) { log.differs = true;
drop: the original hashed twice ||| log.copySha256 = await core.sha256(c, ||| log.copySha256 = await core.sha256(o,
drop: deletes the original ||| log.deletedBy = await core.removeFile(copyH, copyDir, name); ||| log.deletedBy = await core.removeFile(origH, copyDir, name);
drop: a difference not marked ||| log.differs = true; log.reason = 'the copy differs from the original (SHA-256) ||| log.reason = 'the copy differs from the original (SHA-256)
drop: removal not marked ||| log.removed = true; ||| log.removed = false;
newest: same-second number ignored ||| (k[0] === key[0] && k[1] > key[1]) ||| false
newest: number compared as text ||| const k = [m[1], m[2] ? +m[2] : 1]; ||| const k = [m[1], m[2] ? m[2] : 1];
newest: oldest wins ||| if (!key || k[0] > key[0] || ||| if (!key || k[0] < key[0] ||
newest: kind of log ignored ||| new RegExp('^' + prefix + ||| new RegExp('^' + 'run-' +
cosine: second list's size ignored ||| return na && nb ? dot / Math.sqrt(na * nb) : 0; ||| return na && nb ? dot / Math.sqrt(na * na) : 0;
cosine: no square root ||| dot / Math.sqrt(na * nb) ||| dot / (na * nb)
cosine: all-zero list gives nonsense ||| return na && nb ? dot / Math.sqrt(na * nb) : 0; ||| return dot / Math.sqrt(na * nb);
nearest: first example only ||| if (!top || score > top.score) top = ||| if (!top) top =
nearest: weakest example counts ||| if (!top || score > top.score) top = ||| if (!top || score < top.score) top =
nearest: worst folder first ||| scores.sort((p, q) => q.score - p.score); ||| scores.sort((p, q) => p.score - q.score);
nearest: runner-up from the wrong end ||| next = scores[1] || null ||| next = scores[scores.length - 1] || null
nearest: folder with no examples counted ||| if (top) scores.push(top); ||| scores.push(top);
nearest: like nothing accepted ||| if (best.score < rules.minSim) return ||| if (false) return
nearest: bar edge excluded ||| if (best.score < rules.minSim) return ||| if (best.score <= rules.minSim) return
nearest: torn accepted ||| if (next && best.score - next.score < rules.minGap) return ||| if (false) return
nearest: gap edge excluded ||| best.score - next.score < rules.minGap ||| best.score - next.score <= rules.minGap
nearest: one folder alone fails ||| if (next && best.score - next.score ||| if (best.score - next.score
example name: hidden folders allowed ||| if (name[0] === '.') return 'hidden'; ||| if (false) return 'hidden';
example name: case matters ||| RESERVED.includes(name.toLowerCase()) ||| RESERVED.includes(name)
order: most sure first ||| (a.score == null ? -2 : a.score) - (b.score == null ? -2 : b.score) ||| (b.score == null ? -2 : b.score) - (a.score == null ? -2 : a.score)
order: no score last ||| (a.score == null ? -2 : a.score) - (b.score == null ? -2 : b.score) ||| (a.score == null ? 2 : a.score) - (b.score == null ? 2 : b.score)
order: the given list sorted in place ||| core.leastSureFirst = (items) => items.slice().sort( ||| core.leastSureFirst = (items) => items.sort(
EOF
)

# Build one mutant file. Exit 3 if the pattern is not found exactly once.
# "\n" in a pattern stands for a line break plus the indentation that follows.
make_mutant() {
  node -e '
    const fs = require("fs");
    const [src, out, from, to] = process.argv.slice(1);
    const s = fs.readFileSync(src, "utf8");
    const a = s.indexOf("// CORE:BEGIN"), b = s.indexOf("// CORE:END");
    if (a < 0 || b < 0) { console.error("CORE markers missing"); process.exit(3); }
    const core = s.slice(a, b);
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\n\s*/g, "\\n\\s*");
    const re = new RegExp(esc(from), "g");
    const n = (core.match(re) || []).length;
    if (n !== 1) { console.error("pattern found " + n + " times in CORE: " + from); process.exit(3); }
    const indent = (core.match(new RegExp(esc(from))) [0].match(/\n(\s*)/) || ["", ""])[1];
    fs.writeFileSync(out, s.slice(0, a) + core.replace(re, () => to.replace(/\\n/g, "\n" + indent)) + s.slice(b));
  ' filter.html "$1" "$2" "$3"
}

run_one() {
  local idx="$1" line="$2"
  local name="${line%% ||| *}" rest="${line#* ||| }"
  local from="${rest%% ||| *}" to="${rest#* ||| }"
  local dir="$WORK/$idx"; mkdir -p "$dir"
  if ! make_mutant "$dir/filter.html" "$from" "$to" 2>"$dir/err"; then
    echo "BROKEN   $name: $(cat "$dir/err")"; return
  fi
  if FILTER_HTML="$dir/filter.html" FILTER_ONLY=core timeout 300 node filter_behave.cjs >"$dir/log" 2>&1; then
    echo "SURVIVED $name"
  else
    echo "KILLED   $name"
  fi
}
export -f run_one make_mutant
export WORK

echo "Baseline: core tests on the unmodified file"
if ! FILTER_ONLY=core node filter_behave.cjs >"$WORK/baseline" 2>&1; then
  cat "$WORK/baseline"; echo "Baseline fails; fix the suite before mutating."; exit 1
fi

total=$(printf '%s\n' "$MUTANTS" | grep -c '|||')
echo "Running $total mutants, $JOBS at a time"
RESULTS="$WORK/results"
i=0
printf '%s\n' "$MUTANTS" | while IFS= read -r line; do
  [ -z "$line" ] && continue
  i=$((i + 1))
  printf '%s\0%s\0' "$i" "$line"
done | xargs -0 -n 2 -P "$JOBS" bash -c 'run_one "$0" "$1"' | tee "$RESULTS"

killed=$(grep -c '^KILLED' "$RESULTS")
survived=$(grep -c '^SURVIVED' "$RESULTS")
broken=$(grep -c '^BROKEN' "$RESULTS")
echo
echo "filter_mutate: $killed killed, $survived survived, $broken broken (of $total)"
[ "$survived" -eq 0 ] && [ "$broken" -eq 0 ]
