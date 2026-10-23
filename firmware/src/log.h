#pragma once

#include <cstddef>
#include <functional>
#include <string>

class Log final {
public:
    using LineVisitor = std::function<void(const std::string &)>;

    Log() = delete;

    static void setup();
    static void write(const char *format, ...) __attribute__((format(printf, 1, 2)));

    static void visit_current_and_clear_pending(const LineVisitor &visitor);
    static bool take_pending(std::string &message);

private:
    struct State;

    static State &state();
    static void append_to_current_file(const char *message, size_t length);
    static void compact_and_append(const char *line, size_t length);
    static void enqueue(const char *message, size_t length);
    static void rotate_logs();
};

#define LOGD(fmt, ...) Log::write("[D] " fmt __VA_OPT__(, ) __VA_ARGS__)
#define LOGI(fmt, ...) Log::write("[I] " fmt __VA_OPT__(, ) __VA_ARGS__)
#define LOGW(fmt, ...) Log::write("[W] " fmt __VA_OPT__(, ) __VA_ARGS__)
#define LOGE(fmt, ...) Log::write("[E] " fmt __VA_OPT__(, ) __VA_ARGS__)
