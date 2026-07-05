#!/usr/bin/env python3
"""
Fetches the Garmin inReach MapShare KML feed and appends any new track
points to data/track.geojson (a growing FeatureCollection of Point
features, each with a 'timestamp' property).

Run every 10-15 min via .github/workflows/fetch-track.yml

Note: this script runs server-side inside a GitHub Action, not in a
browser, so it is not subject to the CORS restrictions that block a
website's own JavaScript from fetching this feed directly.
"""

import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET

MAPSHARE_ID = os.environ.get("MAPSHARE_ID", "EBsMap")
FEED_URL = f"https://share.garmin.com/Feed/Share/{MAPSHARE_ID}"
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "track.geojson")


def strip_ns(tag):
    return tag.split("}")[-1] if "}" in tag else tag


def parse_point_coordinates(coord_text):
    """Returns [lon, lat] from a KML coordinates string, ignoring altitude."""
    parts = coord_text.strip().split(",")
    return [float(parts[0]), float(parts[1])]


def parse_extended_data_event(extended_data_el):
    """
    Pulls the value of <Data name="Event"><value>...</value></Data> out of
    a Placemark's <ExtendedData>, e.g. "Tracking message received." or
    "Tracking turned off from device." Returns None if not present.
    """
    for data_el in extended_data_el:
        if strip_ns(data_el.tag) != "Data" or data_el.get("name") != "Event":
            continue
        for v in data_el:
            if strip_ns(v.tag) == "value" and v.text:
                return v.text.strip()
    return None


def parse_feed(kml_bytes):
    """
    Returns a list of {timestamp, lon, lat, event} dicts, one per
    Placemark found in the Garmin feed that has both a Point and a
    TimeStamp. `event` is None if the Placemark has no ExtendedData
    Event field.
    """
    root = ET.fromstring(kml_bytes)
    points = []

    for placemark in root.iter():
        if strip_ns(placemark.tag) != "Placemark":
            continue

        timestamp = None
        lon_lat = None
        event = None

        for child in placemark:
            tag = strip_ns(child.tag)

            if tag == "TimeStamp":
                for c in child:
                    if strip_ns(c.tag) == "when":
                        timestamp = c.text.strip()

            elif tag == "Point":
                for c in child:
                    if strip_ns(c.tag) == "coordinates":
                        lon_lat = parse_point_coordinates(c.text)

            elif tag == "ExtendedData":
                event = parse_extended_data_event(child)

        if timestamp and lon_lat:
            points.append({
                "timestamp": timestamp,
                "lon": lon_lat[0],
                "lat": lon_lat[1],
                "event": event,
            })

    return points


def load_existing_track():
    if not os.path.exists(OUTPUT_PATH):
        return {"type": "FeatureCollection", "features": []}
    with open(OUTPUT_PATH, "r") as f:
        return json.load(f)


def main():
    print(f"Fetching track feed from: {FEED_URL}")
    try:
        req = urllib.request.Request(FEED_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            kml_bytes = resp.read()
    except Exception as e:
        print(f"ERROR fetching feed: {e}", file=sys.stderr)
        sys.exit(1)

    new_points = parse_feed(kml_bytes)
    if not new_points:
        print("No points found in feed (this is normal if the device "
              "hasn't reported recently).")
        return

    track = load_existing_track()
    existing_timestamps = {
        f["properties"]["timestamp"] for f in track["features"]
    }

    added = 0
    for p in new_points:
        if p["timestamp"] in existing_timestamps:
            continue
        properties = {"timestamp": p["timestamp"]}
        if p.get("event"):
            properties["event"] = p["event"]
        track["features"].append({
            "type": "Feature",
            "properties": properties,
            "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
        })
        existing_timestamps.add(p["timestamp"])
        added += 1

    if added == 0:
        print("No new points to add.")
        return

    # Keep the track sorted chronologically
    track["features"].sort(key=lambda f: f["properties"]["timestamp"])

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(track, f, indent=2)

    print(f"Added {added} new point(s). Track now has "
          f"{len(track['features'])} total point(s).")


if __name__ == "__main__":
    main()
