#!/usr/bin/env python3
"""
Fetches the published route from Google My Maps (as KML) and converts it
to GeoJSON, overwriting data/route.geojson.

Run daily via .github/workflows/fetch-route.yml
"""

import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET

MY_MAPS_ID = os.environ.get("MYMAPS_ID", "1hEtjfG36Mllh9n_YwuIv_vZprvA6zLQ")
KML_URL = f"https://www.google.com/maps/d/kml?mid={MY_MAPS_ID}&forcekml=1"
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "route.geojson")


def strip_ns(tag):
    """Remove XML namespace prefix from a tag, e.g. '{ns}Placemark' -> 'Placemark'."""
    return tag.split("}")[-1] if "}" in tag else tag


def parse_coordinates(coord_text):
    """
    KML coordinates are 'lon,lat,alt lon,lat,alt ...' (space separated,
    comma separated per point). Returns a list of [lon, lat] pairs.
    """
    points = []
    for chunk in coord_text.strip().split():
        parts = chunk.split(",")
        if len(parts) >= 2:
            lon, lat = float(parts[0]), float(parts[1])
            points.append([lon, lat])
    return points


def kml_to_geojson(kml_bytes):
    root = ET.fromstring(kml_bytes)
    features = []

    for placemark in root.iter():
        if strip_ns(placemark.tag) != "Placemark":
            continue

        name = None
        geometry = None

        for child in placemark:
            tag = strip_ns(child.tag)

            if tag == "name":
                name = child.text

            elif tag == "Point":
                for c in child:
                    if strip_ns(c.tag) == "coordinates":
                        pts = parse_coordinates(c.text)
                        if pts:
                            geometry = {"type": "Point", "coordinates": pts[0]}

            elif tag == "LineString":
                for c in child:
                    if strip_ns(c.tag) == "coordinates":
                        pts = parse_coordinates(c.text)
                        if pts:
                            geometry = {"type": "LineString", "coordinates": pts}

            elif tag == "MultiGeometry":
                # Combine any LineStrings inside into one MultiLineString
                lines = []
                for sub in child.iter():
                    if strip_ns(sub.tag) == "LineString":
                        for c in sub:
                            if strip_ns(c.tag) == "coordinates":
                                pts = parse_coordinates(c.text)
                                if pts:
                                    lines.append(pts)
                if lines:
                    geometry = {"type": "MultiLineString", "coordinates": lines}

        if geometry:
            features.append({
                "type": "Feature",
                "properties": {"name": name},
                "geometry": geometry,
            })

    return {"type": "FeatureCollection", "features": features}


def main():
    print(f"Fetching route KML from: {KML_URL}")
    try:
        req = urllib.request.Request(KML_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            kml_bytes = resp.read()
    except Exception as e:
        print(f"ERROR fetching KML: {e}", file=sys.stderr)
        sys.exit(1)

    geojson = kml_to_geojson(kml_bytes)

    if not geojson["features"]:
        print("WARNING: No features parsed from KML. Route may be private, "
              "empty, or the KML structure has changed. Not overwriting "
              "existing route.geojson.", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(geojson, f, indent=2)

    print(f"Wrote {len(geojson['features'])} feature(s) to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
