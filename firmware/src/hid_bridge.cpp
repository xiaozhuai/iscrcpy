#include "hid_bridge.h"

#include <Arduino.h>
#include <BLEAdvertising.h>
#include <BLEDevice.h>
#include <BLEHIDDevice.h>
#include <BLESecurity.h>
#include <USB.h>
#include <config.h>

#include <algorithm>
#include <cstring>
#include <iterator>

#include "log.h"
#include "settings.h"

namespace {

constexpr uint8_t kKeyboardReportId = 1;
constexpr uint8_t kMouseReportId = 2;
constexpr uint16_t kBleMinConnectionInterval = 6;   // 7.5 ms
constexpr uint16_t kBleMaxConnectionInterval = 12;  // 15 ms
constexpr uint16_t kBleConnectionLatency = 0;
constexpr uint16_t kBleSupervisionTimeout = 400;  // 4 s

#if defined(CONFIG_NIMBLE_ENABLED)
template <typename Tag, typename Tag::Type member>
struct PrivateMemberAccess {
    friend typename Tag::Type get_private_member(Tag) { return member; }
};

struct BleServiceCharacteristicMapTag {
    using Type = BLECharacteristicMap BLEService::*;
    friend Type get_private_member(BleServiceCharacteristicMapTag);
};

template struct PrivateMemberAccess<BleServiceCharacteristicMapTag, &BLEService::m_characteristicMap>;

void register_duplicate_characteristic(BLEService *service, BLECharacteristic *characteristic) {
    auto member = get_private_member(BleServiceCharacteristicMapTag{});
    (service->*member).setByUUID(characteristic, characteristic->getUUID());
}
#endif

void log_ble_connection_params(const char *label, uint16_t interval, uint16_t latency) {
    const uint32_t interval_hundredths_ms = static_cast<uint32_t>(interval) * 125;
    LOGI("%s: %lu.%02lu ms, latency %u", label, static_cast<unsigned long>(interval_hundredths_ms / 100),
         static_cast<unsigned long>(interval_hundredths_ms % 100), static_cast<unsigned>(latency));
}

constexpr uint8_t kHidReportDescriptor[] = {
    // Keyboard, report ID 1.
    0x05,
    0x01,  // Usage Page (Generic Desktop)
    0x09,
    0x06,  // Usage (Keyboard)
    0xA1,
    0x01,  // Collection (Application)
    0x85,
    0x01,  //   Report ID (1)
    0x05,
    0x07,  //   Usage Page (Keyboard)
    0x19,
    0xE0,  //   Usage Minimum (Left Control)
    0x29,
    0xE7,  //   Usage Maximum (Right GUI)
    0x15,
    0x00,  //   Logical Minimum (0)
    0x25,
    0x01,  //   Logical Maximum (1)
    0x75,
    0x01,  //   Report Size (1)
    0x95,
    0x08,  //   Report Count (8)
    0x81,
    0x02,  //   Input (Data, Variable, Absolute)
    0x95,
    0x01,  //   Report Count (1)
    0x75,
    0x08,  //   Report Size (8)
    0x81,
    0x01,  //   Input (Constant)
    0x95,
    0x05,  //   Report Count (5)
    0x75,
    0x01,  //   Report Size (1)
    0x05,
    0x08,  //   Usage Page (LEDs)
    0x19,
    0x01,  //   Usage Minimum (Num Lock)
    0x29,
    0x05,  //   Usage Maximum (Kana)
    0x91,
    0x02,  //   Output (Data, Variable, Absolute)
    0x95,
    0x01,  //   Report Count (1)
    0x75,
    0x03,  //   Report Size (3)
    0x91,
    0x01,  //   Output (Constant)
    0x95,
    0x06,  //   Report Count (6)
    0x75,
    0x08,  //   Report Size (8)
    0x15,
    0x00,  //   Logical Minimum (0)
    0x25,
    0x65,  //   Logical Maximum (101)
    0x05,
    0x07,  //   Usage Page (Keyboard)
    0x19,
    0x00,  //   Usage Minimum (Reserved)
    0x29,
    0x65,  //   Usage Maximum (Keyboard Application)
    0x81,
    0x00,  //   Input (Data, Array, Absolute)
    0xC0,  // End Collection

    // Relative mouse, report ID 2.
    0x05,
    0x01,  // Usage Page (Generic Desktop)
    0x09,
    0x02,  // Usage (Mouse)
    0xA1,
    0x01,  // Collection (Application)
    0x85,
    0x02,  //   Report ID (2)
    0x09,
    0x01,  //   Usage (Pointer)
    0xA1,
    0x00,  //   Collection (Physical)
    0x05,
    0x09,  //     Usage Page (Button)
    0x19,
    0x01,  //     Usage Minimum (1)
    0x29,
    0x05,  //     Usage Maximum (5)
    0x15,
    0x00,  //     Logical Minimum (0)
    0x25,
    0x01,  //     Logical Maximum (1)
    0x95,
    0x05,  //     Report Count (5)
    0x75,
    0x01,  //     Report Size (1)
    0x81,
    0x02,  //     Input (Data, Variable, Absolute)
    0x95,
    0x01,  //     Report Count (1)
    0x75,
    0x03,  //     Report Size (3)
    0x81,
    0x03,  //     Input (Constant, Variable, Absolute)
    0x05,
    0x01,  //     Usage Page (Generic Desktop)
    0x09,
    0x30,  //     Usage (X)
    0x09,
    0x31,  //     Usage (Y)
    0x09,
    0x38,  //     Usage (Wheel)
    0x15,
    0x81,  //     Logical Minimum (-127)
    0x25,
    0x7F,  //     Logical Maximum (127)
    0x75,
    0x08,  //     Report Size (8)
    0x95,
    0x03,  //     Report Count (3)
    0x81,
    0x06,  //     Input (Data, Variable, Relative)
    0x05,
    0x0C,  //     Usage Page (Consumer)
    0x0A,
    0x38,
    0x02,  //     Usage (AC Pan)
    0x95,
    0x01,  //     Report Count (1)
    0x81,
    0x06,  //     Input (Data, Variable, Relative)
    0xC0,  //   End Collection
    0xC0,  // End Collection
};

}  // namespace

