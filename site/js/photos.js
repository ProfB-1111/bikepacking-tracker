/**
 * photos.js
 *
 * Fetches photos from the public Google Drive folder, matches each one
 * to a location by EXIF capture time (nearest/interpolated track point),
 * and renders them as map markers + a sidebar list filtered to the
 * currently selected day.
 *
 * Relies on globals from day-view.js (loaded first in index.html):
 * TIMEZONE_OFFSET_HOURS, toLocalDate(), localDateKey().
 */

const DRIVE_API_KEY = "AIzaSyCOU64_AaprtMZFe5j8HQ-tC6I5l0wVYk8";
const DRIVE_FOLDER_ID = "1NMc7sxZqDqDuoXaF3DTgRtlBxaQuodTe";

// If the nearest track point is further than this from a photo's capture
// time, the photo's location is "approximate" rather than confidently
// pinned (still placed, just flagged in the UI).
const APPROX_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

let photoInfoWindow = null;

function driveApiConfigured() {
  return DRIVE_API_KEY && DRIVE_API_KEY !== "YOUR_DRIVE_API_KEY_HERE";
}

async function fetchAllPhotoFiles() {
  const files = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      q: `'${DRIVE_FOLDER_ID}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: "nextPageToken,files(id,name,thumbnailLink,imageMediaMetadata)",
      key: DRIVE_API_KEY,
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Drive API error: ${res.status}`);
    }
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return files;
}

// Drive's imageMediaMetadata.time is the EXIF capture time, formatted
// like "2026:07:04 14:32:10" with no timezone. It's local time at the
// point of capture. We treat those clock digits as if they were UTC
// (Date.UTC), then subtract TIMEZONE_OFFSET_HOURS to get the true UTC
// instant - the same fixed single-offset simplification day-view.js
// uses, so photo-day-grouping and track-day-grouping agree. This would
// need a per-date-range offset table if the trip crosses timezones.
function exifTimeToUTCMillis(exifTime) {
  const m = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(exifTime || "");
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const localAsUTC = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return localAsUTC - TIMEZONE_OFFSET_HOURS * 3600000;
}

function buildSortedTrack(trackData) {
  return (trackData?.features || [])
    .map((f) => ({
      t: new Date(f.properties.timestamp).getTime(),
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
    }))
    .sort((a, b) => a.t - b.t);
}

// Nearest-neighbor (with linear interpolation between the two bracketing
// points) lookup of a photo's location against the sorted track log.
function matchPhotoLocation(photoUTCms, sortedTrack) {
  if (!sortedTrack.length) return null;

  let idx = sortedTrack.findIndex((p) => p.t >= photoUTCms);
  let before, after;
  if (idx === -1) {
    before = after = sortedTrack[sortedTrack.length - 1];
  } else if (idx === 0) {
    before = after = sortedTrack[0];
  } else {
    before = sortedTrack[idx - 1];
    after = sortedTrack[idx];
  }

  const nearestDist = Math.min(Math.abs(photoUTCms - before.t), Math.abs(photoUTCms - after.t));
  const approximate = nearestDist > APPROX_THRESHOLD_MS;

  let lat, lng;
  if (before.t === after.t) {
    lat = before.lat;
    lng = before.lng;
  } else {
    const frac = Math.max(0, Math.min(1, (photoUTCms - before.t) / (after.t - before.t)));
    lat = before.lat + (after.lat - before.lat) * frac;
    lng = before.lng + (after.lng - before.lng) * frac;
  }

  return { lat, lng, approximate };
}

function cameraIconDataUrl(approximate) {
  const dash = approximate ? ' stroke-dasharray="3,2"' : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">` +
    `<circle cx="13" cy="13" r="11" fill="#8a6fc7" stroke="#ffffff" stroke-width="2"${dash}/>` +
    `<path d="M8 10h2.2l1-1.6h3.6l1 1.6H18a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1z" fill="#fff"/>` +
    `<circle cx="13" cy="14" r="1.8" fill="#8a6fc7"/></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function formatTripLocalTime(utcMillis) {
  const shifted = toLocalDate(utcMillis);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${localDateKey(utcMillis)} ${hh}:${mm}`;
}

function buildInfoWindowContent(photo) {
  const wrap = document.createElement("div");
  wrap.className = "photo-infowindow";

  const img = document.createElement("img");
  img.src = photo.thumbnailLink;
  img.alt = photo.name;
  wrap.appendChild(img);

  const time = document.createElement("div");
  time.className = "photo-time";
  time.textContent = formatTripLocalTime(photo.timeUTCms);
  wrap.appendChild(time);

  if (photo.approximate) {
    const note = document.createElement("div");
    note.className = "photo-approx-note";
    note.textContent = "Approximate placement - no nearby track point";
    wrap.appendChild(note);
  }

  return wrap;
}

