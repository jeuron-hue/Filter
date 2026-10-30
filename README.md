# filter

Sorts the photos and videos on an Android phone into folders by what is in them. Installed from this site as an app (PWA). Built for one person's use.

Built so far: photos and videos, in Review mode, copy only, recognised one of two ways, picked per run. By description: people, pets, food, screenshots, documents, scenery, other; a video is judged by three of its frames. By example: make folders inside filter-examples/ in the picked folder, put 3 example photos and 3 example videos in each, and filter puts each photo with the closest example photos and each video with the closest example videos, or leaves it as unsure. Pick a folder, choose how many of the newest photos and videos to sort, check the plan as a grid per folder, move any picture that is in the wrong place (press and hold to pick several at once), then copy. The copies go into subfolders of the picked folder, videos beside the photos; files in "other" or "unsure" stay where they are. Nothing is moved or deleted yet. The rest of the plan is in CLAUDE.md.

## What it will do
- Pick a folder on the phone; filter sorts its photos and videos into subfolders.
- Two ways to run: Review (see the plan, change it, then confirm) or Auto (sorts straight away, with undo).
- Two ways to recognise: by description (people, pets, food and so on, plus a few names you type) or by example (make a folder and put 3 example pictures and 3 example videos in it).

## Privacy
Everything runs on the phone. No photo or video is uploaded anywhere, and the app works offline once installed.

## Safety
Copy is the default. A move copies the file, checks the copy is identical, and only then deletes the original.

## Tests
The app has no build step. The tests need Node and Playwright (`npm install` once).

- `node filter_checks.cjs`: static checks (no other websites, allowed files only, pinned versions and hashes of everything vendored).
- `node filter_behave.cjs`: runs the app in Chromium against a fake folder tree of synthetic pictures and short clips recorded in the test: where each photo and video lands, the copy and its check, and a bad copy that must stop the run.
- `bash filter_mutate.sh`: plants small bugs in the sorting and file-safety code and checks the tests catch every one.
