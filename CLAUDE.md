# Field Journal (Patagonia trip app)

Bobby's offline travel and wildlife diary for his Patagonia photography trip (from 30 Nov 2026, ~10–12 days).
Long-term goal: turn the journal into a photography book.

## How it's built
- Plain HTML/CSS/JS progressive web app, no build step, no framework. Hosted on GitHub Pages.
- Installs to the home screen on iPhone (Safari → Share → Add to Home Screen) and Android (Chrome → Install app).
- All data is stored on the phone in IndexedDB (`db.js`). Nothing is sent to any server.
- `sw.js` caches the app so it opens with no signal. **Bump `CACHE` in sw.js and `APP_VERSION` in app.js on every change.**
- Files: `index.html` (layout), `styles.css`, `app.js` (all app logic), `db.js` (storage), `utils.js` (EXIF reader, photo resize, zip writer/reader),
  `sync.js` (Supabase cloud sync, plain fetch), `config.js` (Supabase URL + anon/publishable key — public by design; never the service_role key),
  `setup.sql` (tables, RLS, private `journal` storage bucket — paste into Supabase SQL Editor).

## Cloud sync (v1.2.0)
- Offline-first. Every local change sets `dirty: true`; deletes are tombstones (`deleted: true`, media blob dropped) so they sync.
- Sync order (v1.2.2): pull entries/media changed since `cloudCursor` (server_ts, 10 s overlap) → push entries → upload media files + rows → download missing files.
  Pull-first means a newer cloud edit replaces an older phone copy before anything uploads.
- Items saved before sync existed have `dirty` undefined (and media no `uploaded`) — these count as needing upload.
- Conflicts: newer `updated` wins. Triggers: app open, back online, visible again, 2.5 s after a save, every 5 min, "Sync now".
- Auth: email + password user created in the Supabase dashboard (sign-ups disabled). Session stored in IndexedDB settings; refresh token keeps it signed in.
- "Free up space": photos already uploaded keep only a 480 px `thumb` (`offloaded: true`); full copy fetched from cloud on demand (gallery, backup export).
- Tested against a local mock of the Supabase endpoints with two simulated phones (iPhone + Android).

## Data model
- Entry: id, at (epoch ms), tz, offsetMin, device, text, species[], place, lat/lon/acc/alt, created, updated.
- Media: id, entryId, kind (photo|audio), mime, blob, takenAt, durationSec, originalName, species (set = ID photo for that species tag; one per species per entry; never moves the entry's time).
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
- 2026-11-07 (v1.1.0): species ID photos — 📷 on each species tag in the editor, avatars on timeline chips, thumbnails + per-species gallery on Species tab.
- 2026-11-07 (v1.2.0): cloud sync built and tested on mock. OneDrive stays the archive via Save backup.
- 2026-11-07 (v1.2.1): config.js connected to Bobby's Supabase project (mwtnoarhuizfozvnolci). The Claude workspace cannot reach supabase.co
  (proxy blocks it), so real-sync checks happen on Bobby's phones. Next: confirm setup.sql run + user created + sign-ups off; sign in on both phones.
- 2026-11-07 (v1.2.2): real-phone bug — Android entries made before sync (no `dirty` flag) never uploaded while badge said synced. Fixed: undefined dirty = needs push; sync now pulls before pushing.
- 2026-11-07 (v1.2.3): Android species ID photo showed gallery only (newer Android picker hides camera). Non-iOS now gets a Take photo / Choose from gallery menu; iOS keeps its native sheet.
- 2026-11-07 (v1.2.4): delete needs two confirmations (confirm, then type DELETE). Media tombstones now keep only id/entryId/kind/mime.
- 2026-11-07 (v1.3.0): Journal shows one day at a time (today by default; follows today until another day is picked), day strip with counts + swipe, dark day summary card (route, entries/species/photos/voice), entries morning→evening. New Calendar tab: weeks with trip days/entries/today only, counts per day, busiest in amber, tap → opens day in Journal; trip totals + best day. Setting: trip length (default 12). Saving jumps to the entry's day.
- 2026-11-07 (v1.4.0): Map tab — Leaflet bundled in vendor/leaflet (offline). Whole trip = coloured line per day + dashed day links + colour key; single day = numbered stops; popups with photo/species and Open this day; Map (OSM) / Terrain (OpenTopoMap); km between entries. sw.js caches viewed tiles (field-journal-tiles, max ~4000) — no bulk prefetch (OSM policy).
