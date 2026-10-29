# CLAUDE.md: filter

## What this is
filter sorts the photos and videos on Gary's Pixel 9 Pro XL into folders by what is in them. It is a PWA installed from GitHub Pages (jeuron-hue/filter, public), like retouch. Private working tool, not a portfolio piece. Agreed 29/10/26 as a separate app from retouch: retouch edits one picture, filter organises many.

## Hard rule: photos never leave the phone
- All recognition runs on the phone, in the browser, with vendored models. No uploads, no cloud APIs, no analytics, no telemetry.
- Enforced, not promised: a Content-Security-Policy meta tag with connect-src 'self', and a static test that fails on any other origin in the source.
- No libraries, models or fonts from CDNs. Everything is vendored so the app works offline after first load.
- No real photos of people in the repo. Test pictures that need real content live in reference/test-images/ (gitignored); tests that need them skip cleanly when it is absent.

## Hard rule: never lose a file
Gary keeps no backup (no Google Photos backup). On Android a web app cannot rename or move a file; a move is a copy and then a delete. So:
- A move is always: copy, read the copy back and check it is byte-identical to the original (size and SHA-256), and only then delete the original. Any mismatch stops the run and keeps both.
- Review mode: Gary chooses copy or move when he confirms; copy is the default and leaves the original untouched.
- Auto mode: every file sorted is moved, the safe way above (Gary's rule, 29/10/26), so nothing is lost and nothing is left doubled up.
- Every run writes a log (what went where, with hashes) to filter-logs/ in the picked folder, as a new file that never replaces another, so the last run can be undone the same safe way.
- These rules hold in both run modes (below). In Auto mode, a picture filter is unsure about stays where it is.

## Run modes (Gary picks per run)
- Review: filter shows its plan first, a grid per proposed folder; tap a picture to send it elsewhere. Nothing is copied, moved or deleted until Gary confirms.
- Auto: filter sorts straight away, moving each file by verified copy then delete, and shows what it did afterwards, with undo for the run.

## Recognition modes (Gary picks per run)
- By description: folders named by what is in them. A fixed list filter knows (people, pets, food, screenshots, documents, scenery, other), plus a few of Gary's own, typed and edited by him (say "receipts" or "hawker food"). See Recognition under Architecture.
- By example: Gary makes each folder himself and places 3 example pictures and 3 example videos in it. A picture is compared with the example pictures, a video with the example videos; each goes to the closest folder, or to "unsure" when nothing is close.

## Architecture
- Vanilla JS and CSS, no framework, no build step, no server. filter.html holds the whole app; extra files only as a PWA needs them (manifest.webmanifest, sw.js, icons/, vendor/, index.html redirect stub). Test tooling sits beside it.
- Folder access: the File System Access API (showDirectoryPicker), available in Chrome on Android since Chrome 132 (01/25). Very large folders (all of DCIM) can stall it, so filter reads in batches and can start from a subfolder.
  - Permission is lost at every restart (F0). filter keeps the folder handle in IndexedDB and, on start, shows one "Allow access" button where the folder buttons are, so a single tap brings the folder back; the status strip says plainly when access needs re-granting.
  - Looking a file up by name in a big folder costs seconds (F0: 4.2 s in DCIM/Camera, 8.5 ms in a small folder). filter works from the handles one listing returns, keeps each folder's names in memory, and never looks files up one by one in a big folder. F4 must cut the per-file lookups of the safe move (open the original from the listing's handle, test whether deleting through the file's own handle avoids the lookup, check that originals are gone with one fresh listing per batch); at three lookups a moved file costs about 12 s, about 3.5 h per 1000.
- Recognition: MediaPipe Tasks Vision, the same pinned version as retouch (0.10.35, not 1.x, which logs usage to Google).
  - By description, fixed list: an image classifier (EfficientNet-Lite0) plus a face detector (BlazeFace short range, run on the whole photo and on four overlapping quarters so smaller faces are found) plus plain rules, in order: screenshots (by name, or a screen-shaped PNG with no camera data), people (a face), documents (mostly text: bright, little colour, dark strokes), then the folder whose classifier labels add up highest among its top 10 (pets, food, documents, scenery) if the sum reaches 0.25, else other. Each threshold is one named value in RULES; the label groups are index ranges checked against the labels inside the model.
  - By description, typed: needs a model that reads both words and pictures into the same numbers (a CLIP-style model), so a typed folder name can be compared with a picture. MediaPipe has none, so this is a second runtime (about 100 MB more to download) and slower on the phone. Which model, under which licence and at what size, is settled and written here before F5 starts; its licence must allow this use.
  - By example: an image embedder (a model that turns a picture into a list of numbers, where similar pictures get similar numbers). Each folder's 3 example pictures and 3 example videos become its reference points.
  - Speed: decoding the photo, not the model, sets the pace (F0: 380 ms to decode, 50 to 80 ms to classify). F1 tries decoding in parallel and the small preview picture stored inside each JPEG, and keeps the CPU delegate unless the GPU proves faster on whole runs.
  - Videos: three frames sampled (10 %, 50 %, 90 % through). By description, each frame is recognised and the majority wins; by example, the three frames' numbers are averaged and compared with the example videos'.
- Models come from Google's model store. Claude's cloud session reached it on 29/10/26 and fetched EfficientNet-Lite0 directly; the rig shell cannot reach it, so there Gary downloads each model and Claude vendors it. Either way each model is vendored with its sha256, version and licence in the filter.html build notes.

## Design
filter uses retouch's darkroom style (Gary's choice, 29/10/26), not Lab Book, so the two apps look like a pair. The spec is retouch's CLAUDE.md Design section; the parts that apply:
- Dark only. Neutral near-black surround so the pictures are judged fairly; the pictures are the brightest thing on screen. No light theme.
- Tokens (CSS custom properties at the top of filter.html), the same values as retouch: stage #0B0B0B, chrome #141312, raised #1D1B19, pressed #2E2B27, lines #2C2925 / #3A3631, ink #EEE8DE, muted #A59E92, faint #8A8377. One accent, the amber safelight #F2A33A (text on it #1B1205). Pass #7DBE8A, watch #E0A84A, fail #E57360.
- Type: Barlow Semi Condensed 400/600 for labels and buttons (labels in spaced capitals), IBM Plex Mono 400/500 for numbers and counts, vendored in vendor/fonts/ (copied from retouch).
- Motifs: film-edge labels in amber mono (counts, folder names, the run date), sprocket holes along the bottom bar, crop-mark corners on the empty screen and the icon. filter gets its own icon in the same style.
- Phone first: portrait, one-handed, tap targets at least 44 px.
- Uncluttered: status in a thin strip at the top; short captions only where they apply.
- The review screen is the heart of Review mode: a grid per proposed folder, counts per folder, tap a picture to send it elsewhere, one amber confirm. Auto mode ends on the same screen, showing what was done, with undo.

