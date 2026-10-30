# filter: change history

What changed in each version, newest first. Why each change was made, and what Gary's runs on the Pixel showed, is in CLAUDE.md under Phases. Dates dd/mm/yy, Singapore time.

## v0.3.4, 30/10/26, F3
- Keeps the screen on while filter works (Screen Wake Lock), taken again when filter comes back on screen. A refusal, say on low battery, does not stop the run.
- A video being read when filter left the screen is read again once it is back, up to 3 tries in all. Photos and copies simply wait; an interrupted copy is never counted as done.
- F3 closed by Gary at this version.

## v0.3.3, 30/10/26, F3
- Each video frame is confirmed on show before it is used: the video sits on the page (2 px, nearly clear) and filter waits until the browser shows a frame within 0.25 s of the time asked for, up to 3 s. A frame it could not confirm is still used and marked "frame not confirmed" in the run details. Fixes the same picture being taken for two or three frames, which let one video land in different folders on two runs.
- Review: press and hold a picture to pick several. Taps then pick more or leave one out, picked tiles get an amber frame and a tick, and Send to puts them all in one folder.

## v0.3.2, 30/10/26, F3
- A video frame that sees nothing clear (other) no longer votes. The folder seen in the most of the remaining frames wins; a tie, or nothing clear in any frame, leaves the video in other. Moves two scenery videos from Gary's second video run out of other.

## v0.3.1, 30/10/26, F3
- After each seek filter waits until a frame is there, and if the browser still refuses it, seeks again 0.1 s later, up to 3 tries (frameTries, frameNudge). Fixes one FHD video that failed with "the image source is not usable".
- The run details of a run of videos only no longer say "0 photos".

## v0.3.0, 30/10/26, F3
- Videos, in both recognition modes. A run takes the newest N photos and videos together, by the date in the name.
- Three frames per video (10 %, 50 %, 90 % through), each decoded like a photo. By description, each frame goes through the same rules and the folder seen in two of three wins; frames that disagree leave the video in other. By example, the three frames are averaged and compared with example videos only, against minSimVideo 0.32 and minGapVideo 0.05. A folder with no example videos takes no videos.
- Videos are copied into the same folders as photos. The review tags each video with its length; the run details and the log keep what each frame said.
- Files over 64 MB are hashed in 4 MB pieces by a plain JavaScript SHA-256, which gives the same hash as the browser's own.
- Tests: WebM clips recorded in the page; new mutants for the hash, frame times, the vote and averaging.

## v0.2.2, 30/10/26, F2
- minSim 0.35 to 0.32, from Gary's third run: places three suited and close-up photos at 0.33 to 0.34 and one more fabric close-up. The highest photo of nothing in the folders scored 0.29.
- F2 closed by Gary at this version.

## v0.2.1, 30/10/26, F2
- minSim 0.50 to 0.35, from Gary's first two runs.
- The number of newest photos Gary types is kept when the re-check switch or the mode changes, shown smaller only while fewer photos are there.

## v0.2.0, 30/10/26, F2
- Sort by example, alongside by description. A switch on the setup screen picks the mode per run, remembered on the phone.
- Example folders are the subfolders of filter-examples/ in the picked folder, read fresh on every run and never written to. Folders named other, unsure, filter-logs or filter-examples, hidden folders and folders with no photos are not used, and the setup screen says so.
- New model: MediaPipe image embedder, MobileNet-V3 large, float32, 10.9 MB, Apache-2.0.
- A photo goes to the closest folder if it scores at least minSim (0.50) and beats the runner-up by minGap (0.05); otherwise it is unsure and stays where it is. Copies go to a subfolder of the picked folder with the example folder's name.
- One set of sorted photos for both modes.
- Review lists each folder's least sure photos first. Run details give each photo's best score, closest example and runner-up, and tag photos that are themselves examples. The log adds the mode, the examples used, and best and runner-up.

