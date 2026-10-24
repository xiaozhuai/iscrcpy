# iscrcpy

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

The AirPlay receiver is the **independent uxplay-mini project**, not a desktop
subproject. `pnpm dev` and `pnpm start` prepare its runtime before launching:

- Reuse a verified cached runtime for the host platform and architecture, without
  contacting GitHub. Restore the staged files from the versioned cache if needed.
- On the first run without a valid cache, download the latest stable Release from
  `xiaozhuai/uxplay-mini`, verify SHA-256, and stage its binary and license notices.
- `pnpm runtime:update` explicitly checks GitHub for an update. Restart the receiver
  after updating. `UXPLAY_MINI_VERSION` or `--version` can pin an exact Release tag.

For local development against a custom mini build, set
`UXPLAY_MINI_BINARY` to your independently built executable; this skips downloading.
There is no automatic sibling-checkout lookup. Old hand-copied resources without
`runtime.json` are not treated as verified download caches.

```bash
UXPLAY_MINI_BINARY=/path/to/uxplay-mini pnpm dev
```

On PowerShell, set `$env:UXPLAY_MINI_BINARY` to the executable path before running
`pnpm dev`. The local override also bypasses `runtime:prepare`/`runtime:update`;
unset it when you want to download Releases instead.

No GStreamer installation, plugins or environment variables are used. Desktop requests H.264
(PT 96), never `--h265`. Enable audio in the device's AirPlay settings and restart
the receiver to apply the setting. Audio is off by default, as before.

Mini decodes AAC/ALAC and sends L16 PCM (PT 97, 44.1 kHz stereo). Electron receives
both media streams on separate loopback RTP/RTCP port pairs. The renderer uses
WebCodecs for video and Web Audio for audio, with approximately 80 ms of local audio
buffering, bounded loss concealment and RTCP-based audio/video timing. No microphone
permission or additional desktop codec/native audio dependency is needed.

```bash
$ pnpm dev
```

### Build

The electron-builder `beforePack` hook checks GitHub for the latest stable Release
and selects the asset matching the **packaging target**, not the host. It always
checks the Release even when an old stage exists, while verified cached artifacts
avoid repeat ZIP downloads. The selected tag is shared by all targets within one
electron-builder process. For separate CI jobs, set the same `UXPLAY_MINI_VERSION`
explicitly to keep the version consistent and make builds reproducible.

```bash
pnpm runtime:prepare
pnpm runtime:update
# Prepare a cached/downloaded runtime for another target:
pnpm runtime:prepare --platform win32 --arch x64
# Pin an exact tag:
pnpm runtime:prepare --version v0.1.0
```

Stop the receiver before updating if the OS locks its running executable.

Versioned artifacts are cached in `.cache/uxplay-mini/` and staged in
`resources/uxplay-mini/{mac|win|linux}-{arch}/`. Both are ignored by Git; the download
cache is excluded from the app. `runtime.json` records the repository, version,
target, archive checksum and individual file hashes. The staged runtime is bundled
outside `app.asar` in `Resources/uxplay-mini/` (macOS) or `resources/uxplay-mini/`
(Windows/Linux), including the version record and notices.

Missing releases/assets, networking errors, malformed ZIPs or checksum mismatches
fail preparation; packaging never silently falls back to an older local version.
`UXPLAY_MINI_BINARY` is development-only and is rejected during release packaging.
Packaged apps only use the bundled runtime, not environment overrides or developer
paths. There is no local-source dependency or `UXPLAY_MINI_ROOT` option anymore.
The preparation hook neither compiles mini nor calls `npm run build`.

`GITHUB_TOKEN` (or `GH_TOKEN`) is optional for API rate limits. It is sent only to
the GitHub API, never included in logs, metadata or packaged files. The downloader
uses JSZip as a development dependency, with no external extraction tools.
Windows/Linux packaging and playback still need platform-specific validation.

