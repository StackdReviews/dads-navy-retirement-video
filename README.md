# Dad's Navy Retirement Video

A tribute video honoring Michael Cook's 38 years of service in the United States Army and United States Navy, plus the web page that plays it.

The finished page is served from the `docs/` folder with GitHub Pages. Anyone with the link can watch it.

## What is in here

| Path | What it is |
| --- | --- |
| `manifest.json` | Everything editable: names, dates, card text, which photos are used and in what order, which videos play and in what order |
| `build.js` | Builds the video from the manifest using ffmpeg |
| `music/` | Public-domain recordings by the U.S. Army Band and U.S. Navy Band (from Wikimedia Commons) |
| `docs/` | The published web page: `index.html`, the streaming video in `docs/hls/`, chapter timestamps in `chapters.json` |
| `build/` | Scratch files and the full-quality `master.mp4` (not committed) |

The build expects the source photos and videos one folder up, in `../Pictures Organized`, `../Family Videos` and the folder root, exactly as they are on the Desktop.

## Adding Mom's and Kayla's videos later

1. Drop the new video files into the `Family Videos` folder.
2. Open `manifest.json` and add them to the end of the `Messages from Family` list, for example:

   ```json
   { "file": "Mom.MOV", "caption": "Mom" },
   { "file": "Kayla.MOV", "caption": "Kayla" }
   ```

   Put them after Grampy so they play last, right before the closing cards.
3. Rebuild and publish:

   ```powershell
   cd "C:\Users\Kayla Cook\Desktop\Dad's Navy Retirement Video\retirement-video-site"
   npm install
   node build.js
   git add -A
   git commit -m "Add videos from Mom and Kayla"
   git push
   ```

   The build only re-renders clips whose source changed, then re-assembles the full video and the streaming version. Allow about 10 to 15 minutes. GitHub Pages updates a minute or two after the push.

A fresh copy of the full-quality video is also written to `Dad Retirement Video - FULL.mp4` next to the source folders every time the build runs. That file is the one to put on a USB stick or upload to YouTube.

## Changing text, photos or order

Everything is in `manifest.json`:

- `title` and `closing` hold the words on the opening and closing cards.
- `photoSections` lists each chapter card and the photos under it. Remove a line to drop a photo, add a filename from `Pictures Organized` to include one. A photo that needs turning can be written as `{ "file": "name.jpg", "rotate": "cw" }` (or `ccw` or `180`).
- `videoSections` lists the message videos and the caption shown under each person.

Run `node build.js` after any change. Use `node build.js --force` to re-render every clip from scratch.
