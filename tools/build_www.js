/**
 * Assemble www/ for the native build.
 *
 * Capacitor copies one directory into the app bundle. This app has no build
 * step on the web -- the files it serves are the files it was written in -- so
 * the "build" is a copy of exactly what a browser would be served, minus the
 * two files that only mean something to a browser: the service worker (the
 * bundle is already local and permanent) and the manifest (nothing installs an
 * app that is already installed).
 */
import { cp, rm, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "www");
const COPY = ["index.html", "css", "js", "data", "icons", "vendor"];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const name of COPY) await cp(join(ROOT, name), join(OUT, name), { recursive: true });
console.log(`www/ built from ${COPY.join(", ")}`);