function clearPhotoMarkers() {
  (window.tracker.photoMarkers || []).forEach((m) => m.setMap(null));
  window.tracker.photoMarkers = [];
}

function showPhotoInfoWindow(photo, marker) {
  if (!photoInfoWindow) {
    photoInfoWindow = new google.maps.InfoWindow();
  }
  photoInfoWindow.setContent(buildInfoWindowContent(photo));
  photoInfoWindow.open(window.tracker.map, marker);
}

function renderPhotoMarkers(photos) {
  const map = window.tracker.map;
  clearPhotoMarkers();

  window.tracker.photoMarkers = photos.map((photo) => {
    const marker = new google.maps.Marker({
      position: { lat: photo.lat, lng: photo.lng },
      map,
      title: photo.name,
      icon: {
        url: cameraIconDataUrl(photo.approximate),
        scaledSize: new google.maps.Size(26, 26),
        anchor: new google.maps.Point(13, 13),
      },
    });
    marker.addListener("click", () => showPhotoInfoWindow(photo, marker));
    photo._marker = marker;
    return marker;
  });
}

function renderPhotoList(photos) {
  const container = document.getElementById("photo-list");
  container.innerHTML = "";

  if (!photos.length) {
    container.innerHTML = '<p class="muted">No photos for this day.</p>';
    return;
  }

  photos
    .slice()
    .sort((a, b) => a.timeUTCms - b.timeUTCms)
    .forEach((photo) => {
      const item = document.createElement("div");
      item.className = "photo-item" + (photo.approximate ? " approximate" : "");

      const img = document.createElement("img");
      img.src = photo.thumbnailLink;
      img.alt = photo.name;
      item.appendChild(img);

      const meta = document.createElement("div");
      meta.className = "photo-item-meta";

      const time = document.createElement("div");
      time.className = "photo-item-time";
      time.textContent = formatTripLocalTime(photo.timeUTCms);
      meta.appendChild(time);

      if (photo.approximate) {
        const approx = document.createElement("div");
        approx.className = "photo-item-approx";
        approx.textContent = "~approximate";
        meta.appendChild(approx);
      }

      item.appendChild(meta);
      item.addEventListener("click", () => {
        window.tracker.map.panTo({ lat: photo.lat, lng: photo.lng });
        if (photo._marker) showPhotoInfoWindow(photo, photo._marker);
      });
      container.appendChild(item);
    });
}

function renderPhotosForDay(dayKey) {
  if (!window.tracker.photos) return;
  const dayPhotos = dayKey
    ? window.tracker.photos.filter((p) => p.dayKey === dayKey)
    : window.tracker.photos;
  renderPhotoMarkers(dayPhotos);
  renderPhotoList(dayPhotos);
}

async function initPhotos() {
  const container = document.getElementById("photo-list");

  if (!driveApiConfigured()) {
    container.innerHTML = '<p class="muted">Photo feed not configured — set DRIVE_API_KEY in photos.js.</p>';
    return;
  }

  container.innerHTML = '<p class="muted">Loading photos…</p>';

  try {
    const files = await fetchAllPhotoFiles();
    const sortedTrack = buildSortedTrack(window.tracker.trackData);

    const photos = [];
    files.forEach((file) => {
      const exifTime = file.imageMediaMetadata && file.imageMediaMetadata.time;
      if (!exifTime) return;

      const timeUTCms = exifTimeToUTCMillis(exifTime);
      if (timeUTCms === null) return;

      const location = matchPhotoLocation(timeUTCms, sortedTrack);
      if (!location) return; // no track data at all yet - can't place this photo

      photos.push({
        id: file.id,
        name: file.name,
        thumbnailLink: file.thumbnailLink,
        timeUTCms,
        dayKey: localDateKey(timeUTCms),
        lat: location.lat,
        lng: location.lng,
        approximate: location.approximate,
      });
    });

    window.tracker.photos = photos;
    renderPhotosForDay(window.tracker.currentDayKey);
  } catch (err) {
    console.error(err);
    container.innerHTML = '<p class="muted">Error loading photos — check console.</p>';
  }
}

document.addEventListener("tracker:data-loaded", () => {
  initPhotos();
});

document.addEventListener("tracker:day-selected", (e) => {
  renderPhotosForDay(e.detail.dayKey);
});
