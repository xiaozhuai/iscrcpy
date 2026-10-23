#include "service_advertiser.h"

#include <ESPmDNS.h>

#include "config.h"
#include "log.h"
#include "settings.h"

namespace {

constexpr int64_t kRetryIntervalUs = 3LL * 1000LL * 1000LL;

std::string make_instance_name() {
    const auto chip_id = static_cast<unsigned long long>(ESP.getEfuseMac());
    char instance_name[sizeof(config::kDefaultHostnamePrefix) + 12]{};
    std::snprintf(instance_name, sizeof(instance_name), "%s%012llx", config::kDefaultHostnamePrefix, chip_id);
    return instance_name;
}

}  // namespace

void ServiceAdvertiser::setup() {
    hostname_ = settings::get_hostname();
    instance_name_ = make_instance_name();
    device_name_ = settings::get_device_name();
}

void ServiceAdvertiser::tick(TickContext &context) {
    if (!context.wifi.connected) {
        stop_advertising();
        next_retry_at_us_ = 0;
        return;
    }

    if (advertising_) {
        return;
    }

    if (next_retry_at_us_ != 0 && context.now_us < next_retry_at_us_) {
        return;
    }

    if (start_advertising()) {
        next_retry_at_us_ = 0;
    } else {
        next_retry_at_us_ = context.now_us + kRetryIntervalUs;
    }
}

bool ServiceAdvertiser::start_advertising() {
    if (!MDNS.begin(hostname_.c_str())) {
        MDNS.end();
        LOGE("Failed to start mDNS responder for %s.local", hostname_.c_str());
        return false;
    }

    MDNS.setInstanceName(instance_name_.c_str());

    if (!MDNS.addService(config::kMdnsServiceType, config::kMdnsProtocol, config::kServicePort)) {
        MDNS.end();
        LOGE("Failed to advertise mDNS service _%s._%s", config::kMdnsServiceType, config::kMdnsProtocol);
        return false;
    }

    MDNS.addServiceTxt(config::kMdnsServiceType, config::kMdnsProtocol, "device_name", device_name_.c_str());

    char protocol_version[12]{};
    std::snprintf(protocol_version, sizeof(protocol_version), "%lu",
                  static_cast<unsigned long>(config::kProtocolVersion));
    MDNS.addServiceTxt(config::kMdnsServiceType, config::kMdnsProtocol, "version", config::kFirmwareVersion);
    MDNS.addServiceTxt(config::kMdnsServiceType, config::kMdnsProtocol, "protocol_version", protocol_version);

    advertising_ = true;
    LOGI("Advertising %s.local as %s via _%s._%s on port %d",  //
         hostname_.c_str(), instance_name_.c_str(), config::kMdnsServiceType, config::kMdnsProtocol,
         config::kServicePort);
    return true;
}

void ServiceAdvertiser::stop_advertising() {
    if (!advertising_) {
        return;
    }

    MDNS.end();
    advertising_ = false;
    LOGI("Stopped mDNS advertisement");
}
