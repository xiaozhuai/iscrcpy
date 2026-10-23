#pragma once

#include <USBHIDKeyboard.h>
#include <USBHIDMouse.h>

#include <atomic>
#include <cstdint>

#include "tick_context.h"

class BLECharacteristic;
class BLEHIDDevice;
class BLEServer;

enum class HidTarget : uint8_t {
    usb_preferred,
    usb,
    ble,
};

class HidBridge final {
public:
    void setup();
    void tick(TickContext &context);

    bool key(uint8_t usage, bool pressed, HidTarget target);
    void move_mouse(int8_t x, int8_t y, int8_t wheel, int8_t pan, HidTarget target);
    bool set_mouse_button(uint8_t button, bool pressed, HidTarget target);
    void release_all();
    void release_all(HidTarget target);

    bool usb_connected() const;
    bool ble_connected() const;

private:
    class BleCallbacks;

    struct KeyboardReport {
        uint8_t modifiers{0};
        uint8_t reserved{0};
        uint8_t keys[6]{};
    } __attribute__((packed));

    struct MouseReport {
        uint8_t buttons{0};
        int8_t x{0};
        int8_t y{0};
        int8_t wheel{0};
        int8_t pan{0};
    } __attribute__((packed));

    HidTarget resolve_target(HidTarget target) const;
    static bool is_valid_key_usage(uint8_t usage);

    bool update_usb_key(uint8_t usage, bool pressed);
    void update_usb_mouse_button(uint8_t button, bool pressed);
    void update_ble_mouse_button(uint8_t button, bool pressed);
    void release_usb();
    void release_ble();

    bool update_ble_key(uint8_t usage, bool pressed);
    void send_ble_keyboard_report();
    void send_ble_mouse_report(int8_t x = 0, int8_t y = 0, int8_t wheel = 0, int8_t pan = 0);
    void reset_ble_state(bool notify);

    USBHIDKeyboard usb_keyboard_;
    USBHIDMouse usb_mouse_;

    BLEServer *ble_server_{nullptr};
    BLEHIDDevice *ble_hid_{nullptr};
    BLECharacteristic *ble_keyboard_input_{nullptr};
    BLECharacteristic *ble_keyboard_output_{nullptr};
    BLECharacteristic *ble_mouse_input_{nullptr};
    BleCallbacks *ble_callbacks_{nullptr};

    KeyboardReport ble_keyboard_report_{};
    MouseReport ble_mouse_report_{};
    std::atomic_bool ble_connected_{false};
    std::atomic_int8_t pending_ble_event_{0};
    std::atomic_uint16_t ble_connection_handle_{UINT16_MAX};
    std::atomic_uint16_t ble_connection_interval_{0};
    std::atomic_uint16_t ble_connection_latency_{0};
    std::atomic_uint8_t ble_connection_params_status_{0};
    std::atomic_bool pending_ble_connection_params_{false};
};
