#pragma once

#include <cstdint>

struct WifiState {
    bool connected{false};
    bool was_connected{false};
};

struct HidState {
    bool usb_connected{false};
    bool ble_connected{false};
};

struct TickContext {
    int64_t now_us;
    WifiState wifi;
    HidState hid;
};
