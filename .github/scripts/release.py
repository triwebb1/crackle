#!/usr/bin/env python3
"""Release checks and packaging for Crackle.

  release.py check [--tag vYYYY-MM-DD.NNN]
      The firmware version, the web app version, the embedded bundle, the changelog, and the
      versions stated in the docs agree (and match the tag, when one is given).

  release.py check-bundle [--dist web/dist]
      The web app embedded in crackle_bundle.h is exactly the one built from this source: each
      embedded file, decompressed, is byte-identical to the fresh production build.

  release.py package --build <arduino build dir> --out <dist dir>
      Writes the downloadable release: the OTA application image, a first-install serial package,
      debug symbols, SHA256SUMS.txt, and release-notes.md.

Standard library only, so it runs unchanged on a CI runner and on a workstation.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKETCH = ROOT / "firmware/crackle/crackle/crackle.ino"
BUNDLE = ROOT / "firmware/crackle/crackle/crackle_bundle.h"
PACKAGE_JSON = ROOT / "web/package.json"
CHANGELOG = ROOT / "CHANGELOG.md"
# Documents that state the current versions in prose; `check` keeps them in step with the source.
VERSIONED_DOCS = ["README.md", "web/README.md", "firmware/crackle/README.md", "docs/product-spec.md"]
APP_SLOT_BYTES = 0x180000
ESP32_CORE = "3.3.10"


def firmware_version() -> str:
    match = re.search(r'kFirmwareVersion\[\]\s*=\s*"([^"]+)"', SKETCH.read_text(encoding="utf-8"))
    if not match:
        sys.exit("kFirmwareVersion not found in crackle.ino")
    return match.group(1)


def web_version() -> str:
    return json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["version"]


def bundle_version() -> str:
    match = re.search(r'kCrackleBundleVersion\[\]\s*=\s*"([^"]+)"', BUNDLE.read_text(encoding="utf-8"))
    if not match:
        sys.exit("kCrackleBundleVersion not found in crackle_bundle.h")
    return match.group(1)


def changelog_section(firmware: str, web: str) -> str:
    """The changelog entry for exactly this firmware/web pair, without its heading."""
    text = CHANGELOG.read_text(encoding="utf-8")
    heading = f"## {firmware} / web {web}"
    start = text.find(heading + "\n")
    if start < 0:
        sys.exit(f"CHANGELOG.md has no section headed '{heading}'")
    body = text[start + len(heading) + 1:]
    following = re.search(r"^## ", body, flags=re.MULTILINE)
    return (body[:following.start()] if following else body).strip()


def check(tag: str | None) -> None:
    firmware, web, bundle = firmware_version(), web_version(), bundle_version()
    problems = []
    if bundle != web:
        problems.append(f"crackle_bundle.h embeds web {bundle} but web/package.json is {web}; rebuild and embed the web app")
    if tag is not None and tag != f"v{firmware}":
        problems.append(f"tag {tag} does not match kFirmwareVersion {firmware} (expected v{firmware})")
    changelog_section(firmware, web)
    for name in VERSIONED_DOCS:
        text = (ROOT / name).read_text(encoding="utf-8")
        stated = re.findall(r"`(2026-07-26\.\d+|0\.\d+\.\d+)`", text)
        if not stated:
            problems.append(f"{name} no longer states the current version")
        for version in stated:
            if version not in (firmware, web):
                problems.append(f"{name} says {version}; the source is firmware {firmware}, web {web}")
    if problems:
        sys.exit("\n".join(problems))
    print(f"versions agree: firmware {firmware}, web {web}" + (f", tag {tag}" if tag else ""))


def check_bundle(dist: Path) -> None:
    header = BUNDLE.read_text(encoding="utf-8")
    embedded = {}
    for symbol, name in re.findall(r'k(\w+)FileName\[\] = "([^"]+)"', header):
        body = re.search(r"k" + symbol + r"Gz\[\] PROGMEM = \{(.*?)\};", header, flags=re.S)
        if not body:
            sys.exit(f"crackle_bundle.h has no data for {name}")
        embedded[name] = gzip.decompress(bytes(int(byte, 16) for byte in re.findall(r"0x([0-9a-f]{2})", body.group(1))))
    built = {path.name: path.read_bytes() for path in dist.rglob("*") if path.is_file()}
    problems = []
    if sorted(embedded) != sorted(built):
        problems.append(f"embedded files {sorted(embedded)} differ from the build's {sorted(built)}")
    problems += [f"{name} differs from the fresh build" for name in embedded if name in built and embedded[name] != built[name]]
    if problems:
        sys.exit("crackle_bundle.h does not match the web source; run `npm --prefix web run embed` "
                 "and commit it:\n" + "\n".join(problems))
    print(f"crackle_bundle.h matches the fresh build ({len(embedded)} files)")


def repository_url() -> str:
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    return f"{server}/{os.environ.get('GITHUB_REPOSITORY', 'triwebb1/crackle')}"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def flash_layout(build: Path) -> list[tuple[str, str]]:
    """(offset, file) pairs from the build's flash_args, in flashing order."""
    pairs = []
    for line in (build / "flash_args").read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].startswith("0x"):
            pairs.append((parts[0], parts[1]))
    names = [name for _, name in pairs]
    for required in ("crackle.ino.bootloader.bin", "crackle.ino.partitions.bin", "boot_app0.bin", "crackle.ino.bin"):
        if required not in names:
            sys.exit(f"flash_args does not list {required}")
    return pairs


