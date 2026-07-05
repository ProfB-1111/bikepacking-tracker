/**
 * zoom-controls.js
 *
 * Wires up the "Whole route" and "Latest position" buttons.
 * Day-specific fitBounds is already handled in day-view.js when a day
 * is clicked.
 */

document.addEventListener("DOMContentLoaded", () => {
  const fitRouteBtn = document.getElementById("btn-fit-route");
  const fitTodayBtn = document.getElementById("btn-fit-today");

  fitRouteBtn.addEventListener("click", () => {
    const { map, routeData, trackData } = window.tracker;
    if (!map) return;

    const { bounds, hasPoints } = boundsFromRouteAndTrack(routeData, trackData);
    if (hasPoints) fitBoundsClamped(map, bounds, 15);
  });

  fitTodayBtn.addEventListener("click", () => {
    const { map, latestMarker } = window.tracker;
    if (!map || !latestMarker) return;
    map.setCenter(latestMarker.getPosition());
    map.setZoom(12);
  });
});
