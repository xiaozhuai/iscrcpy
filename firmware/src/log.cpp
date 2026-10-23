#include "log.h"

#include <Arduino.h>
#include <LittleFS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>

#include "config.h"

namespace {

constexpr size_t kMaxLogMessageLength = 480;
constexpr UBaseType_t kPendingLogCapacity = 32;

struct PendingLog {
    uint16_t length;
    char message[kMaxLogMessageLength + 1];
};

void report_storage_error(const char *message) { Serial.printf("[E] %s\n", message); }

std::string history_file_path(size_t index) {
    char path[32]{};
    std::snprintf(path, sizeof(path), "%s%02zu.log", config::kHistoryLogFilePrefix, index);
    return path;
}

std::string read_file(const char *path, size_t maximum_size = config::kMaxLogFileSize) {
    File file = LittleFS.open(path, FILE_READ);
    if (!file) {
        return {};
    }

    const size_t size = std::min(file.size(), maximum_size);
    std::string contents(size, '\0');
    contents.resize(file.read(reinterpret_cast<uint8_t *>(contents.data()), contents.size()));
    return contents;
}

bool copy_file(const char *source_path, const char *destination_path) {
    File source = LittleFS.open(source_path, FILE_READ);
    File destination = LittleFS.open(destination_path, FILE_WRITE);
    if (!source || !destination) {
        LittleFS.remove(destination_path);
        return false;
    }

    uint8_t buffer[256]{};
    while (source.available()) {
        const size_t size = source.read(buffer, sizeof(buffer));
        if (size == 0 || destination.write(buffer, size) != size) {
            destination.close();
            source.close();
            LittleFS.remove(destination_path);
            return false;
        }
    }
    destination.close();
    source.close();
    if (!LittleFS.remove(source_path)) {
        LittleFS.remove(destination_path);
        return false;
    }
    return true;
}

bool move_file(const char *source_path, const char *destination_path) {
    return LittleFS.rename(source_path, destination_path) || copy_file(source_path, destination_path);
}

void visit_lines(const std::string &contents, const Log::LineVisitor &visitor) {
    size_t offset = 0;
    while (offset < contents.size()) {
        size_t end = contents.find('\n', offset);
        if (end == std::string::npos) {
            end = contents.size();
        }
        if (end != offset) {
            visitor(contents.substr(offset, end - offset));
        }
        offset = end + 1;
    }
}

}  // namespace

struct Log::State {
    SemaphoreHandle_t mutex{};
    QueueHandle_t pending_logs{};
    bool storage_available{};
};

Log::State &Log::state() {
    static State instance;
    return instance;
}

void Log::setup() {
    State &log = state();
    log.mutex = xSemaphoreCreateMutex();
    log.pending_logs = xQueueCreate(kPendingLogCapacity, sizeof(PendingLog));
    if (log.mutex == nullptr || log.pending_logs == nullptr) {
        report_storage_error("Failed to initialize logging queue");
        return;
    }

    log.storage_available = LittleFS.begin(true);
    if (!log.storage_available) {
        report_storage_error("Failed to mount persistent log storage");
        return;
    }

    rotate_logs();
    LOGI("Persistent log storage ready");
}

void Log::write(const char *format, ...) {
    char message[kMaxLogMessageLength + 1]{};
    va_list arguments;
    va_start(arguments, format);
    const int result = std::vsnprintf(message, sizeof(message), format, arguments);
    va_end(arguments);
    if (result < 0) {
        return;
    }

    const size_t length = std::min(static_cast<size_t>(result), kMaxLogMessageLength);
    Serial.printf("%s\n", message);

    State &log = state();
    if (log.mutex == nullptr || xSemaphoreTake(log.mutex, portMAX_DELAY) != pdTRUE) {
        return;
    }
    append_to_current_file(message, length);
    enqueue(message, length);
    xSemaphoreGive(log.mutex);
}

