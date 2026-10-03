# The iOS app

The same navigator, in a native shell, for the one thing a web app on an iPhone
cannot do: **keep recording with the screen off.**

Safari suspends a web app the moment the phone locks. Everything else in this
repository is built around that fact — the Awake toggle, the five-minute buffer
that reports its own holes, the honest "the app was in the background" note
under the history. None of it changes here. What changes is that CoreLocation
keeps running when the screen does not, so a recording started at the gun is
still being made at the finish with the phone in a pocket.

## What it is

A [Capacitor](https://capacitorjs.com) wrapper: the web app, unmodified, loaded
from the app bundle instead of a server, plus one native plugin.

Nothing was rewritten in Swift. The polar solver, the router, the charts, the
recordings and their 134 tests are the same files the browser runs — which is
the point. A Swift rewrite would have cost months and bought nothing the plugin
does not.

| | Browser | App |
|---|---|---|
| Position | `navigator.geolocation`, foreground only | CoreLocation, background |
| Screen awake | Wake Lock, if the browser agrees | the idle timer, which it does not get to refuse |
| Recording while locked | stops | continues, and is collected on the way back |
| CSV out | a download | the share sheet — AirDrop, Files, Mail |
| Storage | Safari's quota, evictable | the app's own, until the app is deleted |
| Simulator (`?sim=`) | allowed in a tab | barred, as it is on the home screen |

## Building it

You need a Mac with Xcode 15 or newer. Everything up to `cap sync` runs
anywhere; the rest is Apple's.

```sh
npm install
npm run build          # assembles www/ from the files a browser would be served
npx cap sync ios       # copies www/ into the app and resolves Swift packages
open ios/App/App.xcodeproj
```

In Xcode, once:

1. **Signing & Capabilities** → pick your team. Change the bundle identifier
   from `net.rarnav.app` if it clashes with something you own.
2. The **Background Modes → Location updates** capability. `Info.plist` already
   declares it (`UIBackgroundModes: location`); Xcode may want the checkbox
   ticked as well.
3. Run on the phone, not the simulator — the simulator has no satellites.

On first launch iOS asks for location. **Always** is the answer that matters:
"While Using" works for the chart but stops the moment the screen locks, which
is the whole reason for the app. iOS shows a blue indicator while it is
recording in the background; that is the system telling the truth about what the
app is doing, and it should be left alone.

For the crew's phones: Archive → Distribute → TestFlight. A free developer
account can sideload for seven days at a time, which is not long enough for a
season.

## How a recording survives a locked phone

Two paths, on purpose.

Fixes are handed to the WebView as they arrive, in the exact shape
`navigator.geolocation` uses, so everything above the plugin carries on
believing it is talking to a browser.

Fixes are **also** appended to `track-buffer.jsonl` in Application Support,
because the WebView is not guaranteed to be awake to receive them: iOS throttles
JavaScript hard in the background and will terminate the app outright under
memory pressure. That file is the record that survives. When the app comes back
up, `js/native.js` drains everything newer than the last sequence number it
stored and puts it in the open recording — on launch, on every return to the
foreground, and once more when Record is switched off, so the recording closes
with everything in it.

A drain is safe to repeat: it is keyed on a sequence number, not on deleting
what it read. The buffer trims itself to the last week.

Speed and course for drained fixes come from the chip or not at all. The live
path derives them from successive fixes when the chip reports none; a fix
drained an hour later has no neighbour it can honestly use, so those columns are
left empty in the CSV rather than invented.

## What has not been verified

Written on Linux, so **none of the Swift has been compiled or run**. The
JavaScript side is tested, including against a stand-in plugin that behaves like
the real one, and the whole native path has been driven end to end in a browser
with that stand-in — fixes to the instruments, a drain into a recording, the
share sheet, the simulator refusing to start. The Swift is first-build code and
should be read as such.

Two places to look first if it misbehaves:

- **The plugin is invisible to JavaScript.** Capacitor finds app-local plugins
  by scanning for `CAPBridgedPlugin` conformers. If `window.Capacitor.Plugins`
  has no `BackgroundTrack`, register it explicitly on the bridge in
  `AppDelegate`/`SceneDelegate` rather than fighting the scan.
- **Xcode does not see `BackgroundTrack.swift`.** It was added to
  `project.pbxproj` by hand here. If the target does not compile it, remove the
  reference and add the file again through File → Add Files to "App".

## Known limits

- **Termination is not recovery.** iOS can kill the app under memory pressure,
  and standard location updates do not relaunch it. Significant-change
  monitoring or region monitoring would, at the cost of accuracy — worth adding
  if a long race shows gaps.
- **No privacy manifest yet.** App Store submission needs
  `PrivacyInfo.xcprivacy` declaring the reason codes for the APIs used. TestFlight
  among a crew does not, which is what this is for.
- **The web app is untouched.** It still deploys as a PWA from the same files,
  still works offline, and still suspends when the screen locks. The app is the
  option for the phone that goes on deck, not a replacement for the page.
