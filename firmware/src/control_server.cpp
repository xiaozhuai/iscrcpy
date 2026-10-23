#include "control_server.h"

#include <cJSON.h>
#include <esp_timer.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string_view>

#include "config.h"
#include "log.h"
#include "settings.h"

namespace {

constexpr size_t kMaxMessageSize = 512;
constexpr size_t kMaxAccessTokenLength = 128;
constexpr char kControlPath[] = "/control";
constexpr char kHealthPath[] = "/health";

struct JsonDeleter {
    void operator()(cJSON *value) const { cJSON_Delete(value); }
};

using Json = std::unique_ptr<cJSON, JsonDeleter>;

const cJSON *get_item(const cJSON *object, const char *name) { return cJSON_GetObjectItemCaseSensitive(object, name); }

const char *get_string(const cJSON *object, const char *name) {
    const cJSON *item = get_item(object, name);
    return cJSON_IsString(item) ? cJSON_GetStringValue(item) : nullptr;
}

bool get_integer(const cJSON *object, const char *name, int minimum, int maximum, int &value) {
    const cJSON *item = get_item(object, name);
    if (!cJSON_IsNumber(item) || !std::isfinite(item->valuedouble) ||
        std::floor(item->valuedouble) != item->valuedouble || item->valuedouble < minimum ||
        item->valuedouble > maximum) {
        return false;
    }
    value = static_cast<int>(item->valuedouble);
    return true;
}

bool get_boolean(const cJSON *object, const char *name, bool &value) {
    const cJSON *item = get_item(object, name);
    if (!cJSON_IsBool(item)) {
        return false;
    }
    value = cJSON_IsTrue(item);
    return true;
}

bool parse_target(const cJSON *object, HidTarget &target) {
    const char *value = get_string(object, "target");
    if (value == nullptr) {
        return false;
    }
    if (std::strcmp(value, "usb") == 0) {
        target = HidTarget::usb;
    } else if (std::strcmp(value, "ble") == 0) {
        target = HidTarget::ble;
    } else if (std::strcmp(value, "usb_preferred") == 0) {
        target = HidTarget::usb_preferred;
    } else {
        return false;
    }
    return true;
}

bool parse_mouse_button(const cJSON *object, uint8_t &button) {
    const char *value = get_string(object, "button");
    if (value == nullptr) {
        return false;
    }
    if (std::strcmp(value, "left") == 0) {
        button = MOUSE_LEFT;
    } else if (std::strcmp(value, "right") == 0) {
        button = MOUSE_RIGHT;
    } else if (std::strcmp(value, "middle") == 0) {
        button = MOUSE_MIDDLE;
    } else if (std::strcmp(value, "back") == 0) {
        button = MOUSE_BACKWARD;
    } else if (std::strcmp(value, "forward") == 0) {
        button = MOUSE_FORWARD;
    } else {
        return false;
    }
    return true;
}

bool access_tokens_equal(std::string_view expected, std::string_view actual) {
    size_t difference = expected.size() ^ actual.size();
    for (size_t index = 0; index < kMaxAccessTokenLength; ++index) {
        const unsigned char expected_byte = index < expected.size() ? expected[index] : 0;
        const unsigned char actual_byte = index < actual.size() ? actual[index] : 0;
        difference |= expected_byte ^ actual_byte;
    }
    return difference == 0;
}

bool has_control_path(const uint8_t *payload, size_t length) {
    return std::string_view(reinterpret_cast<const char *>(payload), length) == kControlPath;
}

}  // namespace

void ControlWebSocketServer::handleNonWebsocketConnection(WSclient_t *client) {
    constexpr char kNotFoundBody[] = R"({"error":"not_found"})";

    char health_body[96]{};
    const char *body = kNotFoundBody;
    const char *status = "404 Not Found";
    if (client->cUrl == kHealthPath) {
        std::snprintf(health_body, sizeof(health_body), R"({"status":"ok","version":"%s","protocol_version":%lu})",
                      config::kFirmwareVersion, static_cast<unsigned long>(config::kProtocolVersion));
        body = health_body;
        status = "200 OK";
    }

    char response[320]{};
    const int response_length = std::snprintf(response, sizeof(response),
                                              "HTTP/1.1 %s\r\n"
                                              "Content-Type: application/json\r\n"
                                              "Cache-Control: no-store\r\n"
                                              "Access-Control-Allow-Origin: *\r\n"
                                              "Content-Length: %zu\r\n"
                                              "Connection: close\r\n"
                                              "\r\n"
                                              "%s",
                                              status, std::strlen(body), body);
    if (response_length > 0 && static_cast<size_t>(response_length) < sizeof(response)) {
        client->tcp->write(reinterpret_cast<const uint8_t *>(response), response_length);
    }
    clientDisconnect(client);
}

