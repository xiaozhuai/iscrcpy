#include "app.h"

#include <Arduino.h>
#include <esp_timer.h>

#include "config.h"
#include "log.h"

App::App() : control_server_(hid_bridge_) {}

void App::setup() {
    Serial.begin(config::kSerialBaudRate);
    delay(500);
    Log::setup();

    if (psramFound()) {
        LOGI("PSRAM found, size: %lu bytes", ESP.getPsramSize());
    } else {
        LOGW("PSRAM not found");
    }

    hid_bridge_.setup();
    wifi_manager_.setup();
    service_advertiser_.setup();
    control_server_.setup();
}

void App::tick() {
    TickContext context{};
    context.now_us = esp_timer_get_time();

    wifi_manager_.tick(context);
    hid_bridge_.tick(context);
    service_advertiser_.tick(context);
    control_server_.tick(context);

    delay(context.wifi.connected ? 1 : 10);
}
