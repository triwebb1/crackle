#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "../crackle/sr800_query_args.h"

int main() {
  using sr800::network::QueryArgs;
  char value[80] = {};

  QueryArgs merged("ssid=Body+Network&password=p%40ssword", "ssid=Query&fan=4.5");
  assert(merged.text("ssid", value, sizeof(value)));
  assert(strcmp(value, "Body Network") == 0);
  assert(merged.text("password", value, sizeof(value)));
  assert(strcmp(value, "p@ssword") == 0);
  assert(merged.text("fan", value, sizeof(value)));
  assert(strcmp(value, "4.5") == 0);

  uint32_t milli = 0;
  assert(merged.levelMilli("fan", milli) && milli == 4500);
  assert(!QueryArgs("bad=%GG").text("bad", value, sizeof(value)));
  assert(!QueryArgs("nul=%00").text("nul", value, sizeof(value)));
  assert(!QueryArgs("too_long=abcdef").text("too_long", value, 4));
  return 0;
}