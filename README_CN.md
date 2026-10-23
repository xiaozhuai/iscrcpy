# iscrcpy

[English](README.md) | [简体中文](README_CN.md)

iscrcpy 用于通过局域网将 iPhone 屏幕镜像到桌面电脑，并控制 iPhone。ESP32-S3
硬件桥接器通过 WebSocket 接收键盘和鼠标事件，再以 USB HID 或蓝牙 LE HID 设备的形式
转发给 iPhone。AirPlay 屏幕镜像由独立管理的 UxPlay sidecar 提供，并直接显示在桌面应用中。

桌面端提供局域网设备发现、设备库、连接管理、实时屏幕预览、输入捕获、固件与
AirPlay 日志，以及全局连接设置。

![](screenshots/img_1.png)

## 工作原理

```text
iPhone
  |
  | 局域网 AirPlay
  v
UxPlay sidecar（-vrtp）
  |
  | 本机 UDP 上的 H.264 RTP
  v
Electron 主进程
  |
  | 编码视频帧
  v
WebCodecs 解码器 -> 预览 Canvas

Electron
  |
  | WebSocket + JSON，端口 2786
  v
ESP32-S3 固件
  |
  +---- USB HID ------> iPhone
  |
  +---- BLE HID ------> iPhone
```

固件通过 mDNS 广播 `_iscrcpy-control._tcp` 服务。桌面端可以自动发现设备，也可以手动填写
主机名和端口。键盘与鼠标输入使用 USB HID usage 格式发送，并可在 USB、蓝牙以及
“USB 优先”模式之间切换。硬件控制连接成功后，桌面端会启动名为
`iscrcpy for {设备名}` 的 AirPlay 接收服务。

## 仓库结构

| 路径                    | 说明                                          |
| ----------------------- | --------------------------------------------- |
| `iscrcpy/`              | 基于 Electron、React 和 TypeScript 的桌面应用 |
| `firmware/`             | 基于 PlatformIO 的 ESP32-S3 固件              |
| `firmware/PROTOCOL.md`  | WebSocket 协议与 HID 消息参考                 |
| `firmware/README_CN.md` | 固件构建和烧录说明                            |

## 环境要求

### 硬件

- 只需要一块 ESP32-S3 开发板。兼容的 N16R8 开发板（16 MB Flash、OPI PSRAM）
  常见售价约为 4 美元 / 28 元人民币。
- 用于首次烧录和 USB HID 的 USB 数据线及数据接口。
- iPhone、支持设备通信的 2.4 GHz Wi-Fi 网络和一台桌面电脑。
- ESP32-S3 与桌面电脑位于同一局域网。

### 软件