class HidBridge::BleCallbacks final : public BLEServerCallbacks {
public:
    explicit BleCallbacks(HidBridge &owner) : owner_(owner) {}

    void onConnect(BLEServer *) override {
        owner_.ble_connected_.store(true);
#if !defined(CONFIG_NIMBLE_ENABLED)
        owner_.pending_ble_event_.store(1);
#endif
    }

    void onDisconnect(BLEServer *) override {
        owner_.ble_connected_.store(false);
        owner_.ble_connection_handle_.store(UINT16_MAX);
        owner_.pending_ble_connection_params_.store(false);
        owner_.pending_ble_event_.store(-1);
    }

#if defined(CONFIG_NIMBLE_ENABLED)
    void onConnect(BLEServer *, ble_gap_conn_desc *description) override {
        owner_.ble_connection_handle_.store(description->conn_handle);
        owner_.ble_connection_interval_.store(description->conn_itvl);
        owner_.ble_connection_latency_.store(description->conn_latency);
        owner_.pending_ble_connection_params_.store(false);
        owner_.pending_ble_event_.store(1);
    }

    void onDisconnect(BLEServer *, ble_gap_conn_desc *) override { owner_.ble_connection_handle_.store(UINT16_MAX); }

    void onConnParamsUpdate(uint16_t connection_handle, uint16_t interval, uint16_t latency, uint16_t,
                            uint8_t status) override {
        if (owner_.ble_connection_handle_.load() != connection_handle) return;
        owner_.ble_connection_interval_.store(interval);
        owner_.ble_connection_latency_.store(latency);
        owner_.ble_connection_params_status_.store(status);
        owner_.pending_ble_connection_params_.store(true);
    }
#endif

private:
    HidBridge &owner_;
};

