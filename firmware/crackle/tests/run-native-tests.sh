#!/usr/bin/env bash
# Build and run every native firmware test with g++, warnings as errors, under AddressSanitizer and
# UndefinedBehaviorSanitizer (the codecs parse uploaded files, so memory errors must fail the run).
set -u
cd "$(dirname "$0")"
out=$(mktemp -d)
declare -A deps=(
  [actuator_safety_test]=sr800_actuator.cpp
  [doc_store_test]=sr800_doc_store.cpp
  [journey_control_vector_test]=sr800_journey_control.cpp
  [live_delta_test]=sr800_live_delta.cpp
  [log_codec_test]=sr800_log_codec.cpp
  [query_args_test]=sr800_query_args.cpp
)
fail=0
for src in *_test.cpp; do
  name=${src%.cpp}
  dep=${deps[$name]:-}
  if ! g++ -std=c++17 -O1 -g -Wall -Wextra -Werror -fsanitize=address,undefined -fno-sanitize-recover=all -I fakes -I ../crackle "$src" ${dep:+../crackle/$dep} -o "$out/$name" 2> "$out/$name.log"; then
    echo "BUILD FAIL $name"; head -30 "$out/$name.log"; fail=1; continue
  fi
  if "$out/$name" > "$out/$name.run" 2>&1; then echo "PASS $name"; else echo "FAIL $name"; tail -20 "$out/$name.run"; fail=1; fi
done
exit $fail
