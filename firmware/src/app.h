#pragma once

#include "control_server.h"
#include "hid_bridge.h"
#include "service_advertiser.h"
#include "wifi_manager.h"

class App final {
public:
    App();
    App(const App &) = delete;
    App &operator=(const App &) = delete;
    App(App &&) = delete;
    App &operator=(App &&) = delete;

public:
    void setup();
    void tick();

private:
    WifiManager wifi_manager_;
    HidBridge hid_bridge_;
    ServiceAdvertiser service_advertiser_;
    ControlServer control_server_;
};
