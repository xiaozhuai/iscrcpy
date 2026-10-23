#pragma once

#include <optional>
#include <string>

namespace settings {

void set_wifi_ssid(const std::string &ssid);
std::string get_wifi_ssid();
void set_wifi_password(const std::string &password);
std::optional<std::string> get_wifi_password();

void set_hostname(const std::string &hostname);
std::string get_hostname();
void set_device_name(const std::string &device_name);
std::string get_device_name();
void set_access_token(const std::string &access_token);
std::optional<std::string> get_access_token();

}  // namespace settings
