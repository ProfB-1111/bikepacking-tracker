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
  trackPolyline: null,  // full-trip track Polyline (gray)
  dayPolyline: null,    // highlighted single-day segment (green)
  latestMarker: null,   // marker at the most recent track point
};

const DATA_BASE_PATH = "../data"; // adjust if index.html moves relative to /data

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

function trackFeaturesToPath(features) {
  return features
    .slice()
    .sort((a, b) => a.properties.timestamp.localeCompare(b.properties.timestamp))
    .map((f) => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
}

function renderFullTrack(map, geojson) {
  const path = trackFeaturesToPath(geojson.features);
  const polyline = new google.maps.Polyline({
    path,
    strokeColor: "#6b7478", // gray - matches --track-gray
    strokeOpacity: 0.8,
    strokeWeight: 3,
  });
  polyline.setMap(map);
  return polyline;
}

function renderLatestMarker(map, geojson) {
  if (!geojson.features.length) return null;

  const sorted = geojson.features
    .slice()
    .sort((a, b) => a.properties.timestamp.localeCompare(b.properties.timestamp));
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
    window.tracker.trackPolyline = renderFullTrack(map, trackData);
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