## Phases
Each phase on its own branch, all suites green, Gary merges, tests on the Pixel and confirms before the next.
- F0: probe on the Pixel. Pick DCIM/Camera; read a batch of 500; create a subfolder; copy, verify and delete a test file; reopen the folder after closing the app (does Chrome keep the permission?); time recognition per photo. The answers are written here before F1 starts. Done 30/10/26 with the probe (filter.html v0.0.2) on the Pixel 9 Pro XL, Android 17, Chrome 155, installed app. (1) Reading: DCIM/Camera (1861 entries) opens with no stall; about 6 s before the first entry, then the whole folder by 6.6 s. Reading a file (getFile) costs 80 to 115 ms. (2) The safe move works on the phone: the copy was byte-identical (size and SHA-256), the original deleted and gone; a forced bad copy stopped before any delete and kept the original. The cost is in name lookups, not data: finding a file by name took 4.2 s in DCIM/Camera against 8.5 ms in a small folder, so deleting from Camera took 4.1 s and a 3 MB move 13.8 s in all, of which reading, writing and hashing the bytes took about 1 s. Creating a file or folder in Camera took 16 to 20 s. (3) Folder permission does not survive a restart ("prompt" on all four reopenings); the stored handle does, and one tap on Chrome's permission prompt re-grants it (2.7 s), with no picker. (4) Recognition: decoding a 12.5 MP photo to 512 px takes about 380 ms; the classifier then takes 77 ms on the CPU, 53 ms on the GPU (whose first call takes 0.8 s). About 7.5 min per 1000 photos either way: decoding is the bottleneck. ImageNet labels fit poorly (top scores 0.06 to 0.18 on 3 of 5 photos), which is why the fixed list comes from rules over them plus the face detector.
- F1: photos, by description, Review mode, copy only. Built 30/10/26 (filter.html v0.1.0, branch f1-photos); Gary's choices: copies go into subfolders of the picked folder (people, pets, food, screenshots, documents, scenery), and each run takes the newest N photos not yet sorted (default 200; dates from the file names, photos already in filter's folders are skipped). Photos in "other" stay where they are and are not copied. The JPEG's own preview picture is used for recognition when it is at least 256 px, and three photos are read ahead while one is recognised. F1 deletes nothing. Pending Gary's test on the Pixel.
- F2: by example (3 pictures per folder).
- F3: videos, both recognition modes (3 example videos per folder).
- F4: move (verified copy, then delete), Auto mode, and undo of the last run. Auto comes with move and undo, since an automatic run is only safe once a run can be undone.
- F5: typed descriptions, Gary's own folder names alongside the fixed list. Last, as the biggest addition (a second model and runtime).

## Testing
- filter_checks.cjs (static): CSP, no external origins, allowed files only, vendored versions and hashes recorded.
- filter_behave.cjs (Chromium via Playwright): synthetic fixtures built in the test (coloured shapes, text images, screen-sized PNGs, short generated clips), a fake folder tree in place of the real picker, numeric checks on where each file lands, and on copy, verify, delete and undo, including a forced mismatch that must stop the run with both files kept.
- filter_mutate.sh: a mutation runner over the core sorting and file-safety functions (the CORE block in filter.html).
- Everything green before any commit.

## Working with Gary
- Gary is a process chemist learning to code. Explain each layer in plain words.
- Dates dd/mm/yy, 24-hour times, SI units, no em dashes in docs or UI text.
- README is public and plain. reference/ is gitignored and never pushed.
- Plans and this file are updated in place; no addenda.
