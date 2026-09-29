import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOnLand, crossesLand } from "../js/course.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const detail = read("../data/aeolian_coast.geojson");
const wide = read("../data/italy_coast.geojson");
/** What the app draws and checks against: the race at 15 m, the rest at ~500 m. */
const coast = { ...detail, features: [...detail.features, ...wide.features] };

const HOLE = wide.properties.excludes;
const inHole = (lon, lat) =>
  lon >= HOLE.lon_min && lon <= HOLE.lon_max && lat >= HOLE.lat_min && lat <= HOLE.lat_max;

test("the wide coastline is shaped the way the app reads it", () => {
  // isOnLand takes one outer ring per feature. A MultiPolygon or a hole here
  // would be read as a coastline it is not, quietly and only at sea.
  for (const f of wide.features) {
    assert.equal(f.geometry.type, "Polygon", "one polygon per feature");
    assert.equal(f.geometry.coordinates.length, 1, "outer ring only");
    assert.ok(f.geometry.coordinates[0].length >= 4, "a ring needs four points");
  }
  assert.ok(wide.properties.source.includes("OpenStreetMap"), "provenance travels with the data");
});

test("the wide coastline stops where the surveyed one starts", () => {
  // Every point on the chart comes from exactly one file, so the two can never
  // disagree about where the water is.
  for (const f of wide.features) {
    for (const [lon, lat] of f.geometry.coordinates[0]) {
      assert.ok(!inHole(lon + 1e-6, lat + 1e-6) || onHoleEdge(lon, lat),
        `${lon},${lat} is inside the detailed area`);
    }
  }
});

/** Points ON the cut line are the seam itself, which both files share. */
function onHoleEdge(lon, lat) {
  const e = 1e-4;
  return Math.abs(lon - HOLE.lon_min) < e || Math.abs(lon - HOLE.lon_max) < e
    || Math.abs(lat - HOLE.lat_min) < e || Math.abs(lat - HOLE.lat_max) < e;
}

test("the rest of Italy is now land the app knows about", () => {
  assert.ok(isOnLand({ lat: 40.8518, lon: 14.2681 }, coast), "Naples");
  assert.ok(isOnLand({ lat: 41.9028, lon: 12.4964 }, coast), "Rome");
  assert.ok(isOnLand({ lat: 39.2238, lon: 9.1217 }, coast), "Cagliari, so Sardinia is in");
  assert.ok(isOnLand({ lat: 38.1157, lon: 13.3615 }, coast), "Palermo");
  assert.ok(isOnLand({ lat: 45.4408, lon: 12.3155 }, coast), "Venice, at the top of the Adriatic");
});

test("open water is still open water", () => {
  assert.equal(isOnLand({ lat: 39.5, lon: 13.5 }, coast), null, "middle of the Tyrrhenian");
  assert.equal(isOnLand({ lat: 41.0, lon: 17.6 }, coast), null, "the Adriatic off Monopoli");
  assert.equal(isOnLand({ lat: 38.65, lon: 14.7 }, coast), null, "between the Aeolians, as before");
});

test("a line drawn across Italy knows it crosses it", () => {
  // Naples to Bari overland: the whole point of having the mainland at all.
  const hit = crossesLand({ lat: 40.7, lon: 14.1 }, { lat: 41.1, lon: 17.0 }, coast);
  assert.ok(hit, "a track from the Tyrrhenian to the Adriatic runs over land");
  assert.ok(hit.alongNm > 0, "and says how far along");
});

test("the bounding boxes the checks are sped up with agree with the long way round", () => {
  const slow = (pt) => {
    for (const f of coast.features) {
      const ring = f.geometry.coordinates[0];
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > pt.lat !== yj > pt.lat && pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi)
          inside = !inside;
      }
      if (inside) return f.properties.kind;
    }
    return null;
  };
  for (let lat = 36; lat <= 45; lat += 0.37) {
    for (let lon = 8; lon <= 18; lon += 0.41) {
      const pt = { lat, lon };
      assert.equal(isOnLand(pt, coast), slow(pt), `${lat.toFixed(2)},${lon.toFixed(2)}`);
    }
  }
});
