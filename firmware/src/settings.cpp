#include "settings.h"

#include <Arduino.h>
#include <Preferences.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <utility>

#include "config.h"
#include "log.h"

namespace {

constexpr char kNamespace[] = "settings";
constexpr char kWifiSsidKey[] = "wifi_ssid";
constexpr char kWifiPasswordKey[] = "wifi_password";
constexpr char kHostnameKey[] = "hostname";
constexpr char kDeviceNameKey[] = "device_name";
constexpr char kAccessTokenKey[] = "access_token";

constexpr size_t kMaxWifiSsidLength = 32;
constexpr size_t kMinWifiPasswordLength = 8;
constexpr size_t kMaxWifiPasswordLength = 64;
constexpr size_t kMaxHostnameLength = 63;
constexpr size_t kMaxDeviceNameLength = 28;
constexpr size_t kMinAccessTokenLength = 16;
constexpr size_t kMaxAccessTokenLength = 128;

struct StoredString {
    std::string value;
    bool valid;
};

bool contains_null(const std::string &value) { return value.find('\0') != std::string::npos; }

bool is_valid_wifi_ssid(const std::string &value) {
    return value.size() <= kMaxWifiSsidLength && !contains_null(value);
}

bool is_valid_wifi_password(const std::string &value) {
    if (value.empty()) {
        return true;
    }
    if (contains_null(value) || value.size() < kMinWifiPasswordLength || value.size() > kMaxWifiPasswordLength) {
        return false;
    }
    if (value.size() != kMaxWifiPasswordLength) {
        return true;
    }
    return std::all_of(value.begin(), value.end(), [](unsigned char character) { return std::isxdigit(character); });
}

bool is_valid_hostname(const std::string &value) {
    if (value.empty() || value.size() > kMaxHostnameLength || value.front() == '-' || value.back() == '-') {
        return false;
    }
    return std::all_of(value.begin(), value.end(),
                       [](unsigned char character) { return std::isalnum(character) || character == '-'; });
}

bool is_valid_device_name(const std::string &value) {
    if (value.empty() || value.size() > kMaxDeviceNameLength || contains_null(value)) {
        return false;
    }
    return std::none_of(value.begin(), value.end(),
                        [](unsigned char character) { return character < 0x20 || character == 0x7F; });
}

bool is_valid_access_token(const std::string &value) {
    if (value.size() < kMinAccessTokenLength || value.size() > kMaxAccessTokenLength || contains_null(value)) {
        return false;
    }
    return std::all_of(value.begin(), value.end(),
                       [](unsigned char character) { return character >= 0x21 && character <= 0x7E; });
}

void set_string(const char *key, const std::string &value) {
    Preferences preferences;
    if (!preferences.begin(kNamespace)) {
        LOGE("Failed to open NVS settings for writing");
        return;
    }

    bool succeeded = false;
    if (value.empty()) {
        succeeded = !preferences.isKey(key) || preferences.remove(key);
    } else {
        succeeded = preferences.putString(key, value.c_str()) == value.size();
    }
    preferences.end();

    if (!succeeded) {
        LOGE("Failed to write NVS setting: %s", key);
    }
}

StoredString get_string(const char *key, size_t maximum_length, const std::string &default_value = {}) {
    Preferences preferences;
    if (!preferences.begin(kNamespace)) {
        LOGE("Failed to open NVS settings for reading");
        return {default_value, false};
    }

    if (!preferences.isKey(key)) {
        preferences.end();
        return {default_value, true};
    }

    const size_t stored_length = preferences.getStringLength(key);
    if (stored_length == 0 || stored_length > maximum_length + 1) {
        preferences.end();
        return {default_value, false};
    }

    std::string value(stored_length, '\0');
    const size_t read_length = preferences.getString(key, value.data(), value.size());
    preferences.end();
    if (read_length != stored_length) {
        return {default_value, false};
    }
    value.resize(stored_length - 1);
    return {std::move(value), true};
}

std::string make_default_hostname() {
    const auto chip_id = static_cast<unsigned long long>(ESP.getEfuseMac());
    char hostname[sizeof(config::kDefaultHostnamePrefix) + 12]{};
    std::snprintf(hostname, sizeof(hostname), "%s%012llx", config::kDefaultHostnamePrefix, chip_id);
    return hostname;
}

}  // namespace

namespace settings {

void set_wifi_ssid(const std::string &ssid) {
    if (!is_valid_wifi_ssid(ssid)) {
        LOGE("Wi-Fi SSID must contain at most %zu bytes", kMaxWifiSsidLength);
        return;
    }
    set_string(kWifiSsidKey, ssid);
}

std::string get_wifi_ssid() {
    StoredString stored = get_string(kWifiSsidKey, kMaxWifiSsidLength);
    if (!stored.valid || !is_valid_wifi_ssid(stored.value)) {
        LOGE("Ignoring invalid Wi-Fi SSID in NVS");
        return {};
    }
    return std::move(stored.value);
}

void set_wifi_password(const std::string &password) {
    if (!is_valid_wifi_password(password)) {
        LOGE("Wi-Fi password must be empty, 8-63 bytes, or 64 hexadecimal digits");
        return;
    }
    set_string(kWifiPasswordKey, password);
}

std::optional<std::string> get_wifi_password() {
    StoredString stored = get_string(kWifiPasswordKey, kMaxWifiPasswordLength);
    if (!stored.valid || !is_valid_wifi_password(stored.value)) {
        LOGE("Ignoring invalid Wi-Fi password in NVS");
        return std::nullopt;
    }
    return std::move(stored.value);
}

void set_hostname(const std::string &hostname) {
    if (!hostname.empty() && !is_valid_hostname(hostname)) {
        LOGE("Hostname must be a valid DNS label of at most %zu bytes", kMaxHostnameLength);
        return;
    }
    set_string(kHostnameKey, hostname);
}

std::string get_hostname() {
    const std::string default_hostname = make_default_hostname();
    StoredString stored = get_string(kHostnameKey, kMaxHostnameLength, default_hostname);
    if (!stored.valid || !is_valid_hostname(stored.value)) {
        if (!stored.value.empty()) {
            LOGE("Ignoring invalid hostname in NVS");
        }
        return default_hostname;
    }
    return std::move(stored.value);
}

void set_device_name(const std::string &device_name) {
    if (!device_name.empty() && !is_valid_device_name(device_name)) {
        LOGE("Device name must contain 1-%zu bytes without control characters", kMaxDeviceNameLength);
        return;
    }
    set_string(kDeviceNameKey, device_name);
}

std::string get_device_name() {
    const std::string hostname = get_hostname();
    StoredString stored = get_string(kDeviceNameKey, kMaxDeviceNameLength, hostname);
    if (!stored.valid || !is_valid_device_name(stored.value)) {
        if (!stored.value.empty()) {
            LOGE("Ignoring invalid device name in NVS");
        }
        return hostname;
    }
    return std::move(stored.value);
}

void set_access_token(const std::string &access_token) {
    if (!access_token.empty() && !is_valid_access_token(access_token)) {
        LOGE("Access token must contain %zu-%zu printable ASCII characters", kMinAccessTokenLength,
             kMaxAccessTokenLength);
        return;
    }
    set_string(kAccessTokenKey, access_token);
}

std::optional<std::string> get_access_token() {
    StoredString stored = get_string(kAccessTokenKey, kMaxAccessTokenLength);
    if (!stored.valid || (!stored.value.empty() && !is_valid_access_token(stored.value))) {
        LOGE("Invalid access token in NVS; WebSocket authentication is unavailable");
        return std::nullopt;
    }
    return std::move(stored.value);
}

}  // namespace settings
