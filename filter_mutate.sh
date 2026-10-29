#!/usr/bin/env bash
# filter_mutate.sh: mutation run over the core folder-reading and file-safety functions.
#
# The idea: plant one small, deliberate bug (a "mutant") in the CORE block of
# filter.html, run the core behaviour tests against it, and expect them to
# fail. A mutant the tests do not notice has "survived", which means the
# tests are too loose and need tightening. Every mutant should be killed.
# For the safe move this matters most: each mutant below is a way a move could
# lose or damage a file, and the tests must catch every one.
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
kind: MOV not a video ||| core.VIDEO_EXT = ['mp4', 'mov', ||| core.VIDEO_EXT = ['mp4',
stall: a stall looks like the end ||| const timer = setTimeout(() => resolve({ stalled: true }), stallMs); ||| const timer = setTimeout(() => resolve({ done: true }), stallMs);
stall: timer ten times too long ||| const timer = setTimeout(() => resolve({ stalled: true }), stallMs); ||| const timer = setTimeout(() => resolve({ stalled: true }), stallMs * 10);
stall: listing errors swallowed ||| (e) => { clearTimeout(timer); reject(e); }); ||| (e) => { clearTimeout(timer); resolve({ done: true }); });
batch: one entry too many ||| while (b.entries.length < limit) { ||| while (b.entries.length <= limit) {
batch: stall ignored ||| if (r.stalled) { b.stalled = true; break; } ||| if (r.stalled) { break; }
batch: end not marked ||| if (r.done) { b.done = true; break; } ||| if (r.done) { break; }
batch: first-entry time keeps moving ||| if (b.firstMs === null) b.firstMs = now() - t0; ||| b.firstMs = now() - t0;
batch: folders counted by name ||| const kind = h.kind === 'directory' ? 'folder' : core.kindOf(h.name); ||| const kind = core.kindOf(h.name);
batch: batch time from the first entry ||| b.ms = now() - t0; ||| b.ms = now() - t0 - (b.firstMs || 0);
hash: hex digits not padded ||| x.toString(16).padStart(2, '0') ||| x.toString(16)
hash: SHA-1 instead of SHA-256 ||| crypto.subtle.digest('SHA-256', ||| crypto.subtle.digest('SHA-1',
exists: missing counts as there ||| if (e && e.name === 'NotFoundError') return false; ||| if (e && e.name === 'NotFoundError') return true;
exists: a folder of that name ignored ||| if (e && e.name === 'TypeMismatchError') return true; ||| if (e && e.name === 'TypeMismatchError') return false;
move: overwrites the target ||| if (await core.exists(toDir, name)) { log.reason ||| if (false) { log.reason
move: forced bad copy ignored ||| await w.write(opts.alterCopy ? await opts.alterCopy(orig) : orig); ||| await w.write(orig);
move: reads back the original, not the copy ||| const copy = await (await toDir.getFileHandle(name)).getFile(); ||| const copy = await src.getFile();
move: hashes the original twice ||| log.copySha256 = await core.sha256(copy); ||| log.copySha256 = await core.sha256(orig);
move: size check skipped ||| if (copy.size !== orig.size) { log.reason ||| if (false) { log.reason
move: hash check skipped ||| if (log.copySha256 !== log.sha256) { log.reason = 'SHA-256 differs'; return log; } ||| if (false) { log.reason = 'SHA-256 differs'; return log; }
move: hash mismatch carries on ||| if (log.copySha256 !== log.sha256) { log.reason = 'SHA-256 differs'; return log; } ||| if (log.copySha256 !== log.sha256) { log.reason = 'SHA-256 differs'; }
move: size mismatch carries on ||| B, original ' + orig.size + ' B'; return log; } ||| B, original ' + orig.size + ' B'; }
move: original change not checked ||| if (again.size !== orig.size || again.lastModified !== orig.lastModified) ||| if (again.size !== orig.size)
move: deletes the copy ||| await fromDir.removeEntry(name); ||| await toDir.removeEntry(name);
move: never checks the original is gone ||| log.originalGone = !(await core.exists(fromDir, name)); ||| log.originalGone = true;
move: original still there is fine ||| if (!log.originalGone) { log.kept = 'both'; log.reason = 'the original is still listed after the delete'; return log; } ||| /* removed */
move: failed write not reported ||| try { await w.abort(); } catch (_) { /* already closed */ }\n      throw e; ||| try { await w.abort(); } catch (_) { /* already closed */ }
move: says only the original is kept after copying ||| log.kept = 'both';\n    const w ||| log.kept = 'original';\n    const w
move: ok set before the delete ||| log.step = 'delete original'; ||| log.step = 'delete original'; log.ok = true;
move: hash taken of nothing ||| log.sha256 = await core.sha256(orig); ||| log.sha256 = await core.sha256(new Blob([]));
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