void HidBridge::setup() {
    const std::string device_name = settings::get_device_name();

    USB.VID(config::kHidVendorId);
    USB.PID(config::kHidProductId);
    USB.manufacturerName(config::kHidManufacturerName);
    USB.productName(device_name.c_str());
    usb_mouse_.begin();
    usb_keyboard_.begin();
    if (USB.begin()) {
        LOGI("USB HID keyboard and mouse started");
    } else {
        LOGE("Failed to start USB HID keyboard and mouse");
    }

    BLEDevice::init(device_name.c_str());

    auto *security = new BLESecurity();
    security->setCapability(ESP_IO_CAP_NONE);
    security->setAuthenticationMode(true, false, true);

    ble_server_ = BLEDevice::createServer();
    ble_callbacks_ = new BleCallbacks(*this);
    ble_server_->setCallbacks(ble_callbacks_);

    ble_hid_ = new BLEHIDDevice(ble_server_);
    ble_hid_->manufacturer()->setValue(config::kHidManufacturerName);
    ble_hid_->pnp(0x02, config::kHidVendorId, config::kHidProductId, 0x0100);
    ble_hid_->hidInfo(0x00, 0x01);
    ble_hid_->reportMap(const_cast<uint8_t *>(kHidReportDescriptor), sizeof(kHidReportDescriptor));
    ble_keyboard_input_ = ble_hid_->inputReport(kKeyboardReportId);
    ble_keyboard_output_ = ble_hid_->outputReport(kKeyboardReportId);
    ble_mouse_input_ = ble_hid_->inputReport(kMouseReportId);
#if defined(CONFIG_NIMBLE_ENABLED)
    // Arduino-ESP32's NimBLE backend currently drops additional HID Report
    // characteristics because they share the required UUID 0x2A4D.
    register_duplicate_characteristic(ble_hid_->hidService(), ble_keyboard_output_);
    register_duplicate_characteristic(ble_hid_->hidService(), ble_mouse_input_);
#endif
    ble_hid_->setBatteryLevel(100);
    ble_hid_->startServices();

    BLEAdvertising *advertising = BLEDevice::getAdvertising();
    advertising->setAppearance(GENERIC_HID);
    advertising->addServiceUUID(ble_hid_->hidService()->getUUID());
    advertising->setScanResponse(true);
    advertising->setMinPreferred(0x06);
    advertising->setMaxPreferred(0x12);
    BLEDevice::startAdvertising();
    LOGI("BLE HID keyboard and mouse advertising as %s", device_name.c_str());
}

void HidBridge::tick(TickContext &context) {
    const int8_t event = pending_ble_event_.exchange(0);
    if (event > 0) {
        reset_ble_state(false);
#if defined(CONFIG_NIMBLE_ENABLED)
        const uint16_t connection_handle = ble_connection_handle_.load();
        log_ble_connection_params("BLE initial connection parameters", ble_connection_interval_.load(),
                                  ble_connection_latency_.load());
        if (connection_handle == UINT16_MAX ||
            !ble_server_->requestConnParams(connection_handle, kBleMinConnectionInterval, kBleMaxConnectionInterval,
                                            kBleConnectionLatency, kBleSupervisionTimeout)) {
            LOGW("Failed to request low-latency BLE connection parameters");
        }
#endif
        LOGI("BLE HID host connected");
    } else if (event < 0) {
        reset_ble_state(false);
        BLEDevice::startAdvertising();
        LOGI("BLE HID host disconnected, advertising restarted");
    }

#if defined(CONFIG_NIMBLE_ENABLED)
    if (pending_ble_connection_params_.exchange(false)) {
        const uint8_t status = ble_connection_params_status_.load();
        if (status == 0) {
            log_ble_connection_params("BLE updated connection parameters", ble_connection_interval_.load(),
                                      ble_connection_latency_.load());
        } else {
            LOGW("BLE connection parameter update failed with status %u", static_cast<unsigned>(status));
        }
    }
#endif

    context.hid = {
        .usb_connected = usb_connected(),
        .ble_connected = ble_connected(),
    };
}

bool HidBridge::key(uint8_t usage, bool pressed, HidTarget target) {
    if (!is_valid_key_usage(usage)) {
        return false;
    }

    if (target == HidTarget::usb_preferred && !pressed) {
        const bool usb_accepted = update_usb_key(usage, false);
        const bool ble_accepted = update_ble_key(usage, false);
        return usb_accepted && ble_accepted;
    }

    return resolve_target(target) == HidTarget::usb ? update_usb_key(usage, pressed) : update_ble_key(usage, pressed);
}

void HidBridge::move_mouse(int8_t x, int8_t y, int8_t wheel, int8_t pan, HidTarget target) {
    if (resolve_target(target) == HidTarget::usb) {
        usb_mouse_.move(x, y, wheel, pan);
    } else {
        send_ble_mouse_report(x, y, wheel, pan);
    }
}

