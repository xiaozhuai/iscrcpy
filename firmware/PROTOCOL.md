# Protocol for iscrcpy-firmware

## Transport

- WebSocket URL: `ws://{hostname}:2786/control`
- Encoding: UTF-8 JSON text messages
- Protocol version: `1`
- Only one controller may hold the control lease at a time. Additional connections receive a `busy` error while
  that lease is active; an expired connection is disconnected and replaced by the new connection.
- A message sent by the controller must not exceed 512 bytes.

Within 3 seconds after the WebSocket connection is established, the controller must send this as its first message:

```json
{"type":"hello","protocol_version":1,"access_token":"..."}
```

An empty access token configured in NVS disables authentication. An invalid or unreadable NVS access-token setting
does not disable authentication: the firmware rejects the handshake with `configuration_error`. A non-empty configured
token must exactly match `access_token` in the handshake; otherwise the firmware replies with `unauthorized` and closes
the connection. The transport is not encrypted, so the token and control messages remain visible on the network; use
this protocol only on a trusted LAN. A controller should persist a supplied token only after it receives a matching
server `hello`, which confirms that authentication and protocol negotiation succeeded.

After authentication succeeds, the firmware validates `protocol_version`. When it does not match, the firmware sends
its own `hello`, sends `version_mismatch`, and closes the connection. The controller should compare the received
`protocol_version` as well: an older firmware protocol version means the firmware should be upgraded; a newer firmware
protocol version means the controller should be upgraded.

## Connection liveness and control lease

The server sends WebSocket protocol-level Ping control frames. WebSocket clients respond with Pong control frames
automatically; application code does not need to handle them. A Pong or any valid controller message renews the
3-second control lease.

If the lease expires, the server releases every pressed key and mouse button, then closes the connection. A new
connection may replace a controller whose lease has already expired.

The controller may send this optional application-level message to measure round-trip latency:

```json
{"type":"ping","seq":1}
```

The server replies with the same sequence number:

```json
{"type":"pong","seq":1}
```

This JSON exchange is not used as the sole connection-liveness mechanism.

## Server messages

After a successful handshake, the first server message is:

```json
{
  "type":"hello",
  "version":"0.1.0",
  "device_name":"iscrcpy-hw-001122aabbcc",
  "protocol_version":1
}
```

`version` is the firmware software version. `protocol_version` is the control protocol version used for compatibility
checks. `device_name` is the name currently configured on the firmware and should be used to update any saved device
name after authentication succeeds.

After `hello`, and whenever the USB or BLE connection state changes, the server sends:

```json
{"type":"status","usb_connected":true,"ble_connected":false}
```

The controller can also request the current HID connection state at any time:

```json
{"type":"get_status"}
```

The server replies:

```json
{"type":"status","usb_connected":true,"ble_connected":false}
```

After `hello`, the server sends the current boot's `current.log` one line at a time, followed by new log lines in
real time. Rotated `history-*.log` files are not sent:

```json
{"type":"log","message":"[I] Persistent log storage ready"}
{"type":"log","message":"[I] WebSocket controller connected from 192.168.1.10"}
```

Current and live messages use the same format and contain the complete plain-text log line, including its level prefix.

Errors use this format:

```json
{"type":"error","code":"invalid_key","message":"..."}
```

## Target

Input messages contain one of these targets:

- `usb_preferred`: use USB while a USB host is connected, otherwise use BLE; this is the default target
- `usb`: native USB HID only
- `ble`: Bluetooth LE HID only

For `usb_preferred`, release operations clear both transports so switching transports while an input is held does
not leave a key or mouse button stuck.

## Keyboard

`usage` is a USB HID Keyboard/Keypad usage ID, not an ASCII character or browser key code. Supported values are
`0x04`–`0x65` and modifiers `0xE0`–`0xE7`.

```json
{"type":"key","action":"down","usage":4,"target":"usb_preferred"}
{"type":"key","action":"up","usage":4,"target":"usb_preferred"}
```

The keyboard supports eight modifier usages (`0xE0`–`0xE7`) and up to six simultaneous non-modifier keys.

## Mouse

Relative movement, vertical wheel, and horizontal pan values must be integers from `-127` to `127`:

```json
{"type":"mouse_move","x":10,"y":-4,"wheel":0,"pan":0,"target":"usb_preferred"}
```

Mouse buttons are `left`, `right`, `middle`, `back`, or `forward`:

```json
{"type":"mouse_button","button":"left","pressed":true,"target":"usb_preferred"}
{"type":"mouse_button","button":"left","pressed":false,"target":"usb_preferred"}
```

## Release

Release all keyboard keys and mouse buttons for a target:

```json
{"type":"release_all","target":"usb_preferred"}
```

Controllers should send this message before closing and whenever they lose keyboard or mouse capture.
