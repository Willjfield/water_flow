#!/usr/bin/env bash
# Build an obstacle PMTiles archive from an OSM extract.
#
#   scripts/build-obstacles.sh <input.osm.pbf> <output.pmtiles> [minlon,minlat,maxlon,maxlat]
#
# Requires: osmium-tool, tippecanoe >= 2.17 (felt/tippecanoe, for .pmtiles output), python3.
# Extracts: https://download.geofabrik.de/ (or any planet/regional .osm.pbf).
set -euo pipefail

IN=${1:?usage: build-obstacles.sh <input.osm.pbf> <output.pmtiles> [bbox]}
OUT=${2:?usage: build-obstacles.sh <input.osm.pbf> <output.pmtiles> [bbox]}
BBOX=${3:-}
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

SRC=$IN
if [[ -n $BBOX ]]; then
  osmium extract --overwrite -b "$BBOX" --strategy smart "$IN" -o "$TMP/clip.osm.pbf"
  SRC=$TMP/clip.osm.pbf
fi

osmium tags-filter --overwrite "$SRC" \
  nwr/building \
  w/highway w/railway w/barrier w/waterway \
  w/embankment=yes w/man_made=embankment,dyke,levee \
  -o "$TMP/filtered.osm.pbf"

osmium export --overwrite -c "$HERE/osmium-export.json" -f geojsonseq \
  "$TMP/filtered.osm.pbf" -o "$TMP/raw.geojsonseq"

python3 "$HERE/classify_osm.py" < "$TMP/raw.geojsonseq" > "$TMP/obstacles.geojsonseq"

# z13-14 only: obstacles matter at building scale; the app overzooms z14 above that.
tippecanoe --force -o "$OUT" -l obstacles -n "water_flow obstacles" \
  -Z13 -z14 --read-parallel --quiet \
  --no-feature-limit --no-tile-size-limit --no-tiny-polygon-reduction \
  --simplification=2 --detect-shared-borders \
  "$TMP/obstacles.geojsonseq"

echo "wrote $OUT"
