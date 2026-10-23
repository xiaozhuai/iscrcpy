#pragma once

#include <Arduino.h>
#include <WiFi.h>

#include <atomic>
#include <cstdint>

#include "tick_context.h"

class WifiManager final {
public:
    void setup();
    void tick(TickContext &context);

private:
    void connect();
    void handle_event(WiFiEvent_t event, WiFiEventInfo_t info) noexcept;

    std::atomic_bool connected_{false};
    std::atomic_bool ip_lost_{false};
    bool was_connected_{false};
    bool recovery_active_{false};
    int64_t next_recovery_at_us_{0};
};