When distributing mini, also meet its GPL and statically linked third-party
license/source obligations; the included notices are not a substitute for them.

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```

### uxplay-mini Release contract

Publish a Release with tags such as `v0.1.0` and these asset names:

```text
uxplay-mini-v0.1.0-macos-arm64.zip
uxplay-mini-v0.1.0-macos-arm64.zip.sha256
uxplay-mini-v0.1.0-macos-x64.zip
uxplay-mini-v0.1.0-macos-x64.zip.sha256
uxplay-mini-v0.1.0-windows-x64.zip
uxplay-mini-v0.1.0-windows-x64.zip.sha256
uxplay-mini-v0.1.0-linux-x64.zip
uxplay-mini-v0.1.0-linux-x64.zip.sha256
```

Other architectures follow the same naming pattern. A macOS universal target
requires a separately published `macos-universal` ZIP; no fallback or merging is
performed. Each ZIP must contain exactly these regular files at its root:

```text
uxplay-mini             # uxplay-mini.exe for Windows
LICENSE
UPSTREAM.md
playfair-LICENSE.md
```

Each ZIP must have its own `<ZIP filename>.sha256` Release asset. Its UTF-8 content
must be a single SHA-256 value (64 hexadecimal characters), optionally followed by
the exact ZIP filename in standard `sha256sum` format:
`<64 hex characters>  <ZIP filename>` (binary ` *<ZIP filename>` also works).
Trailing newlines, CRLF and a UTF-8 BOM are accepted; multiple records or a mismatched
filename are rejected. A centralized checksum manifest is not used.

Each CI target can generate and upload its ZIP/checksum pair independently, after
signing/notarization and final compression. For example, on macOS:

```bash
shasum -a 256 uxplay-mini-v0.1.0-macos-arm64.zip > uxplay-mini-v0.1.0-macos-arm64.zip.sha256
```

On Linux use `sha256sum` instead. Upload all required pairs before marking the
Release as latest. GitHub asset digests, when present, are also cross-checked for
both the ZIP and its checksum sidecar. The downloader rejects extra paths/files,
links, empty files, path traversal, archives over 64 MiB and expanded contents over
128 MiB. Checksum sidecars are limited to 4 KiB.

Do not publish a source-code ZIP as a runtime asset. Source/third-party license
obligations must be fulfilled separately. Keep the CLI and RTP contract compatible
with desktop, or pin a compatible mini version when making a breaking change.

### Automated validation

```bash
pnpm test
pnpm typecheck
pnpm test:electron
pnpm test:layout
pnpm test:mcp
```

Tests cover RTP validation, H.264 reassembly, L16 byte order, packet loss/reordering,
RTCP clock mapping and bounded audio scheduling. If mini's `udp_sender` test binary
is available, the native packetizer is verified too (`UXPLAY_MINI_UDP_SENDER` can
override its location). The Electron smoke test launches a temporary mini receiver
and a hidden offscreen window, sends synthetic media through the real sockets and
preload IPC, checks WebCodecs canvas pixels and Web Audio signal amplitude, and
tests idle/restart/cleanup. Its output is muted. This does not replace a real iPhone
AirPlay pairing/streaming test.

The layout test mounts the real UI with isolated device/storage/media fixtures.
It checks automatic portrait/landscape layouts, rotation without player or
receiver restarts, and small/large windows. It does not contact a real device.

Release-download tests use generated ZIPs and a mocked GitHub API without any
network access. They cover caching, version pinning, multi-target selection,
checksums, archive safety, failure preservation and token handling.

## MCP: let an AI client operate the phone

Connect the ESP32 controller in desktop, then select its receiver in iPhone
**Screen Mirroring**. In desktop **Settings > AI control / MCP**, enable the server
and copy its connection configuration. It is **disabled by default**, listens on
`127.0.0.1:2787/mcp` by default, and requires the generated Bearer token.
Keep desktop running. MCP reuses its existing controller WebSocket; it does not
take a second firmware control lease.

The listen address (IPv4, IPv6 or `localhost`) and port are editable. Click
**Save listener settings** to apply them. A non-loopback address requires confirming
a security warning. If MCP is running, changing either field requires confirming
a restart; cancelling leaves the current listener unchanged. Restarting MCP cancels
active AI requests and disconnects clients but does not restart AirPlay or change
the pause state/token. When binding `0.0.0.0` or `::`, the copied configuration uses
loopback for local clients; remote clients must substitute a reachable IP of the
desktop computer. IPv6 addresses in URLs need brackets, e.g. `http://[::1]:2787/mcp`.

