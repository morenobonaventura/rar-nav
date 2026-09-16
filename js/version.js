/**
 * What build this is.
 *
 * The page is served out of the service worker's cache, so this constant --
 * cached along with everything else -- is the version of the app actually in
 * front of you, not the version on the server. That is the useful one: the
 * question it answers is "has the phone picked up the fix yet", asked on a
 * boat with no signal to check against.
 *
 * Keep it in step with CACHE in sw.js. They are bumped together, and the rail
 * would otherwise claim a build the phone is not running.
 */
export const VERSION = "v20";