ControlServer::ControlServer(HidBridge &hid_bridge) : web_socket_(config::kServicePort), hid_bridge_(hid_bridge) {}

void ControlServer::setup() {
    access_token_ = settings::get_access_token();
    web_socket_.onEvent([this](uint8_t client, WStype_t type, uint8_t *payload, size_t length) {
        handle_event(client, type, payload, length);
    });
    web_socket_.enableHeartbeat(config::kWebSocketPingIntervalMs, config::kWebSocketPongTimeoutMs, 0);
}

void ControlServer::tick(TickContext &context) {
    status_ = context.hid;

    if (!context.wifi.connected) {
        stop();
        send_pending_logs();
        return;
    }

    if (!running_) {
        start();
    }

    web_socket_.loop();

    const int64_t now_us = esp_timer_get_time();
    expire_pending_handshakes(now_us);
    if (active_client_ != kNoClient && control_lease_expired(now_us)) {
        disconnect_active_client("control lease expired");
    }

    notify_status_if_changed();
    send_pending_logs();
}

void ControlServer::start() {
    web_socket_.begin();
    running_ = true;
    LOGI("Service listening on %s.local:%u", settings::get_hostname().c_str(), config::kServicePort);
}

void ControlServer::stop() {
    if (!running_) {
        return;
    }
    if (active_client_ != kNoClient) {
        disconnect_active_client("Wi-Fi disconnected");
    }
    web_socket_.close();
    for (PendingHandshake &handshake : pending_handshakes_) {
        handshake = {};
    }
    running_ = false;
    has_notified_status_ = false;
    LOGI("Service stopped");
}

void ControlServer::handle_event(uint8_t client, WStype_t type, uint8_t *payload, size_t length) {
    switch (type) {
        case WStype_CONNECTED:
            handle_connected(client, payload, length);
            break;
        case WStype_DISCONNECTED:
            handle_disconnected(client);
            break;
        case WStype_TEXT:
            handle_text(client, payload, length);
            break;
        case WStype_BIN:
        case WStype_FRAGMENT_TEXT_START:
        case WStype_FRAGMENT_BIN_START:
        case WStype_FRAGMENT:
        case WStype_FRAGMENT_FIN:
            if (client < pending_handshakes_.size() && pending_handshakes_[client].pending) {
                reject_handshake(client, "invalid_handshake", "the first message must be unfragmented JSON text");
            } else if (client == active_client_) {
                send_error(client, "invalid_message", "only unfragmented JSON text messages are supported");
            }
            break;
        case WStype_PONG:
            renew_control_lease(client);
            break;
        default:
            break;
    }
}

void ControlServer::handle_connected(uint8_t client, const uint8_t *payload, size_t length) {
    if (client >= pending_handshakes_.size()) {
        web_socket_.disconnect(client);
        return;
    }
    pending_handshakes_[client] = {};

    if (!has_control_path(payload, length)) {
        send_error(client, "invalid_path", "connect to /control");
        web_socket_.disconnect(client);
        return;
    }

    pending_handshakes_[client] = {esp_timer_get_time(), true};
}

void ControlServer::handle_handshake(uint8_t client, const uint8_t *payload, size_t length) {
    if (length == 0 || length > kMaxMessageSize) {
        reject_handshake(client, "invalid_handshake", "handshake must contain at most 512 bytes");
        return;
    }

    Json root(cJSON_ParseWithLength(reinterpret_cast<const char *>(payload), length));
    if (!root || !cJSON_IsObject(root.get())) {
        reject_handshake(client, "invalid_handshake", "handshake must be a JSON object");
        return;
    }

    const char *type = get_string(root.get(), "type");
    if (type == nullptr || std::strcmp(type, "hello") != 0) {
        reject_handshake(client, "handshake_required", "the first message must be hello");
        return;
    }

    if (!access_token_) {
        reject_handshake(client, "configuration_error", "access token configuration is invalid");
        return;
    }

    if (!access_token_->empty()) {
        const char *controller_access_token = get_string(root.get(), "access_token");
        if (controller_access_token == nullptr || !access_tokens_equal(*access_token_, controller_access_token)) {
            LOGW("WebSocket authentication failed from %s", web_socket_.remoteIP(client).toString().c_str());
            reject_handshake(client, "unauthorized", "invalid access token");
            return;
        }
    }

    int controller_protocol_version = 0;
    if (!get_integer(root.get(), "protocol_version", 0, 0x7FFFFFFF, controller_protocol_version) ||
        static_cast<uint32_t>(controller_protocol_version) != config::kProtocolVersion) {
        pending_handshakes_[client] = {};
        send_hello(client);
        send_error(client, "version_mismatch", "controller and firmware protocol versions do not match");
        LOGW("WebSocket protocol version mismatch from %s: controller=%d, firmware=%lu",
             web_socket_.remoteIP(client).toString().c_str(), controller_protocol_version,
             static_cast<unsigned long>(config::kProtocolVersion));
        web_socket_.disconnect(client);
        return;
    }

    const int64_t now_us = esp_timer_get_time();
    if (active_client_ != kNoClient) {
        if (!control_lease_expired(now_us)) {
            reject_handshake(client, "busy", "another controller is already connected");
            return;
        }
        disconnect_active_client("expired control lease replaced by a new connection");
    }

    pending_handshakes_[client] = {};
    active_client_ = client;
    control_lease_renewed_at_us_ = now_us;
    send_hello(client);
    send_status(client);
    send_current_log(client);
    LOGI("WebSocket controller connected from %s", web_socket_.remoteIP(client).toString().c_str());
}

