#include "wifi_manager.h"

#include "log.h"
#include "settings.h"

namespace {

constexpr int64_t kIpLostRecoveryDelayUs = 5LL * 1000LL * 1000LL;

}  // namespace

void WifiManager::setup() {
    WiFi.setHostname(settings::get_hostname().c_str());
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
    WiFi.onEvent([this](WiFiEvent_t event, WiFiEventInfo_t info) { handle_event(event, info); });
    connect();
}

void WifiManager::tick(TickContext &context) {
    const bool connected = connected_.load();
    const bool was_connected = was_connected_;
    const bool ip_lost = ip_lost_.load();

    context.wifi = {
        .connected = connected,
        .was_connected = was_connected,
    };
    was_connected_ = connected;

    if (!was_connected && connected) {
        LOGI("Wi-Fi connected, IP: %s, gateway: %s",  //
             WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str());
    } else if (was_connected && !connected) {
        LOGW("%s",
             ip_lost ? "Wi-Fi IP lost, waiting for recovery" : "Wi-Fi disconnected, waiting for automatic reconnect");
    }

    if (connected) {
        recovery_active_ = false;
        return;
    }

    if (!ip_lost) {
        recovery_active_ = false;
        return;
    }

    if (!recovery_active_) {
        recovery_active_ = true;
        next_recovery_at_us_ = context.now_us + kIpLostRecoveryDelayUs;
        LOGW("Wi-Fi IP lost, scheduling recovery");
        return;
    }

    if (context.now_us < next_recovery_at_us_) {
        return;
    }

    next_recovery_at_us_ = context.now_us + kIpLostRecoveryDelayUs;
    LOGW("Wi-Fi IP still unavailable, reconnecting");
    WiFi.disconnect(false);
    connect();
}

void WifiManager::connect() {
    const std::string ssid = settings::get_wifi_ssid();
    if (ssid.empty()) {
        LOGW("Wi-Fi SSID is not configured");
        return;
    }

    const std::optional<std::string> password = settings::get_wifi_password();
    if (!password) {
        LOGW("Wi-Fi password configuration is invalid");
        return;
    }
    WiFi.begin(ssid.c_str(), password->c_str());
    LOGI("Connecting to Wi-Fi: %s", ssid.c_str());
}

void WifiManager::handle_event(WiFiEvent_t event, WiFiEventInfo_t) noexcept {
    switch (event) {
        case ARDUINO_EVENT_WIFI_STA_GOT_IP: {
            connected_.store(true);
            ip_lost_.store(false);
            break;
        }
        case ARDUINO_EVENT_WIFI_STA_DISCONNECTED: {
            connected_.store(false);
            break;
        }
        case ARDUINO_EVENT_WIFI_STA_LOST_IP: {
            connected_.store(false);
            ip_lost_.store(true);
            break;
        }
        default: {
            break;
        }
    }
}
