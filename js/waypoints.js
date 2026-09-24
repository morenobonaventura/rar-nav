/**
 * Waypoints you saved yourself.
 *
 * The race course is shipped with the app and never changes; these are the
 * points you tapped on the water -- a lobster pot, a wind line, the corner you
 * want to round wide -- and they live in localStorage on the one phone that
 * saved them. Pure functions over a plain array, with the store injected, so
 * the rules can be tested without a browser and a full disk can never take the
 * app down with it.
 *
 * A stored waypoint is `{ id, name, lat, lon, at }`. Nothing here trusts what
 * comes back out of storage: it is a file on a phone that has been through
 * several versions of this app, and one bad record must not cost you the rest.
 */

export const WAYPOINTS_KEY = "rarnav.waypoints.v1";

const valid = (w) =>
  w != null &&
  typeof w.id === "string" &&
  typeof w.name === "string" &&
  Number.isFinite(w.lat) && Math.abs(w.lat) <= 90 &&
  Number.isFinite(w.lon) && Math.abs(w.lon) <= 180;

/** Everything readable in the store, worst case an empty list. */
export function loadWaypoints(store) {
  try {
    const raw = JSON.parse(store?.getItem(WAYPOINTS_KEY) ?? "null");
    return Array.isArray(raw) ? raw.filter(valid) : [];
  } catch {
    return []; // unreadable store, or JSON from a version that is long gone
  }
}

/** Returns false when the store refused it, so the UI can say so rather than
 *  show a list that will be gone at the next reload. */
export function saveWaypoints(list, store) {
  try {
    store.setItem(WAYPOINTS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false; // private mode, or a full disk
  }
}

/**
 * The next free `WP n`.
 *
 * Counted off the highest number in use rather than the length, so deleting WP
 * 2 out of three does not hand its name to the next point saved -- two marks
 * with the same name in a race is a mark you sail to twice.
 */
export function nextWaypointName(list) {
  const highest = list.reduce((max, w) => {
    const n = /^WP (\d+)$/.exec(w.name ?? "");
    return n ? Math.max(max, Number(n[1])) : max;
  }, 0);
  return `WP ${highest + 1}`;
}

/**
 * The list with `point` on the end, or unchanged if there is nothing to save.
 *
 * Refuses a point with no usable position instead of storing a null island:
 * 0°N 0°E is in the Gulf of Guinea, and a waypoint there would sit in the list
 * with a bearing and an ETA like any other.
 *
 * `now` is passed in rather than read here -- everything in this app takes its
 * time from `clock.now()`, so that a simulated track can be played through it.
 */
export function addWaypoint(list, point, now) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) return list;
  return [...list, {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: point.name ?? nextWaypointName(list),
    lat: point.lat,
    lon: point.lon,
    at: now,
  }];
}

/** The list without `id`. Unchanged if it was not there. */
export function removeWaypoint(list, id) {
  return list.filter((w) => w.id !== id);
}