void ControlServer::handle_disconnected(uint8_t client) {
    if (client < pending_handshakes_.size()) {
        pending_handshakes_[client] = {};
    }
    if (client != active_client_) {
        return;
    }
    hid_bridge_.release_all();
    active_client_ = kNoClient;
    control_lease_renewed_at_us_ = 0;
    has_notified_status_ = false;
    LOGI("WebSocket controller disconnected; all HID inputs released");
}

void ControlServer::handle_text(uint8_t client, const uint8_t *payload, size_t length) {
    if (client != active_client_) {
        if (client < pending_handshakes_.size() && pending_handshakes_[client].pending) {
            handle_handshake(client, payload, length);
            return;
        }
        send_error(client, "not_controller", "this connection does not own the controller");
        return;
    }
    if (length == 0 || length > kMaxMessageSize) {
        send_error(client, "invalid_message", "message must contain at most 512 bytes");
        return;
    }

    Json root(cJSON_ParseWithLength(reinterpret_cast<const char *>(payload), length));
    if (!root || !cJSON_IsObject(root.get())) {
        send_error(client, "invalid_json", "message must be a JSON object");
        return;
    }

    const char *type = get_string(root.get(), "type");
    if (type == nullptr) {
        send_error(client, "invalid_message", "type is required");
        return;
    }

    if (std::strcmp(type, "ping") == 0) {
        int sequence = 0;
        if (!get_integer(root.get(), "seq", 0, 0x7FFFFFFF, sequence)) {
            send_error(client, "invalid_message", "ping.seq must be a non-negative integer");
            return;
        }
        renew_control_lease(client);
        char response[64]{};
        std::snprintf(response, sizeof(response), R"({"type":"pong","seq":%d})", sequence);
        web_socket_.sendTXT(client, response);
        return;
    }

    if (std::strcmp(type, "get_status") == 0) {
        renew_control_lease(client);
        send_status(client);
        return;
    }

    HidTarget target{};
    if (!parse_target(root.get(), target)) {
        send_error(client, "invalid_target", "target must be usb_preferred, usb, or ble");
        return;
    }

    if (std::strcmp(type, "key") == 0) {
        int usage = 0;
        const char *action = get_string(root.get(), "action");
        if (!get_integer(root.get(), "usage", 0, 0xFF, usage) || action == nullptr ||
            (std::strcmp(action, "down") != 0 && std::strcmp(action, "up") != 0)) {
            send_error(client, "invalid_key", "key requires a valid usage and down/up action");
            return;
        }
        renew_control_lease(client);
        if (!hid_bridge_.key(static_cast<uint8_t>(usage), std::strcmp(action, "down") == 0, target)) {
            send_error(client, "key_rejected", "invalid usage or more than six non-modifier keys are pressed");
        }
        return;
    }

    if (std::strcmp(type, "mouse_move") == 0) {
        int x = 0;
        int y = 0;
        int wheel = 0;
        int pan = 0;
        if (!get_integer(root.get(), "x", -127, 127, x) || !get_integer(root.get(), "y", -127, 127, y) ||
            !get_integer(root.get(), "wheel", -127, 127, wheel) || !get_integer(root.get(), "pan", -127, 127, pan)) {
            send_error(client, "invalid_mouse_move", "x, y, wheel, and pan must be integers from -127 to 127");
            return;
        }
        renew_control_lease(client);
        hid_bridge_.move_mouse(static_cast<int8_t>(x), static_cast<int8_t>(y), static_cast<int8_t>(wheel),
                               static_cast<int8_t>(pan), target);
        return;
    }

    if (std::strcmp(type, "mouse_button") == 0) {
        uint8_t button = 0;
        bool pressed = false;
        if (!parse_mouse_button(root.get(), button) || !get_boolean(root.get(), "pressed", pressed)) {
            send_error(client, "invalid_mouse_button", "button or pressed is invalid");
            return;
        }
        renew_control_lease(client);
        if (!hid_bridge_.set_mouse_button(button, pressed, target)) {
            send_error(client, "invalid_mouse_button", "button or pressed is invalid");
        }
        return;
    }

    if (std::strcmp(type, "release_all") == 0) {
        renew_control_lease(client);
        hid_bridge_.release_all(target);
        return;
    }

    send_error(client, "unknown_type", "unsupported message type");
}

