#pragma once

#include <cstddef>
#include <cstdint>

namespace config {

inline constexpr uint32_t kSerialBaudRate = 115200;

inline constexpr char kHidManufacturerName[] = "iscrcpy";
inline constexpr uint16_t kHidVendorId = 0x303A;
inline constexpr uint16_t kHidProductId = 0x1001;
inline constexpr char kDefaultHostnamePrefix[] = "iscrcpy-hw-";
inline constexpr char kMdnsServiceType[] = "iscrcpy-control";
inline constexpr char kMdnsProtocol[] = "tcp";
inline constexpr uint16_t kServicePort = 2786;
inline constexpr char kFirmwareVersion[] = "0.1.0";
inline constexpr uint32_t kProtocolVersion = 1;
inline constexpr uint32_t kWebSocketPingIntervalMs = 1000;
inline constexpr uint32_t kWebSocketPongTimeoutMs = 750;
inline constexpr int64_t kWebSocketHandshakeTimeoutUs = 3LL * 1000LL * 1000LL;
inline constexpr int64_t kControlLeaseTimeoutUs = 3LL * 1000LL * 1000LL;
inline constexpr char kCurrentLogFilePath[] = "/current.log";
inline constexpr char kHistoryLogFilePrefix[] = "/history-";
inline constexpr size_t kMaxLogFileSize = 16 * 1024;
inline constexpr size_t kMaxHistoricalLogFiles = 8;

}  // namespace config
