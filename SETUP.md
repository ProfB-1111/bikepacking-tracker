# Setup Steps (do these at a computer)

## 1. Already done
- Maps JS API key, Drive API key, and `TIMEZONE_OFFSET_HOURS` (`-6`,
  Mountain Daylight Time) are already filled in in the code.
- `route.geojson`/`track.geojson` parsing has been checked against the
  real My Maps KML export and the real Garmin feed — both match the
  parser's assumptions.
- Photos are wired up: `site/js/photos.js` fetches the Drive folder,
  matches each photo to a track point by EXIF capture time, and renders
  markers + a sidebar list filtered to the selected day.

## 2. Enable GitHub Pages
Repo Settings → Pages → Source: **Deploy from a branch** → branch:
`main`, folder: **/ (root)**.

`site/` and `data/` stay as siblings at the repo root, so the site's
relative `../data/*.geojson` fetches keep working — no file moves
needed. The live site will be at:
`https://profb-1111.github.io/bikepacking-tracker/site/`
(the trailing `/site/` is expected with this setup).

## 3. Test the Actions manually
Repo → Actions tab → select "Fetch Route" or "Fetch Track" → "Run workflow"
button → confirm it runs green and commits an updated `.geojson` file.
This is much faster than waiting for the schedule to test that
everything's wired up correctly.

## 4. Verify data flow end to end
- Confirm `data/route.geojson` has real coordinates after "Fetch Route" runs.
- Once your inReach has reported a position, run "Fetch Track" manually
  and confirm `data/track.geojson` gets a point added.
- Open the Pages URL and confirm the map loads, route draws, the
  latest-position marker appears, day-grouping/green highlight works,
  and photo markers show up for days that have matching track data.

## Notes
- Photos taken before the Fetch Track Action has been running a while
  (e.g. before the trip/repo was set up) won't have nearby track points
  to match against yet — they'll show up flagged "approximate" rather
  than disappearing or mis-placing. This resolves itself as track
  history accumulates.
- **Known limitation: `track.geojson` will be sparser than the device's
  own point log.** Garmin's `Feed/Share/{ID}` endpoint only ever exposes
  the device's *current* position — confirmed by repeatedly polling it
  during and after a real ride — not a history of every ping. We only
  capture whatever is "current" at the exact moment `fetch-track.yml`
  happens to run, so any ping superseded by a newer one between polls is
  lost for good, not recoverable after the fact. `fetch-track.yml` polls
  every 5 minutes (GitHub Actions' minimum cron interval), and GitHub's
  scheduler can itself lag past that on busy periods, so on an active
  ride the captured trail will have real gaps. This has been accepted
  as a best-effort tradeoff rather than adding an external cron service
  to poll tighter than GitHub allows — over a multi-week trip the
  overall route shape still comes through fine, just not every ping.
- Phase 2 items (audio notes, messaging terminal) are intentionally not
  built yet — see README.md.
