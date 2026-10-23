#pragma once

#include <cstdint>
#include <string>

#include "tick_context.h"

class ServiceAdvertiser final {
public:
    void setup();
    void tick(TickContext &context);

private:
    bool start_advertising();
    void stop_advertising();

    std::string hostname_;
    std::string instance_name_;
    std::string device_name_;
    bool advertising_{false};
    int64_t next_retry_at_us_{0};
};