## v0.1.5, 30/10/26, F1
- A frame-filling person box at 0.65 or more counts as a person when the classifier's labels for clothes worn on the body (CLOTHES: suit, ties, jersey, coats, gowns) add up to 0.25. Brings tight suit portraits back into people.
- No closer look after a close-up.
- F1 closed by Gary at this version.

## v0.1.4, 30/10/26, F1
- A person box filling at least 90 % of both the width and the height, with no face, is a close-up of part of a body and does not count as a person.
- The closer look adds only person boxes of at most 12 % of the photo.

## v0.1.3, 30/10/26, F1
- Closer look: boxes from all nine parts are put back on the whole photo, and boxes of one label that overlap (intersection over union 0.4, or 70 % inside) count once, then people are counted. Fixes a room of students, one per part, counting as one person.
- The closer look decides people only; pets and food come from the first look.
- Each photo is decoded once at 1280 px, ahead of time; the first look uses a 512 px copy. The JPEG preview path is gone.
- "Copy run details" on the review screen as well as the done screen.
- A re-check switch on the setup screen: takes the newest photos whether sorted or not, copies nothing, and marks in the details the folder each photo was already in.

## v0.1.2, 30/10/26, F1
- A closer look for people at a distance: photos not already people or screenshots are decoded again at 1280 px and searched by the object detector in nine overlapping parts.
- Photos left in other show the best person score seen; the run details count the closer looks.

## v0.1.1, 30/10/26, F1
- New model: MediaPipe object detector, EfficientDet-Lite0 int8, 4.6 MB, the 80 COCO objects, Apache-2.0. People also come from person boxes; a sure cat, dog or food box decides pets or food.
- Faces need 0.75, or 0.85 when seen only in a quarter of the photo.
- Food labels are dishes only: restaurant, frying pan and wok removed.
- Every photo's decision is logged, copied or not; "Copy run details" on the done screen copies them as text.

## v0.1.0, 30/10/26, F1
- The app proper replaces the F0 probe: photos, by description, Review mode, copy only.
- After a restart, one tap on "Allow access" brings the folder back.
- Each run takes the newest N photos not yet sorted (default 200; dates from the file names).
- New model: MediaPipe face detector, BlazeFace short range, Apache-2.0, run on the whole photo and on four overlapping quarters. With the EfficientNet-Lite0 classifier and plain rules: screenshots, people, documents, then the folder whose labels add up highest.
- Review: a grid per proposed folder; tap a photo to send it elsewhere. Photos in other stay where they are.
- Copy into subfolders of the picked folder. Every copy is read back and checked (size and SHA-256); a mismatch stops the run and keeps both. Never overwrites, never deletes. Each run writes a log to filter-logs/.

## v0.0.2, 30/10/26, F0
- The reopen check waits up to 15 s, as DCIM/Camera takes 6.4 s to give its first entry.
- The real Android version, phone model and Chrome version come from client hints.
- The status strip shows the current step and a seconds counter; step times show even when a move stops.
- Leftover probe files, including Chrome's half-written .crswap files, are cleared before the move test; the probe's subfolder is removed at the end when empty.
- New row: how long a name lookup takes in DCIM/Camera against a small subfolder.
- F0 done at this version; the answers are in CLAUDE.md.

## v0.0.1, 30/10/26, F0
- The probe: read a batch of 500 entries from a picked folder; a safe move of a test file (copy, read back, compare size and SHA-256, then delete), with a forced bad copy that must keep the original; reopen with the folder handle kept in IndexedDB; recognition timing on 5 photos, CPU then GPU.
- Vendored: MediaPipe Tasks Vision 0.10.35 and the fonts, copied from retouch; EfficientNet-Lite0 float32 from the MediaPipe model store, Apache-2.0.

## Brief, 29/10/26
- CLAUDE.md build brief, README and .gitignore. Auto mode always moves by verified copy, then delete (Gary's rule).
