# iscrcpy-firmware

[English](README.md) | [简体中文](README_CN.md)

## Setup

```sh
"$(dirname "$(command -v pio)")/python" -m pip install -r requirements.txt
cp nvs.example.csv nvs.csv
```

Edit `nvs.csv` and provide the Wi-Fi credentials, hostname, and device name. The optional `access_token` must contain at least 16 characters; leave it empty to disable authentication.

## Build

```sh
pio run
```

## Initial flash

```sh
SERIAL_PORT="<serial-port>"
pio run -e esp32-s3-n16r8-factory --target upload --upload-port "${SERIAL_PORT}"
```

## Firmware updates

```sh
pio run --target upload --upload-port "${SERIAL_PORT}"
```

## View logs

```sh
pio device monitor --port "${SERIAL_PORT}"
```
