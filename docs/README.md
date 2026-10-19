# Documentation

Start with the [project README](../README.md), then follow the area you care about.

## System

| Document | Contents |
| --- | --- |
| [Architecture](architecture.md) | Components, ownership rules, and the lifecycle of a roast |
| [Design decisions](design-decisions.md) | The significant choices, the evidence behind them, and the rules that resulted |
| [Product specification](product-spec.md) | The behavioral contract: modes, safety, data ownership, storage, browser requirements |
| [Control and calibration](control-and-calibration.md) | Thermal model, journey control law, cross-language verification, calibration fitting |
| [Network architecture](network-architecture.md) | Execution lanes, live subscription protocol, capacity rules, OTA |
| [Testing](testing.md) | Test layers, how to run them, and how to choose what to run |

## Hardware

| Document | Contents |
| --- | --- |
| [SR800 hardware overview](../hardware/README.md) | What is inside the roaster and how Crackle connects to it |
| [Reverse engineering](../hardware/reverse-engineering.md) | How the electronics were studied and how the interface was chosen |
| [Board teardown](../hardware/board-teardown.md) | Component identification and PIC16F690 pin roles |
| [Power-stage interface](../hardware/power-stage-interface.md) | Measured trigger and zero-cross signals; the optocoupler interface |
| [Display interface](../hardware/display-interface.md) | Decoding the 74HC164 display bus |
| [Installation](../hardware/installation.md) | Parts, wiring, pin map, first flash, commissioning |
| [Safety checklist](../hardware/safety-checklist.md) | Checks after installation or rework |

## Firmware

| Document | Contents |
| --- | --- |
| [Firmware reference](../firmware/crackle/README.md) | Source layout, build, HTTP API, storage formats, executor, release |
| [Safety policy](../firmware/safety-policy.md) | Non-configurable safety invariants |
| [Actuator core](../firmware/actuator-core.md) | The hardware-timed actuator boundary |
| [Display sniffer](../firmware/sniffer/README.md) | The passive capture tool used during reverse engineering |

## Web app

| Document | Contents |
| --- | --- |
| [Web app reference](../web/README.md) | Running locally, screens, source layout, mock controller |
| [Controller integration](../web/docs/controller-integration.md) | The browser/device contract, path by path |
| [User workflows](../web/docs/user-workflows.md) | Roasting, catalog, history, calibration, and maintenance workflows |

## Evidence

| Document | Contents |
| --- | --- |
| [Data index](../data/README.md) | Logic captures, timing proofs, fan acoustics, and a sample roast recording |

## Authority

When documents disagree, the code and its tests are the authority for what is implemented. Among
documents, [product specification](product-spec.md) and [safety policy](../firmware/safety-policy.md)
are normative; the other documents explain and reference them. A change that intentionally alters
a contract updates the matching document in the same commit.
