# Bikepacking Tracker — Architecture & Build Plan V1

A self-hosted alternative to Garmin MapShare: a static site (GitHub Pages) showing
your planned route, live/accumulating GPS track, and daily photos — with a
day-by-day view and zoom controls. Built to be modular so features can be added
without reworking earlier pieces.

---

## Core Concept

- **Hosting**: GitHub Pages (static site, free)
- **Automation**: GitHub Actions (scheduled cron jobs, free on your repo)
- **Map**: Google Maps JavaScript API
- **Data**: Flat JSON/GeoJSON files committed to the repo — no database, no backend server

Everything is "pull," not "push": scheduled jobs fetch data from external
sources (Garmin, Drive) and write it into the repo as static files. The
website just reads those files. This keeps hosting free and avoids exposing
credentials in client-side code where possible.

---

## Phase 1 — Route, Track, Photos

### 1. Planned Route (auto-updating, daily)
- Route lives in Google My Maps as normal — edit it there whenever your
  plans change.
- Public KML export URL for a shared My Maps map:
  `https://www.google.com/maps/d/kml?mid={your-map-id}&forcekml=1`
- A second scheduled **GitHub Action** (daily cron) fetches this URL,
  converts it to GeoJSON, and **overwrites** `route.geojson`.
- Frontend just reads `route.geojson` as before — no frontend change
  needed when the route updates, just up to a 24h lag.

### 2. Live Track Log (accumulating)
- Source: Garmin inReach MapShare KML feed
  (`https://share.garmin.com/Feed/Share/{MapShare-ID}`).
- A scheduled **GitHub Action** (every 10–15 min) fetches this feed,
  parses new points, and **appends** (not overwrites) to `track.geojson`.
- This becomes the full breadcrumb trail for the trip and is the source
  of truth for day-grouping and photo-matching.
- Client-side polling isn't possible — Garmin's feed blocks cross-origin
  browser requests (CORS), so the Action is required as a fetch proxy.
  CORS is a browser-only restriction (enforced by the browser, not the
  server); a GitHub Action is a server-side script, so it isn't subject
  to CORS and can fetch Garmin's feed directly. The site's own JS never
  talks to Garmin — only to the JSON file the Action writes into the repo.

### 3. Photos
- Daily workflow: upload photos to a public "Anyone with the link" Google
  Drive folder from your phone (queues offline, sends when you have signal).
- Site calls Drive API v3 `files.list` on that folder, using a restricted
  read-only API key (scoped to Drive API + your domain).
- Use `imageMediaMetadata.time` (EXIF capture time) for matching — **not**
  `createdTime` (upload time), since batch uploads at camp would lag.
- **Photo → location matching**: nearest-neighbor (or interpolated) lookup
  against `track.geojson` by timestamp.
  - If nearest track point is beyond a max threshold (e.g. 2 hrs), flag
    photo as "approximate / unplaced" rather than mis-pinning it.
- **Timezone handling**: track timestamps are UTC; EXIF timestamps are
  local and usually lack timezone info. Fix one offset per trip (or per
  leg, if crossing zones) so day-grouping lines up correctly.

### 4. Day Grouping + Highlighting
- Group photos by local calendar date (corrected for timezone).
- Day selector UI (tabs or dropdown) drives:
  - Filtering `track.geojson` to that day's time range, rendered in
    **green** (vs. gray for the full trip track).
  - Filtering photo markers to that day only.
  - `fitBounds()` to zoom/center the map on that day's segment.

### 5. Zoom / View Modes
- Default zoom on load: `fitBounds()` to full route.
- "Where am I now" mode: center + zoom to most recent track point.
- Day view: `fitBounds()` to selected day's track + photos.
- Standard manual zoom controls always available.

### 6. Map Layers (rendered bottom to top)
1. Planned route (static polyline, neutral color)
2. Full track log (gray)
3. Selected day's segment (green)
4. Photo markers (camera icon, click → InfoWindow with thumbnail + time)

---

## File Structure (Phase 1)

```
/repo
  /data
    route.geojson          # overwritten daily by GitHub Action (My Maps KML)
    track.geojson           # appended every 10-15 min by GitHub Action
  /.github/workflows
    fetch-route.yml         # scheduled Action: pulls My Maps KML (daily)
    fetch-track.yml         # scheduled Action: pulls Garmin feed (10-15 min)
  /site
    index.html
    /js
      map-init.js           # base map, route, track rendering
      day-view.js            # day grouping, filtering, green highlight
      photos.js              # Drive API fetch + EXIF matching
      zoom-controls.js
    /css
      style.css
  README.md
```

---

## Open Items Before Building
- [ ] Garmin MapShare page URL / ID
- [ ] Google My Maps map ID (from the shareable link), map set to shared/public
- [ ] Confirm timezone offset(s) for the trip
- [ ] Google Drive folder created + shared, API key generated and restricted
- [ ] Decide max-threshold value for "unplaced" photos (default suggestion: 2 hrs)

---

## Phase 2 — Future Additions (not built yet)

### Audio Notes
- Same pattern as photos: audio file uploaded to a Drive folder,
  timestamp-matched to track log, marker with inline `<audio>` player
  in the InfoWindow.
- No changes needed to Phase 1 architecture — just a third parallel
  content channel alongside photos.

### Messaging Terminal
- A section of the webpage with:
  - **Public feed**: live-updating list of short messages (visible to
    anyone viewing the site).
  - **Personal messages**: messages directed at you specifically (family
    check-ins, etc.), separate from the public feed.
- Each message carries a timestamp, which is used the same way as photo/
  audio timestamps: matched against `track.geojson` to highlight the
  relevant map location/segment when a message is selected.
- Replaces the earlier "structured notes" idea (shelved because Google
  Forms requires standard internet, which isn't reliable on-route).
  Needs a submission method that works over inReach's connectivity —
  to be solved when this phase is designed.

---

## Design Principle Going Forward
Every new content type (photos, audio, messages) follows the same shape:
**timestamped data → matched to track log by time → rendered as a map
layer + UI list, filterable by day.** This is why Phase 1 focuses on
getting the track log and matching logic solid first — everything else
plugs into it.
