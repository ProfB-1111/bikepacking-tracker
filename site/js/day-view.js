/**
 * day-view.js
 *
 * Groups track points by local calendar day and lets the user click a
 * day to highlight that day's segment in green on the map.
 *
 * IMPORTANT: track.geojson timestamps are UTC (from the Garmin feed).
 * Set TIMEZONE_OFFSET_HOURS below to your trip's local offset so days
 * group correctly (e.g. -7 for Mountain Standard Time). If you cross
 * timezones mid-trip, this simple single-offset approach will need to
 * be revisited later (a per-date-range offset table would be the fix).
 */

const TIMEZONE_OFFSET_HOURS = -6; // Mountain Daylight Time — cross-checked against EXIF vs. Pixel filename UTC timestamps

// Uses getUTC*/setTime (not getHours/setHours) so the "local day" a
// timestamp falls on depends only on TIMEZONE_OFFSET_HOURS, not on the
// viewer's own browser timezone. Without this, two people watching the
// same trip from different timezones would see different day groupings.
function toLocalDate(utcTimestamp) {
  const d = new Date(utcTimestamp);
  return new Date(d.getTime() + TIMEZONE_OFFSET_HOURS * 3600000);
}

function localDateKey(utcTimestamp) {
  const d = toLocalDate(utcTimestamp);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function groupFeaturesByDay(features) {
  const groups = {};
  features.forEach((f) => {
    const key = localDateKey(f.properties.timestamp);
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  });
  return groups;
}

// preserveSelection: keep the currently-selected day active across a
// re-render (used when photos.js merges in photo-only days later) rather
// than always jumping back to the most recent day.
function renderDayList(groups, preserveSelection) {
  const container = document.getElementById("day-list");
  container.innerHTML = "";

  const sortedKeys = Object.keys(groups).sort();
  if (!sortedKeys.length) {
    container.innerHTML = '<p class="muted">No track data yet.</p>';
    return;
  }

  sortedKeys.forEach((key) => {
    const item = document.createElement("div");
    item.className = "day-item";
    const count = groups[key].length;
    item.textContent = count ? `${key} (${count} pts)` : `${key} (photos only)`;
    item.dataset.dayKey = key;
    item.addEventListener("click", () => selectDay(key, groups[key], item));
    container.appendChild(item);
  });

  const keyToSelect =
    preserveSelection && window.tracker.currentDayKey && groups[window.tracker.currentDayKey]
      ? window.tracker.currentDayKey
      : sortedKeys[sortedKeys.length - 1]; // otherwise auto-select the most recent day
  const itemToSelect = container.querySelector(`[data-day-key="${keyToSelect}"]`);
  selectDay(keyToSelect, groups[keyToSelect], itemToSelect);
}

function selectDay(dayKey, dayFeatures, itemEl) {
  // Update active styling
  document.querySelectorAll(".day-item").forEach((el) => el.classList.remove("active"));
  if (itemEl) itemEl.classList.add("active");

  const map = window.tracker.map;

  // Clear previous day highlight
  (window.tracker.dayPolylines || []).forEach((line) => line.setMap(null));

  // Split on the same gap heuristic as the full track (map-init.js) so a
  // day that happens to span a tracking-off/on gap doesn't draw a
  // spurious connecting line either.
  const sorted = sortedTrackFeatures(dayFeatures);
  const segments = splitIntoTrackSegments(sorted);

  window.tracker.dayPolylines = segments.map((segmentFeatures) => {
    const dayPolyline = new google.maps.Polyline({
      path: featuresToPath(segmentFeatures),
      strokeColor: "#4caf6a", // green - matches --track-green
      strokeOpacity: 1,
      strokeWeight: 4,
    });
    dayPolyline.setMap(map);
    return dayPolyline;
  });
  window.tracker.currentDayKey = dayKey;

  if (sorted.length) {
    const bounds = new google.maps.LatLngBounds();
    sorted.forEach((f) => bounds.extend({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
    fitBoundsClamped(map, bounds, 15);
  }

  // Let photos.js know which day is active, once photo matching exists
  document.dispatchEvent(new CustomEvent("tracker:day-selected", { detail: { dayKey } }));
}

document.addEventListener("tracker:data-loaded", () => {
  const groups = groupFeaturesByDay(window.tracker.trackData.features);
  window.tracker.dayGroups = groups;
  renderDayList(groups);
});

// Called by photos.js once photos are matched - folds in any day that has
// photos but no track points yet (e.g. days before the Fetch Track Action
// started polling) so those days are still visible and selectable.
window.tracker.addPhotoOnlyDays = function (dayKeys) {
  const groups = window.tracker.dayGroups || {};
  let changed = false;
  dayKeys.forEach((key) => {
    if (!groups[key]) {
      groups[key] = [];
      changed = true;
    }
  });
  window.tracker.dayGroups = groups;
  if (changed) renderDayList(groups, true);
};