void Log::visit_current_and_clear_pending(const LineVisitor &visitor) {
    State &log = state();
    if (!visitor || log.mutex == nullptr || log.pending_logs == nullptr ||
        xSemaphoreTake(log.mutex, portMAX_DELAY) != pdTRUE) {
        return;
    }

    xQueueReset(log.pending_logs);
    const std::string current = read_file(config::kCurrentLogFilePath);
    xSemaphoreGive(log.mutex);

    visit_lines(current, visitor);
}

bool Log::take_pending(std::string &message) {
    State &log = state();
    if (log.pending_logs == nullptr) {
        return false;
    }

    PendingLog pending{};
    if (xQueueReceive(log.pending_logs, &pending, 0) != pdTRUE) {
        return false;
    }
    message.assign(pending.message, pending.length);
    return true;
}

void Log::append_to_current_file(const char *message, size_t length) {
    State &log = state();
    if (!log.storage_available) {
        return;
    }

    File file = LittleFS.open(config::kCurrentLogFilePath, FILE_APPEND);
    if (!file) {
        report_storage_error("Failed to open current log file");
        return;
    }

    if (file.size() + length + 1 <= config::kMaxLogFileSize) {
        file.write(reinterpret_cast<const uint8_t *>(message), length);
        file.write('\n');
        return;
    }

    file.close();
    compact_and_append(message, length);
}

void Log::compact_and_append(const char *line, size_t length) {
    std::string retained;
    File file = LittleFS.open(config::kCurrentLogFilePath, FILE_READ);
    if (file) {
        const size_t file_size = file.size();
        const size_t keep_size = std::min(file_size, config::kMaxLogFileSize / 2);
        const size_t offset = file_size - keep_size;
        if (file.seek(offset)) {
            retained.resize(keep_size);
            retained.resize(file.read(reinterpret_cast<uint8_t *>(retained.data()), retained.size()));
        }
        file.close();

        if (offset != 0) {
            const size_t first_complete_line = retained.find('\n');
            retained.erase(0, first_complete_line == std::string::npos ? retained.size() : first_complete_line + 1);
        }
    }

    File output = LittleFS.open(config::kCurrentLogFilePath, FILE_WRITE);
    if (!output) {
        report_storage_error("Failed to rewrite current log file");
        return;
    }
    if (!retained.empty()) {
        output.write(reinterpret_cast<const uint8_t *>(retained.data()), retained.size());
    }
    output.write(reinterpret_cast<const uint8_t *>(line), length);
    output.write('\n');
}

void Log::enqueue(const char *message, size_t length) {
    State &log = state();
    if (log.pending_logs == nullptr) {
        return;
    }

    PendingLog pending{};
    pending.length = static_cast<uint16_t>(length);
    std::memcpy(pending.message, message, length);
    pending.message[length] = '\0';

    if (xQueueSend(log.pending_logs, &pending, 0) != pdTRUE) {
        PendingLog discarded{};
        xQueueReceive(log.pending_logs, &discarded, 0);
        xQueueSend(log.pending_logs, &pending, 0);
    }
}

void Log::rotate_logs() {
    const std::string oldest = history_file_path(config::kMaxHistoricalLogFiles);
    LittleFS.remove(oldest.c_str());

    for (size_t index = config::kMaxHistoricalLogFiles; index > 1; --index) {
        const std::string source = history_file_path(index - 1);
        if (!LittleFS.exists(source.c_str())) {
            continue;
        }
        const std::string destination = history_file_path(index);
        if (!move_file(source.c_str(), destination.c_str())) {
            report_storage_error("Failed to shift historical log file");
            return;
        }
    }

    if (LittleFS.exists(config::kCurrentLogFilePath)) {
        const std::string destination = history_file_path(1);
        if (!move_file(config::kCurrentLogFilePath, destination.c_str())) {
            report_storage_error("Failed to rotate current log file");
            return;
        }
    }

    File current = LittleFS.open(config::kCurrentLogFilePath, FILE_WRITE);
    if (!current) {
        report_storage_error("Failed to create current log file");
        return;
    }
    current.close();
}