FLASHING_GUIDE = """# Crackle {firmware}: first install over USB

Use this package once, to install Crackle on a blank or recovered ESP32-S3-Zero. Every later update
goes over Wi-Fi with crackle-{firmware}-ota.bin at http://crackle.local/update.

SAFETY: unplug the roaster from mains AND disconnect the controller's USB charger before connecting
a computer. The controller shares the roaster's potentially mains-referenced logic ground. Keep
mains disconnected for the whole USB session, and unplug the computer before restoring mains.

1. Install esptool (https://docs.espressif.com/projects/esptool/), for example `pip install esptool`.
2. Hold the board's BOOT button while connecting USB, then release it.
3. From this folder, replacing PORT with the board's serial port (COM3, /dev/ttyACM0, ...):

   esptool --chip esp32s3 --port PORT write-flash {layout}

This writes the bootloader, partition table, OTA selector, and application at explicit offsets.
It erases nothing else, so Wi-Fi settings, calibration, and the roast library on an existing
controller are preserved. Then follow the commissioning steps in hardware/installation.md.
"""


def package(build: Path, out: Path) -> None:
    firmware, web = firmware_version(), web_version()
    application = build / "crackle.ino.bin"
    size = application.stat().st_size
    if size >= APP_SLOT_BYTES:
        sys.exit(f"application image is {size} bytes; the OTA slot holds {APP_SLOT_BYTES}")
    out.mkdir(parents=True, exist_ok=True)
    stem = f"crackle-{firmware}"

    ota = out / f"{stem}-ota.bin"
    ota.write_bytes(application.read_bytes())

    layout = flash_layout(build)
    serial = out / f"{stem}-serial.zip"
    with zipfile.ZipFile(serial, "w", zipfile.ZIP_DEFLATED) as archive:
        for _, name in layout:
            archive.write(build / name, f"{stem}-serial/{name}")
        archive.writestr(f"{stem}-serial/FLASHING.md", FLASHING_GUIDE.format(
            firmware=firmware, layout=" ".join(f"{offset} {name}" for offset, name in layout)))
        archive.writestr(f"{stem}-serial/SHA256SUMS.txt", "".join(
            f"{sha256(build / name)}  {name}\n" for _, name in layout))

    symbols = out / f"{stem}-elf.zip"
    with zipfile.ZipFile(symbols, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(build / "crackle.ino.elf", f"{stem}.elf")
        archive.write(build / "crackle.ino.map", f"{stem}.map")

    assets = [ota, serial, symbols]
    (out / "SHA256SUMS.txt").write_text("".join(f"{sha256(path)}  {path.name}\n" for path in assets), encoding="utf-8")

    rows = [
        (ota, f"Update an installed controller at `http://crackle.local/update` ({size:,} of {APP_SLOT_BYTES:,} bytes)"),
        (serial, "First install over USB on a blank ESP32-S3-Zero: bootloader, partition table, OTA selector, application, and `FLASHING.md`"),
        (symbols, "Debug symbols for decoding a stored crash report (`system.stored_crash` in `/api/status`)"),
    ]
    notes = [
        f"Firmware `{firmware}` with web app `{web}`.",
        "",
        changelog_section(firmware, web),
        "",
        "## Downloads",
        "",
        "| File | Use | SHA-256 |",
        "| --- | --- | --- |",
        *[f"| `{path.name}` | {use} | `{sha256(path)}` |" for path, use in rows],
        "",
        "## Install",
        "",
        "- **Update an installed controller:** with the roaster idle, open `http://crackle.local/update` and "
        f"upload `{ota.name}`. The image is written to the inactive slot and validated before it is selected.",
        f"- **First install:** unzip `{serial.name}` and follow `FLASHING.md`, with roaster mains and the "
        "controller's charger disconnected. Then commission it with the "
        f"[safety checklist]({repository_url()}/blob/main/hardware/safety-checklist.md).",
        "",
        "Verify downloads with `sha256sum -c SHA256SUMS.txt` (or `Get-FileHash` on Windows).",
        "",
        f"Built by GitHub Actions from this tag with ESP32 Arduino core {ESP32_CORE}; esptool verified the image checksum and validation hash.",
        "",
    ]
    (out / "release-notes.md").write_text("\n".join(notes), encoding="utf-8")
    for path in assets:
        print(f"{path.name}  {path.stat().st_size:,} bytes  {sha256(path)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    check_parser = commands.add_parser("check")
    check_parser.add_argument("--tag")
    bundle_parser = commands.add_parser("check-bundle")
    bundle_parser.add_argument("--dist", type=Path, default=ROOT / "web/dist")
    package_parser = commands.add_parser("package")
    package_parser.add_argument("--build", type=Path, required=True)
    package_parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "check":
        check(args.tag)
    elif args.command == "check-bundle":
        check_bundle(args.dist)
    else:
        package(args.build, args.out)


if __name__ == "__main__":
    main()