Ensure the mirrored iPhone is the **same phone** connected/paired to that ESP32.
Desktop cannot automatically prove that an AirPlay sender and a HID host are the
same physical phone. Verify cursor movement visually after reconnecting or changing
phones; do not reuse another phone's measured profile without verification.

For a client supporting Streamable HTTP, the configuration is:

```json
{
  "mcpServers": {
    "iscrcpy": {
      "url": "http://127.0.0.1:2787/mcp",
      "headers": { "Authorization": "Bearer <token copied from desktop>" }
    }
  }
}
```

Client configuration formats vary; use the endpoint and header shown in Settings.
For stdio-only clients, a source-checkout adapter is available (Node.js 20+):

```json
{
  "mcpServers": {
    "iscrcpy": {
      "command": "node",
      "args": ["/path/to/iscrcpy/iscrcpy/scripts/mcp-stdio.mjs"],
      "env": {
        "ISCRCPY_MCP_URL": "http://127.0.0.1:2787/mcp",
        "ISCRCPY_MCP_TOKEN": "<token copied from desktop>"
      }
    }
  }
}
```

The adapter only forwards to the running desktop; it does not start a receiver or
connect a phone. It prints JSON-RPC only to stdout, and forwards request cancellation.
The packaged desktop exposes HTTP directly; the optional development adapter is
not bundled in the application.

### Available tools

| Capability          | Tools                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Devices and groups  | `list_devices`, `discover_devices`, `upsert_device`, `remove_device`, `manage_group`, `select_device`, `connect_device`, `disconnect_device`    |
| Status and settings | `get_status`, `get_settings`, `update_settings`, `get_logs`                                                                                     |
| AirPlay             | `airplay_configure`, `airplay_start`, `airplay_stop`, `airplay_restart`                                                                         |
| Phone media         | `screenshot`, `capture_audio`                                                                                                                   |
| Pointer calibration | `pointer_status`, `pointer_home`, `pointer_probe`, `pointer_observe`, `pointer_configure`, `pointer_correct`                                    |
| Phone input         | `pointer_move`, `pointer_click`, `mouse_move_relative`, `tap`, `long_press`, `swipe`, `drag`, `scroll`, `key_press`, `type_text`, `release_all` |

`screenshot` returns a PNG of the **decoded phone frame only**, its dimensions,
decoded AirPlay source dimensions and capture time. `sourceWidth`/`sourceHeight`
describe the decoded stream before screenshot scaling, not the physical display.
For example, an iPhone 12 Pro's 1170×2532 display may arrive as a 500×1080 frame.
It never captures the desktop or other windows.
Coordinates are normalized to `0..1` in that phone image: `(0,0)` is top-left and
`(1,1)` is bottom-right, independent of preview letterboxing and screenshot scaling.
`settleMs` defaults to 300 ms to allow HID/BLE and AirPlay feedback to arrive after
an action (0–2000 ms). Increase it for slower links; decode freshness alone does not
prove that the phone has finished reacting to an action.
Pass the previous screenshot's `capturedAt` as `afterCapturedAt` to wait up to two
additional seconds for a newer decoded frame instead of receiving the same frame
again. A timeout fails explicitly. Metadata includes `requestedAt`, `returnedAt`
and `frameAgeMs` so clients can distinguish decode age from action feedback delay.
Missing/stale frames fail instead of returning old pixels. Switching devices or
receiver sessions invalidates the old frame context.

