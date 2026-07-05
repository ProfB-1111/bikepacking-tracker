/**
 * map-init.js
 *
 * Loads route.geojson (planned route) and track.geojson (accumulating
 * GPS breadcrumb trail) and renders them on the map. Exposes shared
 * state on window.tracker so day-view.js, zoom-controls.js, and
 * photos.js can build on top of it.
 */

window.tracker = {
  map: null,
  routeData: null,      // raw GeoJSON for the planned route
  trackData: null,      // raw GeoJSON for the full track log
  routePolylines: [],   // rendered route Polyline objects
  trackPolylines: [],   // full-trip track Polylines (gray), one per segment
  dayPolylines: [],     // highlighted single-day segment Polylines (green), one per segment
  latestMarker: null,   // marker at the most recent track point
};

const DATA_BASE_PATH = "../data"; // adjust if index.html moves relative to /data

// Gaps longer than this split the track into separate segments instead of
// drawing a connecting line through them - e.g. driving between
// trailheads, or tracking manually turned off/on between rides. Garmin's
// feed doesn't expose a reliable "tracking off" event we could key off
// instead (it only ever surfaces the device's current status, not a
// history - see SETUP.md), so this time-gap heuristic is the fallback.
const TRACK_GAP_THRESHOLD_MINUTES = 75;

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load ${path}: ${res.status}`);
  }
  return res.json();
}

function setStatus(text) {
  const el = document.getElementById("status-line");
  if (el) el.textContent = text;
}

function renderRoute(map, geojson) {
  const polylines = [];

  geojson.features.forEach((feature) => {
    const { type, coordinates } = feature.geometry;

    const toLatLng = (pair) => ({ lat: pair[1], lng: pair[0] });

    if (type === "LineString") {
      const path = coordinates.map(toLatLng);
      const line = new google.maps.Polyline({
        path,
        strokeColor: "#3b82c4",
        strokeOpacity: 0.9,
        strokeWeight: 3,
      });
      line.setMap(map);
      polylines.push(line);
    } else if (type === "MultiLineString") {
      coordinates.forEach((lineCoords) => {
        const path = lineCoords.map(toLatLng);
        const line = new google.maps.Polyline({
          path,
          strokeColor: "#3b82c4",
          strokeOpacity: 0.9,
          strokeWeight: 3,
        });
        line.setMap(map);
        polylines.push(line);
      });
    }
    // Point-type route features (e.g. waypoints) could be added here
    // as markers later if useful.
  });

  return polylines;
}

function sortedTrackFeatures(features) {
  return features
    .slice()
    .sort((a, b) => a.properties.timestamp.localeCompare(b.properties.timestamp));
}

function featuresToPath(features) {
  return features.map((f) => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
}

// fetch_track.py stores the Garmin feed's ExtendedData "Event" field when
// present (e.g. "Tracking message received." vs "Tracking turned off from
// device."). Older points fetched before this was added won't have it -
// that's fine, it's only ever an extra reason to split, never required.
function isTrackingOffEvent(feature) {
  const event = feature?.properties?.event;
  return typeof event === "string" && /turned off/i.test(event);
}

// Splits chronologically-sorted features into separate segments wherever
// either (a) the time gap between consecutive points exceeds
// TRACK_GAP_THRESHOLD_MINUTES, or (b) the earlier point's Event field
// says tracking was turned off - so unrelated rides don't get a straight
// line drawn between them. The gap heuristic alone would miss a quick
// off/on cycle shorter than the threshold; the Event field alone would
// miss a gap with no clean "off" (dead battery, dead zone) - using both
// covers each other's blind spot.
function splitIntoTrackSegments(sortedFeatures) {
  const segments = [];
  let current = [];

  sortedFeatures.forEach((f, i) => {
    if (i > 0) {
      const prev = sortedFeatures[i - 1];
      const prevMs = new Date(prev.properties.timestamp).getTime();
      const thisMs = new Date(f.properties.timestamp).getTime();
      const gapMinutes = (thisMs - prevMs) / 60000;
      if (gapMinutes > TRACK_GAP_THRESHOLD_MINUTES || isTrackingOffEvent(prev)) {
        segments.push(current);
        current = [];
      }
    }
    current.push(f);
  });

  if (current.length) segments.push(current);
  return segments;
}

function renderFullTrack(map, geojson) {
  const segments = splitIntoTrackSegments(sortedTrackFeatures(geojson.features));

  return segments.map((segmentFeatures) => {
    const polyline = new google.maps.Polyline({
      path: featuresToPath(segmentFeatures),
      strokeColor: "#6b7478", // gray - matches --track-gray
      strokeOpacity: 0.8,
      strokeWeight: 3,
    });
    polyline.setMap(map);
    return polyline;
  });
}

function renderLatestMarker(map, geojson) {
  if (!geojson.features.length) return null;

  const sorted = sortedTrackFeatures(geojson.features);
  const last = sorted[sorted.length - 1];

  return new google.maps.Marker({
    position: { lat: last.geometry.coordinates[1], lng: last.geometry.coordinates[0] },
    map,
    title: `Last update: ${last.properties.timestamp}`,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 7,
      fillColor: "#c76b3e",
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 2,
    },
  });
}

// fitBounds() on a single-point (zero-area) bounds zooms all the way in
// (e.g. building-level), which looks broken for a one-point track or a
// single-day segment. Clamp to a sane max zoom after the fit resolves.
function fitBoundsClamped(map, bounds, maxZoom) {
  const listener = google.maps.event.addListenerOnce(map, "bounds_changed", () => {
    if (map.getZoom() > maxZoom) map.setZoom(maxZoom);
  });
  map.fitBounds(bounds);
  return listener;
}

function boundsFromRouteAndTrack(routeData, trackData) {
  const bounds = new google.maps.LatLngBounds();
  let hasPoints = false;

  const extend = (lat, lng) => {
    bounds.extend({ lat, lng });
    hasPoints = true;
  };

  (routeData?.features || []).forEach((f) => {
    const { type, coordinates } = f.geometry;
    if (type === "LineString") {
      coordinates.forEach((c) => extend(c[1], c[0]));
    } else if (type === "MultiLineString") {
      coordinates.forEach((line) => line.forEach((c) => extend(c[1], c[0])));
    } else if (type === "Point") {
      extend(coordinates[1], coordinates[0]);
    }
  });

  (trackData?.features || []).forEach((f) => {
    extend(f.geometry.coordinates[1], f.geometry.coordinates[0]);
  });

  return { bounds, hasPoints };
}

function fitToAllData(map, routeData, trackData) {
  const { bounds, hasPoints } = boundsFromRouteAndTrack(routeData, trackData);
  if (hasPoints) fitBoundsClamped(map, bounds, 15);
}

async function initMap() {
  const map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 20, lng: 0 }, // placeholder until data loads and fitBounds runs
    zoom: 2,
    mapTypeId: "terrain",
  });
  window.tracker.map = map;

  setStatus("Loading route and track data…");

  try {
    const [routeData, trackData] = await Promise.all([
      loadJSON(`${DATA_BASE_PATH}/route.geojson`),
      loadJSON(`${DATA_BASE_PATH}/track.geojson`),
    ]);

    window.tracker.routeData = routeData;
    window.tracker.trackData = trackData;

    window.tracker.routePolylines = renderRoute(map, routeData);
    window.tracker.trackPolylines = renderFullTrack(map, trackData);
    window.tracker.latestMarker = renderLatestMarker(map, trackData);

    fitToAllData(map, routeData, trackData);

    const pointCount = trackData.features.length;
    setStatus(pointCount ? `${pointCount} track point(s) logged` : "No track points yet");

    // Let other scripts (day-view.js) know the base data is ready
    document.dispatchEvent(new CustomEvent("tracker:data-loaded"));
  } catch (err) {
    console.error(err);
    setStatus("Error loading data — check console");
  }
}

// Exposed globally for the Google Maps API callback in index.html
window.initMap = initMap;
