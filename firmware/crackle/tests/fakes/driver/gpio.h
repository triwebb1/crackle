#pragma once
using gpio_num_t = int;
constexpr gpio_num_t GPIO_NUM_NC = -1;
int gpio_set_level(gpio_num_t pin, int level);