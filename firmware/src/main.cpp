#include "app.h"

namespace {

App app;

}  // namespace

void setup() { app.setup(); }

void loop() { app.tick(); }