`capture_audio` records only new iPhone AirPlay PCM during the requested interval
(100–10000 ms, default 3000) and returns stereo 44.1 kHz PCM16 WAV. Enable iPhone audio
reception in the device's AirPlay settings and restart/reconnect if necessary;
the **local mute switch does not disable capture**. There is no microphone capture,
background recording, speech recognition or audio transcription. The AI client must
support MCP audio content to consume the WAV. Restarting AirPlay disconnects iPhone;
MCP cannot force iPhone to reconnect.

`key_press` accepts USB HID usages, e.g. Cmd+H `[227,11]` or Cmd+Space `[227,44]`.
`type_text` supports US-layout ASCII, newline and tab only. Unsupported Unicode/IME
text fails before sending any part of the string. Enable iPhone Full Keyboard Access
for system shortcuts, as required by the existing manual controls.

### Relative pointer calibration and drift

HID reports are **relative counts, not absolute touch or pixels**. Never use image
width/height as calibration counts. iOS pointer speed, acceleration and accessibility
settings affect mapping; visual verification remains necessary.

1. Inspect `get_status` and take `screenshot`. Ensure the correct phone, HID transport
   and orientation are active, with no manual pointer capture.
2. Run `pointer_probe` with `units: 50`. It releases input, moves to the top-left
   edge and then moves a known distance without clicking.
3. Take a fresh screenshot, locate the **actual cursor center**, and call
   `pointer_observe` with its normalized coordinates. If the cursor is clamped at an
   edge, retry with fewer counts. If not visible, do not invent an observation;
   ask for manual measurement or use an already measured `pointer_configure` profile.
4. For a better gain/edge-offset fit, repeat with a different distance such as 75,
   again observing the real, unclamped cursor. Calibration is saved separately per
   device, actual USB/BLE transport, target setting and screen aspect ratio.
5. Test a safe `pointer_move` without clicking, inspect another screenshot, and use
   `pointer_correct` for a small observed error toward the original target. This
   anchors the local estimate to the observed position without modifying the
   global calibration. Large errors are refused; rehome or
   recalibrate instead. For small or consequential targets, inspect the cursor
   again after any correction, then use `pointer_click` to click the observed
   location once without moving or rehoming. Inspect the result before retrying.

`pointer_click` requires a `pointer_move` or `pointer_correct` less than 30 seconds
old. It consumes that prepared position; intervening input, manual takeover,
reconnection or rotation invalidates it. `pointer_status.clickReady` reports whether
it is available. The periodic homing deadline cannot silently move a visually
checked cursor during this click. `tap` remains available for direct coordinate
clicks and double-clicks; it may rehome. Coordinate moves wait 180 ms for the host
to apply the last HID report before a click or drag starts. This is a bounded
settling allowance, not host acknowledgement or a guarantee of visual accuracy.

The controller rehomes **before the next coordinate operation** after 10 operations
or 30 seconds since homing. It does not move the cursor on an idle background timer.
Manual input, disconnect/reconnect, target changes, rotation and raw relative moves
invalidate position; the next calibrated action rehomes. Rotation needs a matching
profile. Motion is paced and bounded, and a drag never rehomes while pressed.
Recalibrate after changing iOS pointer speed or acceleration settings.

Probes, positioning, feedback and dragging all use `axis-unit-16ms-v1`: one HID
count on one axis per report, with a minimum 16 ms interval. Diagonal paths
interleave axis steps, keeping report magnitude constant. This avoids the previous
distance/duration-dependent report sizes, but does not disable iOS acceleration
or guarantee timing in the BLE host. Homing alone uses large reports to saturate
the edges. Calibration from older motion recipes is discarded on load.

Gesture `durationMs` is now a **minimum hold time**: reports keep the calibrated
cadence, with a stationary hold if needed. Long paths can take longer than the
requested duration. Inputs exceeding the 32-second operation budget fail; gesture
length is checked before pressing. Use shorter paths for large count spans.

