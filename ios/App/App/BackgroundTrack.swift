import Foundation
import Capacitor
import CoreLocation
import UIKit

/**
 The reason this app is native at all.

 Safari suspends a web app the moment the screen locks, which is why the web
 version has an Awake toggle and a five-minute buffer full of honest holes. Here
 CoreLocation keeps running with the phone in a pocket, and a recording made on
 the way to the first mark is still being made at the finish.

 Two things are kept separate on purpose.

 Fixes are handed to the WebView as they arrive, in the exact shape
 `navigator.geolocation` uses, so everything above this file -- the instruments,
 the solver, the recordings -- carries on believing it is talking to a browser.

 Fixes are ALSO appended to a file here, because the WebView is not guaranteed
 to be awake to receive them: iOS throttles JavaScript hard in the background
 and will terminate the app outright under pressure. The file is the record
 that survives; the WebView drains it on the way back up. Nothing in JavaScript
 is trusted to be running for the thing this app exists to do.
 */
@objc(BackgroundTrackPlugin)
public class BackgroundTrackPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "BackgroundTrackPlugin"
    public let jsName = "BackgroundTrack"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drain", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise)
    ]

    private let manager = CLLocationManager()
    private let queue = DispatchQueue(label: "net.rarnav.track", qos: .utility)
    /// Monotonic within a run of the app; the file carries it across runs.
    private var seq: Int = 0
    private var running = false
    private var pendingStart: CAPPluginCall?

    override public func load() {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        // Tells iOS this is a boat, not a walk to the shops: it stops trying to
        // be clever about pausing updates when the pattern looks stationary.
        manager.activityType = .otherNavigation
        manager.pausesLocationUpdatesAutomatically = false
        seq = lastSeqInBuffer()
    }

    // MARK: - the switch

    @objc func start(_ call: CAPPluginCall) {
        let status = CLLocationManager.authorizationStatus()
        switch status {
        case .notDetermined:
            // The answer arrives in the delegate, so the call is held until it does.
            pendingStart = call
            call.keepAlive(true)
            manager.requestAlwaysAuthorization()
        case .denied, .restricted:
            call.reject("Location is off for this app. Settings → RAR Nav → Location.")
        default:
            beginUpdates()
            call.resolve(["running": true, "authorization": name(for: status)])
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        running = false
        call.resolve(["running": false])
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve([
            "running": running,
            "authorization": name(for: CLLocationManager.authorizationStatus()),
            "buffered": seq
        ])
    }

    /// Keep the screen on. The web app asks the Wake Lock API for this and is
    /// often told no; here it is a property of the application.
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
        call.resolve(["awake": on])
    }

    private func beginUpdates() {
        guard !running else { return }
        // Only legal with the `location` background mode in Info.plist, and only
        // with Always authorization. Both are checked by the caller above.
        if CLLocationManager.authorizationStatus() == .authorizedAlways {
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = true
        }
        manager.startUpdatingLocation()
        running = true
    }

    private func name(for status: CLAuthorizationStatus) -> String {
        switch status {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "notDetermined"
        }
    }

    // MARK: - fixes

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for location in locations {
            seq += 1
            let fix = payload(for: location, seq: seq)
            append(fix)
            // Best effort: if the WebView is suspended this goes nowhere, which
            // is exactly why `append` happened first.
            notifyListeners("fix", data: fix, retainUntilConsumed: true)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        notifyListeners("error", data: ["message": error.localizedDescription])
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        guard let call = pendingStart else {
            notifyListeners("authorization", data: ["authorization": name(for: status)])
            return
        }
        if status == .notDetermined { return } // still waiting on the person
        pendingStart = nil
        call.keepAlive(false)
        if status == .denied || status == .restricted {
            call.reject("Location is off for this app. Settings → RAR Nav → Location.")
        } else {
            beginUpdates()
            call.resolve(["running": true, "authorization": name(for: status)])
        }
    }

    /// The shape `navigator.geolocation` hands a web page, so that nothing
    /// above this file has to know which one it is talking to.
    private func payload(for location: CLLocation, seq: Int) -> [String: Any] {
        [
            "seq": seq,
            "timestamp": location.timestamp.timeIntervalSince1970 * 1000,
            "coords": [
                "latitude": location.coordinate.latitude,
                "longitude": location.coordinate.longitude,
                // Negative means "no idea", which is a null to a web page.
                "accuracy": location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : NSNull(),
                "speed": location.speed >= 0 ? location.speed : NSNull(),
                "heading": location.course >= 0 ? location.course : NSNull()
            ]
        ]
    }

    // MARK: - the file the WebView drains

    private var bufferURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("track-buffer.jsonl")
    }

    /// One JSON object a line, appended. A line is written whole or not at all,
    /// so a kill mid-write costs the last fix and nothing before it.
    private func append(_ fix: [String: Any]) {
        queue.async { [bufferURL] in
            guard let data = try? JSONSerialization.data(withJSONObject: fix),
                  var line = String(data: data, encoding: .utf8) else { return }
            line += "\n"
            if let handle = try? FileHandle(forWritingTo: bufferURL) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: Data(line.utf8))
            } else {
                try? Data(line.utf8).write(to: bufferURL, options: .atomic)
            }
        }
    }

    /// Everything newer than `sinceSeq`, oldest first, and what to ask for next
    /// time. The caller is the only thing that knows what it already holds, so
    /// nothing is deleted here on its say-so -- the file is trimmed by age
    /// instead, and a drain is safe to repeat.
    @objc func drain(_ call: CAPPluginCall) {
        let since = call.getInt("sinceSeq") ?? 0
        let limit = call.getInt("limit") ?? 20000
        queue.async { [bufferURL] in
            var out: [[String: Any]] = []
            if let text = try? String(contentsOf: bufferURL, encoding: .utf8) {
                for line in text.split(separator: "\n") {
                    guard out.count < limit,
                          let data = line.data(using: .utf8),
                          let fix = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let s = fix["seq"] as? Int, s > since else { continue }
                    out.append(fix)
                }
            }
            let next = (out.last?["seq"] as? Int) ?? since
            DispatchQueue.main.async {
                call.resolve(["fixes": out, "nextSeq": next, "more": out.count >= limit])
            }
        }
    }

    /// Keeps the file from growing without end: everything older than a week
    /// goes, because by then it is either in the app's own recordings or it was
    /// never wanted.
    private func trimBuffer(olderThan days: Double = 7) {
        queue.async { [bufferURL] in
            guard let text = try? String(contentsOf: bufferURL, encoding: .utf8) else { return }
            let cutoff = Date().addingTimeInterval(-days * 86400).timeIntervalSince1970 * 1000
            let kept = text.split(separator: "\n").filter { line in
                guard let data = line.data(using: .utf8),
                      let fix = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let t = fix["timestamp"] as? Double else { return false }
                return t >= cutoff
            }
            try? (kept.joined(separator: "\n") + "\n").write(to: bufferURL, atomically: true, encoding: .utf8)
        }
    }

    private func lastSeqInBuffer() -> Int {
        guard let text = try? String(contentsOf: bufferURL, encoding: .utf8) else { return 0 }
        for line in text.split(separator: "\n").reversed() {
            if let data = line.data(using: .utf8),
               let fix = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let s = fix["seq"] as? Int { return s }
        }
        return 0
    }

    // MARK: - getting a CSV off the phone

    /// A WKWebView cannot hand the person a file the way a browser does, so the
    /// share sheet does it: AirDrop, Files, Mail, whatever is to hand.
    @objc func share(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let text = call.getString("text") else {
            call.reject("share needs a name and the text to put in the file")
            return
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            call.reject("could not write \(name): \(error.localizedDescription)")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let view = self?.bridge?.viewController else {
                call.reject("no view controller to present from")
                return
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            // An iPad needs somewhere to point the popover at.
            sheet.popoverPresentationController?.sourceView = view.view
            sheet.popoverPresentationController?.sourceRect = CGRect(
                x: view.view.bounds.midX, y: view.view.bounds.maxY, width: 0, height: 0)
            view.present(sheet, animated: true)
            call.resolve(["shared": true])
        }
    }

    // MARK: - lifecycle

    override public func willAppear() {
        trimBuffer()
    }
}