void ControlServer::expire_pending_handshakes(int64_t now_us) {
    for (size_t client = 0; client < pending_handshakes_.size(); ++client) {
        const PendingHandshake &handshake = pending_handshakes_[client];
        if (handshake.pending && now_us - handshake.started_at_us > config::kWebSocketHandshakeTimeoutUs) {
            reject_handshake(static_cast<uint8_t>(client), "handshake_timeout", "hello was not received in time");
        }
    }
}

void ControlServer::reject_handshake(uint8_t client, const char *code, const char *message) {
    if (client < pending_handshakes_.size()) {
        pending_handshakes_[client] = {};
    }
    send_error(client, code, message);
    web_socket_.disconnect(client);
}

void ControlServer::renew_control_lease(uint8_t client) {
    if (client == active_client_) {
        control_lease_renewed_at_us_ = esp_timer_get_time();
    }
}

bool ControlServer::control_lease_expired(int64_t now_us) const {
    return control_lease_renewed_at_us_ == 0 || now_us - control_lease_renewed_at_us_ > config::kControlLeaseTimeoutUs;
}

void ControlServer::disconnect_active_client(const char *reason) {
    if (active_client_ == kNoClient) {
        return;
    }

    const uint8_t client = active_client_;
    hid_bridge_.release_all();
    active_client_ = kNoClient;
    control_lease_renewed_at_us_ = 0;
    has_notified_status_ = false;
    web_socket_.disconnect(client);
    LOGW("WebSocket controller disconnected: %s; all HID inputs released", reason);
}

void ControlServer::send_hello(uint8_t client) {
    Json root(cJSON_CreateObject());
    if (!root || cJSON_AddStringToObject(root.get(), "type", "hello") == nullptr ||
        cJSON_AddStringToObject(root.get(), "version", config::kFirmwareVersion) == nullptr ||
        cJSON_AddStringToObject(root.get(), "device_name", settings::get_device_name().c_str()) == nullptr ||
        cJSON_AddNumberToObject(root.get(), "protocol_version", config::kProtocolVersion) == nullptr) {
        return;
    }
    char *response = cJSON_PrintUnformatted(root.get());
    if (response == nullptr) {
        return;
    }
    web_socket_.sendTXT(client, response);
    cJSON_free(response);
}

void ControlServer::send_status(uint8_t client) {
    char response[128]{};
    std::snprintf(response, sizeof(response), R"({"type":"status","usb_connected":%s,"ble_connected":%s})",
                  status_.usb_connected ? "true" : "false", status_.ble_connected ? "true" : "false");
    if (web_socket_.sendTXT(client, response) && client == active_client_) {
        last_notified_status_ = status_;
        has_notified_status_ = true;
    }
}

void ControlServer::notify_status_if_changed() {
    if (active_client_ == kNoClient ||
        (has_notified_status_ && status_.usb_connected == last_notified_status_.usb_connected &&
         status_.ble_connected == last_notified_status_.ble_connected)) {
        return;
    }
    send_status(active_client_);
}

void ControlServer::send_error(uint8_t client, const char *code, const char *message) {
    char response[256]{};
    std::snprintf(response, sizeof(response), R"({"type":"error","code":"%s","message":"%s"})", code, message);
    web_socket_.sendTXT(client, response);
}

void ControlServer::send_current_log(uint8_t client) {
    Log::visit_current_and_clear_pending([this, client](const std::string &line) { send_log(client, line); });
}

void ControlServer::send_pending_logs() {
    std::string message;
    while (Log::take_pending(message)) {
        if (active_client_ != kNoClient) {
            send_log(active_client_, message);
        }
    }
}

void ControlServer::send_log(uint8_t client, const std::string &message) {
    Json root(cJSON_CreateObject());
    if (!root || cJSON_AddStringToObject(root.get(), "type", "log") == nullptr ||
        cJSON_AddStringToObject(root.get(), "message", message.c_str()) == nullptr) {
        return;
    }
    char *response = cJSON_PrintUnformatted(root.get());
    if (response == nullptr) {
        return;
    }
    web_socket_.sendTXT(client, response);
    cJSON_free(response);
}