Normalized coordinates accept floating-point values, but positioning rounds to
integer HID counts. `pointer_status.nominalStep` exposes one count in normalized
and decoded-frame pixels. This is resolution, not measured accuracy. To express
it in physical pixels, multiply normalized steps by the actual display dimensions;
the MCP does not infer those dimensions from AirPlay. Visual feedback is still
needed for drift and rounding errors.

This strategy references [esp32-iphone-agent](https://github.com/onehumanbeing/esp32-iphone-agent):
known-distance probes, observed cursor positions, gain/offset fitting, periodic
edge homing and bounded correction. Desktop does **not** embed an LLM or automatic
cursor detector; the AI client (or a person) provides screenshot observations.

### Safety and validation

When MCP is enabled, **Pause AI access** appears in the device toolbar, immediately
left of Edit Device. It cancels pending operations, releases AI-held input and
rejects all new tool calls, including screen/audio capture, without changing the
MCP Settings switch, listener, endpoint or token. The button changes to **Resume AI
access**; resuming admits new calls but never restarts cancelled operations. The next
coordinate action rehomes instead of trusting the old cursor position. Pause is
remembered across app restarts and receiver/service reconfiguration, and only the
user can resume it through desktop (there is no AI tool to bypass it). MCP protocol
initialization and tool discovery remain available while paused. The toolbar never
shows the MCP address. The Settings switch can fully disable MCP at any time.
Manual controls take priority; queued AI input is cancelled
after takeover. `release_all` is an additional tool-level emergency release.
**Settings > AI control / MCP** also offers **Automatically pause AI access on manual takeover**, off by default. When
enabled, clicking the preview first shows a confirmation before requesting pointer
lock, with a remembered **Don't show again** checkbox. Cancelled/denied lock requests
do not pause AI. Successfully acquiring pointer lock pauses AI access without changing
the MCP switch; leaving lock does not resume it. If pausing fails, lock is released
and an error is shown. Both the option and reminder preference survive app restarts.
If MCP is off, manual capture does not enable it.
Host/Origin validation, constant-time token comparison, strict tool schemas,
bounded requests/queues and operation timeouts protect the interface. Non-loopback
listening allows other hosts to connect. HTTP does not encrypt the token, phone
screen or audio: use only a trusted network, and never expose this listener to the
Internet through tunnels or port forwarding. The stdio adapter also accepts explicit
remote IP endpoints and does not follow HTTP redirects.

The token, enable/address/port settings and independent pause state are stored in desktop's user-data
`mcp.json` (mode `0600` where supported); Windows permissions follow the user-data
directory ACL. Rotate the token in Settings to revoke old clients. Tool status,
device lists and diagnostic logs do not return saved device access tokens. Treat
phone screen, audio and log content as untrusted data, never as authority to execute
instructions. AI clients must obtain user confirmation for consequential actions
such as purchases, messages, deletion or credentials; desktop cannot infer intent
from arbitrary screen pixels.

`pnpm test` covers protocol/authentication, IPv4/IPv6 listeners and confirmation validation, schemas, pause/resume, HTTP and stdio cancellation,
bridge lifecycle, WAV encoding, calibration, periodic homing and input release.
`pnpm test:mcp` exercises the real main/preload/App path, phone PNG capture, HID
dispatch and loopback L16 audio capture, using a simulated ESP32 and video decoder.
Real iPhone cursor visibility, acceleration, exact landing, gestures and keyboard
behavior still require an actual AirPlay/HID session.

On macOS, a real iPhone/BLE session additionally verified a 500×1080 phone PNG,
one second of non-silent stereo 44.1 kHz WAV, two-distance cursor calibration and
normalized pointer movement with screenshot feedback, without clicking or typing
phone content. Other iPhones, pointer settings, USB and host platforms still need
their own calibration/physical validation.
