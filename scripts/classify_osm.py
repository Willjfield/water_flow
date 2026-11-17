#!/usr/bin/env python3
"""Reduce `osmium export` GeoJSONSeq to obstacle features for the water sim.

Every output feature carries `kind` (building | road | barrier | embankment |
waterway), `class` (the OSM value that selected it) and optionally `width` (m).
The runtime maps (kind, class) to flow blockage, bed raise/lowering and
Manning roughness, so physics can be tuned without rebuilding tiles.
"""
import json
import re
import sys

ROADS = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
    "residential", "living_street", "service", "pedestrian", "track",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
    "footway", "cycleway", "path", "busway",
}
RAILWAYS = {"rail", "light_rail", "tram", "narrow_gauge", "subway"}
BARRIERS = {"wall", "retaining_wall", "city_wall", "flood_wall", "fence", "hedge", "kerb", "jersey_barrier", "guard_rail"}
WATERWAYS = {"river", "stream", "canal", "drain", "ditch", "brook", "tidal_channel"}
OPEN_BUILDINGS = {"no", "roof", "carport", "canopy", "construction", "ruins"}


def parse_width(v):
    """OSM width in metres; accepts plain/metric values and feet ('10 ft', 10'6\")."""
    if not v:
        return None
    s = str(v).strip().lower()
    m = re.match(r"([0-9]+(?:\.[0-9]+)?)\s*'\s*(?:([0-9]+(?:\.[0-9]+)?)\s*\")?", s)
    if m:
        w = float(m.group(1)) * 0.3048 + float(m.group(2) or 0) * 0.0254
    else:
        m = re.match(r"([0-9]+(?:\.[0-9]+)?)\s*(ft|feet|foot)?", s)
        if not m:
            return None
        w = float(m.group(1)) * (0.3048 if m.group(2) else 1.0)
    return w if 0 < w < 200 else None


def elevated_or_buried(t):
    """Bridges/tunnels don't interact with surface flow."""
    return t.get("bridge", "no") != "no" or t.get("tunnel", "no") != "no" or t.get("covered") == "yes"


def classify(t, geom_type):
    poly = geom_type in ("Polygon", "MultiPolygon")
    line = geom_type in ("LineString", "MultiLineString")
    b = t.get("building")
    if poly and b and b not in OPEN_BUILDINGS and t.get("location") != "underground":
        return "building", b
    if not line:
        return None
    if t.get("embankment") == "yes" or t.get("man_made") in ("embankment", "dyke", "levee"):
        if t.get("bridge", "no") == "no":
            return "embankment", t.get("man_made") or t.get("highway") or t.get("railway") or "embankment"
    w = t.get("waterway")
    if w in WATERWAYS:
        # aqueducts and real tunnels don't touch the surface
        if t.get("bridge", "no") != "no" or t.get("tunnel", "no") not in ("no", "culvert"):
            return None
        # culverts carry water under roads, so they stay: they cut through raised road cells.
        return "waterway", ("culvert" if t.get("tunnel") == "culvert" else w)
    if t.get("barrier") in BARRIERS:
        return "barrier", t["barrier"]
    h = t.get("highway")
    if h in ROADS and not elevated_or_buried(t) and t.get("area") != "yes":
        return "road", h
    r = t.get("railway")
    if r in RAILWAYS and not elevated_or_buried(t):
        return "road", "rail"
    return None


def main():
    n_in = n_out = 0
    for raw in sys.stdin:
        raw = raw.strip().lstrip("\x1e")
        if not raw:
            continue
        n_in += 1
        f = json.loads(raw)
        g = f.get("geometry")
        if not g:
            continue
        t = f.get("properties") or {}
        c = classify(t, g["type"])
        if not c:
            continue
        props = {"kind": c[0], "class": c[1]}
        w = parse_width(t.get("width") or t.get("est_width"))
        if w:
            props["width"] = w
        sys.stdout.write(json.dumps({"type": "Feature", "geometry": g, "properties": props}, separators=(",", ":")) + "\n")
        n_out += 1
    print(f"classify_osm: {n_in} in, {n_out} obstacle features out", file=sys.stderr)


if __name__ == "__main__":
    main()