bool HidBridge::set_mouse_button(uint8_t button, bool pressed, HidTarget target) {
    if (button == 0 || (button & MOUSE_ALL) != button || (button & (button - 1)) != 0) {
        return false;
    }

    if (target == HidTarget::usb_preferred && !pressed) {
        update_usb_mouse_button(button, false);
        update_ble_mouse_button(button, false);
        return true;
    }

    if (resolve_target(target) == HidTarget::usb) {
        update_usb_mouse_button(button, pressed);
    } else {
        update_ble_mouse_button(button, pressed);
    }
    return true;
}

void HidBridge::release_all() {
    release_usb();
    release_ble();
}

void HidBridge::release_all(HidTarget target) {
    if (target == HidTarget::usb_preferred) {
        release_all();
    } else if (target == HidTarget::usb) {
        release_usb();
    } else {
        release_ble();
    }
}

bool HidBridge::usb_connected() const { return static_cast<bool>(USB); }

bool HidBridge::ble_connected() const { return ble_connected_.load(); }

HidTarget HidBridge::resolve_target(HidTarget target) const {
    if (target != HidTarget::usb_preferred) {
        return target;
    }
    return usb_connected() ? HidTarget::usb : HidTarget::ble;
}

bool HidBridge::is_valid_key_usage(uint8_t usage) {
    return (usage >= 0x04 && usage <= 0x65) || (usage >= 0xE0 && usage <= 0xE7);
}

bool HidBridge::update_usb_key(uint8_t usage, bool pressed) {
    return (pressed ? usb_keyboard_.pressRaw(usage) : usb_keyboard_.releaseRaw(usage)) != 0;
}

void HidBridge::update_usb_mouse_button(uint8_t button, bool pressed) {
    if (pressed) {
        usb_mouse_.press(button);
    } else {
        usb_mouse_.release(button);
    }
}

void HidBridge::update_ble_mouse_button(uint8_t button, bool pressed) {
    if (pressed) {
        ble_mouse_report_.buttons |= button;
    } else {
        ble_mouse_report_.buttons &= static_cast<uint8_t>(~button);
    }
    send_ble_mouse_report();
}

void HidBridge::release_usb() {
    usb_keyboard_.releaseAll();
    usb_mouse_.buttons(0);
}

void HidBridge::release_ble() { reset_ble_state(true); }

bool HidBridge::update_ble_key(uint8_t usage, bool pressed) {
    if (usage >= 0xE0 && usage <= 0xE7) {
        const uint8_t mask = static_cast<uint8_t>(1U << (usage - 0xE0));
        if (pressed) {
            ble_keyboard_report_.modifiers |= mask;
        } else {
            ble_keyboard_report_.modifiers &= static_cast<uint8_t>(~mask);
        }
        send_ble_keyboard_report();
        return true;
    }

    auto begin = std::begin(ble_keyboard_report_.keys);
    auto end = std::end(ble_keyboard_report_.keys);
    auto key = std::find(begin, end, usage);

    if (pressed) {
        if (key != end) {
            return true;
        }
        auto empty = std::find(begin, end, uint8_t{0});
        if (empty == end) {
            return false;
        }
        *empty = usage;
    } else if (key != end) {
        *key = 0;
    }

    send_ble_keyboard_report();
    return true;
}

void HidBridge::send_ble_keyboard_report() {
    if (!ble_connected_.load()) {
        return;
    }
    ble_keyboard_input_->setValue(reinterpret_cast<uint8_t *>(&ble_keyboard_report_), sizeof(ble_keyboard_report_));
    ble_keyboard_input_->notify();
}

void HidBridge::send_ble_mouse_report(int8_t x, int8_t y, int8_t wheel, int8_t pan) {
    if (!ble_connected_.load()) {
        return;
    }

    MouseReport report = ble_mouse_report_;
    report.x = x;
    report.y = y;
    report.wheel = wheel;
    report.pan = pan;
    ble_mouse_input_->setValue(reinterpret_cast<uint8_t *>(&report), sizeof(report));
    ble_mouse_input_->notify();
}

void HidBridge::reset_ble_state(bool notify) {
    std::memset(&ble_keyboard_report_, 0, sizeof(ble_keyboard_report_));
    std::memset(&ble_mouse_report_, 0, sizeof(ble_mouse_report_));
    if (notify && ble_connected_.load()) {
        send_ble_keyboard_report();
        send_ble_mouse_report();
    }
}
