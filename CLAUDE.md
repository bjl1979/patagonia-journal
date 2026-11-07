# Field Journal (Patagonia trip app)

Bobby's offline travel and wildlife diary for his Patagonia photography trip (from 30 Nov 2026, ~10–12 days).
Long-term goal: turn the journal into a photography book.

## How it's built
- Plain HTML/CSS/JS progressive web app, no build step, no framework. Hosted on GitHub Pages.
- Installs to the home screen on iPhone (Safari → Share → Add to Home Screen) and Android (Chrome → Install app).
- All data is stored on the phone in IndexedDB (`db.js`). Nothing is sent to any server.
- `sw.js` caches the app so it opens with no signal. **Bump `CACHE` in sw.js and `APP_VERSION` in app.js on every change.**
- Files: `index.html` (layout), `styles.css`, `app.js` (all app logic), `db.js` (storage), `utils.js` (EXIF reader, photo resize, zip writer/reader).

## Data model
- Entry: id, at (epoch ms), tz, offsetMin, device, text, species[], place, lat/lon/acc/alt, created, updated.
- Media: id, entryId, kind (photo|audio), mime, blob, takenAt, durationSec, originalName.
- Photos are resized to max 2048px JPEG on capture. Gallery photos use their EXIF time and GPS.

## Backup format (important for Phase 2)
Store-only zip: `journal.json` (all entries + media index), `journal.md` (readable day-by-day text),
`media/YYYY-MM-DD_HHMM_<species-or-place>_<kind>_<id>.<ext>`. Import merges by entry id (newer `updated` wins),
which is how two phones (iPhone + Android) are combined.

## Phases
- **Phase 1 (done, v1.0.0):** capture — voice, text, photo; auto time + GPS; species tags and life list; day timeline with trip-day numbers; backup and merge.
- **Phase 2 (after the trip):** book builder. Transcribe voice notes, match Bobby's edited camera photos to entries by capture time
  (camera clock must match phone; time-zone offset may need correcting), and generate a draft photography-journal layout with chosen photos.

## Where we left off
- 2026-11-07: Phase 1 built and tested end to end in a mobile browser emulator. Pushed to github.com/bjl1979/patagonia-journal
  (public), GitHub Pages enabled from `main` / root. Live at https://bjl1979.github.io/patagonia-journal/.
  Next: Bobby installs on iPhone + Android and does a real-world field test before 30 Nov; fix anything that comes up.
- 2026-11-07 (v1.0.1): iPhone field-test fix — editor Save button was off screen. Editor is now a full-screen page with notch padding,
  plus a second Save at the bottom. Service worker switched to network-first so updates reach phones on next open.
