# Display Decoder Replay Tests

`decoder_replay_test.cpp` compiles the production decoder as ordinary C++ and replays all ten preserved SR800 CSV captures. It verifies Standby, stable values, each Edit selection, Heating, Cooling, stale-input fallback, and rejection of A/B disagreement.

The replay fixtures live in `data/captures/`; they are evidence, not generated test data. A new capture should be added only when it represents behavior the existing set does not cover.

The current suite passes 12 checks. Temporary executables belong in `tests/.build/` and are not project artifacts.