- [PlatformIO Core](https://platformio.org/)，用于构建和烧录固件。
- Node.js 和 [pnpm](https://pnpm.io/)，用于运行桌面应用。
- Electron 支持的 Windows、macOS 或 Linux 桌面环境。

桌面应用会随硬件控制连接启动和停止 UxPlay，并通过 `-vrtp` 将 H.264 RTP 发送到
本机 UDP 端口。UxPlay 不会打开原生播放窗口；Electron 主进程负责 RTP 解包，
渲染进程使用 WebCodecs 解码并绘制到现有预览区域。

### iPhone 设置

首次使用组合键前，需要开启 iPhone 的完整键盘访问。设置路径取决于 iOS 版本：

- iOS 26 及更新版本：**设置 > 辅助功能 > 键盘与输入**
- 较旧 iOS 版本：**设置 > 辅助功能 > 键盘**

还需要开启 **设置 > 辅助功能 > 触控 > 辅助触控**。第一次打开应用内的系统操作菜单时，
也会显示这些设置提示。

## 配置和烧录固件

在仓库根目录执行：

```bash
cd firmware
cp nvs.example.csv nvs.csv
```

Windows 用户可以在文件资源管理器中复制 `nvs.example.csv` 并重命名为 `nvs.csv`。
然后编辑 `nvs.csv`，填写以下 NVS 配置：

| 字段            | 必填 | 说明                                                     |
| --------------- | ---- | -------------------------------------------------------- |
| `wifi_ssid`     | 是   | Wi-Fi 名称，最多 32 字节                                 |
| `wifi_password` | 是   | 空值、8–63 字节密码，或 64 位十六进制 PSK                |
| `hostname`      | 否   | `<hostname>.local` 使用的 DNS 标签，默认由芯片 ID 生成   |
| `device_name`   | 否   | HID 和 mDNS 显示名称，最多 28 字节，默认与 hostname 相同 |
| `access_token`  | 否   | 16–128 个可打印 ASCII 字符；留空表示不启用鉴权           |

请把 Python 依赖安装到 PlatformIO 所使用的 Python 环境：

```bash
"$(dirname "$(command -v pio)")/python" -m pip install -r requirements.txt
```

首次烧录时，同时写入固件和生成的 NVS 分区：

```bash
pio run -e esp32-s3-n16r8-factory --target upload --upload-port <serial-port>
```

常见串口名称为 macOS 的 `/dev/cu.usbmodem*`、Linux 的 `/dev/ttyACM*`，以及 Windows 的
`COMx`。后续更新固件可以使用默认环境：

```bash
pio run --target upload --upload-port <serial-port>
```

查看串口日志：

```bash
pio device monitor --port <serial-port>
```

更多固件说明见 [firmware/README_CN.md](firmware/README_CN.md)，通信协议见
[firmware/PROTOCOL.md](firmware/PROTOCOL.md)。

## 启动桌面应用

```bash
cd iscrcpy
pnpm install
pnpm dev
```

首次安装会下载 Electron，并执行原生依赖配置。

## 使用方法

1. 给 ESP32-S3 供电，确认它和桌面电脑连接到同一网络。
2. 打开桌面应用，等待 mDNS 自动发现设备；也可以选择手动填写主机名或 IP 地址，
   端口使用 `2786`，如果固件启用了鉴权则填写 Access Token。
3. 保存并选中设备，然后点击“连接”。
4. 在 iPhone 控制中心打开“屏幕镜像”，选择 `iscrcpy for {设备名}`。
   如果 iOS 控制中心没有显示该入口，可在 **设置 > 控制中心** 中添加“屏幕镜像”。
5. 等待 iPhone 画面出现在 iScrcpy 预览区。点击预览区域可锁定键盘和鼠标；
   按 `Esc` 释放输入并退出控制，当前控制状态会显示在设备标题栏中。
6. 在“设置”中选择全局发送目标：“USB 优先”、“仅 USB”或“仅蓝牙”。
   自动重连及其间隔也在该页面中全局配置。
7. 通过设备操作菜单发送常用 iPhone 系统组合键。首次使用时，应用会提示所需的
   iPhone 辅助功能设置。

设备等待投屏时会显示三步设置指引。前两步标注为每台设备仅需一次，屏幕镜像则标注为
每次连接都需要。

设备信息面板会显示固件版本、协议版本、画面比例、USB 与蓝牙连接状态、延迟，
以及合并后的固件日志和 AirPlay 日志。

## 构建与检查

检查桌面工程：

```bash
cd iscrcpy
pnpm typecheck
pnpm lint
pnpm build
```

生成各平台安装包：

```bash
pnpm build:win
pnpm build:mac
pnpm build:linux
```

构建两个固件版本：

```bash
cd firmware
pio run -e esp32-s3-n16r8
pio run -e esp32-s3-n16r8-factory
```

## 安全说明与限制

- 控制连接使用未加密的 `ws://`，Access Token 和输入消息可能在网络上被观察到。
  请仅在可信局域网中使用 iscrcpy。
- 固件同一时间只允许一个控制端持有控制租约。新连接可以替换已经过期的旧租约，
  但设备忙碌时会拒绝额外控制端。
- 连接租约过期、鼠标捕获丢失、发送目标切换或用户主动断开时，应用会释放所有输入。
- 当前尚未实现网络访问控制、输入传输加密和桌面端凭据安全存储。
