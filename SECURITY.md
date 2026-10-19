# Security

## Threat model

Crackle is designed for one roaster on a trusted home network. The controller's web app and HTTP
API have **no authentication**: anyone who can reach the controller on the LAN can start a roast,
change settings, upload firmware, or erase the library. Do not expose the controller to the
internet, through port forwarding or otherwise, or put it on a network you do not trust.

What the design does guarantee regardless of network access is in the
[safety policy](firmware/safety-policy.md): firmware-enforced heat limits, fan-before-heat, sensor
and over-temperature latches, and a Stop that is always reachable. No network request can disable
those rules.

## Known limitation: the recovery access point

When the controller has no Wi-Fi network saved, or has lost its network for 15 seconds while idle,
it opens a recovery access point named `Crackle` with a fixed password (`freshroast`, published in
the [installation guide](hardware/installation.md#network-setup)). Anyone in range can join it while
it is up and reach the same unauthenticated API. To narrow this, change `kApPassword` in
`firmware/crackle/crackle/crackle.ino` and build your own image, and keep the controller on a
stable network so the access point stays off.

## Reporting a vulnerability

Crackle is a personal project shared as is, with no support, maintenance, or response commitment
(see the [license](LICENSE)). If you find a security problem, please don't post the details in a
public issue; you can report it privately through
[GitHub security advisories](https://github.com/triwebb1/crackle/security/advisories/new).
