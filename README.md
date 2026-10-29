# filter

Sorts the photos and videos on an Android phone into folders by what is in them. Installed from this site as an app (PWA). Built for one person's use.

Not built yet: the plan is in CLAUDE.md. What is here now is phase F0, a probe: a page that tests what the phone allows (opening the camera folder, a safe copy and delete on a test file it makes itself, keeping access after the app is closed, and how fast recognition runs). It sorts nothing and never moves a real photo or video.

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
- `node filter_behave.cjs`: runs the app in Chromium against a fake folder tree, including copy, verify, delete and a forced bad copy.
- `bash filter_mutate.sh`: plants small bugs in the file-safety code and checks the tests catch every one.
