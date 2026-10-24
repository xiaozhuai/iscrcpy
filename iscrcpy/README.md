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

The repository is currently a placeholder and has not been created. Until a Release
is published, an uncached download will fail clearly. For local development, set
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
checksums, archive safety, failure preservation and token handling. Since the
repository does not exist yet, real GitHub downloads cannot currently be tested.
