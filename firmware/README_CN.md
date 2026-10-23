# iscrcpy-firmware

[English](README.md) | [简体中文](README_CN.md)

## 配置

```sh
"$(dirname "$(command -v pio)")/python" -m pip install -r requirements.txt
cp nvs.example.csv nvs.csv
```

编辑 `nvs.csv`，填写 Wi-Fi、主机名和设备名。可选的 `access_token` 需要使用至少 16 个字符；留空表示不启用鉴权。

## 构建

```sh
pio run
```

## 首次烧录

```sh
SERIAL_PORT="<serial-port>"
pio run -e esp32-s3-n16r8-factory --target upload --upload-port "${SERIAL_PORT}"
```

## 更新固件

```sh
pio run --target upload --upload-port "${SERIAL_PORT}"
```

## 查看日志

```sh
pio device monitor --port "${SERIAL_PORT}"
```
