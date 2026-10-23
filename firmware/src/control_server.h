#pragma once

#include <WebSocketsServer.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

#include "hid_bridge.h"
#include "log.h"
#include "tick_context.h"

class ControlWebSocketServer final : public WebSocketsServer {
public:
    using WebSocketsServer::WebSocketsServer;

private:
    void handleNonWebsocketConnection(WSclient_t *client) override;
};

class ControlServer final {
public:
    explicit ControlServer(HidBridge &hid_bridge);

    void setup();
    void tick(TickContext &context);

private:
    static constexpr uint8_t kNoClient = 0xFF;

    struct PendingHandshake {
        int64_t started_at_us{};
        bool pending{};
    };

    void start();
    void stop();
    void handle_event(uint8_t client, WStype_t type, uint8_t *payload, size_t length);
    void handle_connected(uint8_t client, const uint8_t *payload, size_t length);
    void handle_disconnected(uint8_t client);
    void handle_text(uint8_t client, const uint8_t *payload, size_t length);
    void handle_handshake(uint8_t client, const uint8_t *payload, size_t length);
    void expire_pending_handshakes(int64_t now_us);
    void reject_handshake(uint8_t client, const char *code, const char *message);
    void renew_control_lease(uint8_t client);
    bool control_lease_expired(int64_t now_us) const;
    void disconnect_active_client(const char *reason);

    void send_hello(uint8_t client);
    void send_status(uint8_t client);
    void notify_status_if_changed();
    void send_error(uint8_t client, const char *code, const char *message);
    void send_current_log(uint8_t client);
    void send_pending_logs();
    void send_log(uint8_t client, const std::string &message);

    ControlWebSocketServer web_socket_;
    HidBridge &hid_bridge_;
    std::optional<std::string> access_token_;
    std::array<PendingHandshake, WEBSOCKETS_SERVER_CLIENT_MAX> pending_handshakes_{};
    HidState status_{};
    HidState last_notified_status_{};
    uint8_t active_client_{kNoClient};
    int64_t control_lease_renewed_at_us_{0};
    bool running_{false};
    bool has_notified_status_{false};
};
