Self-contained KernelSU / Magisk / APatch module running a **`GOOS=android`** `tailscaled`.

## Why `GOOS=android` matters

With `GOOS=android`, Tailscale compiles out `wgengine/router/osrouter`, so `tailscaled` installs **no ip rules, no routes and no iptables chains**, and does not use `SO_MARK`. The official Android app supplies routing through Java `VpnService`; this module supplies the minimum itself — only the tailnet prefixes, only by destination.

The **official linux build** does the opposite: it tags its own sockets with `fwmark 0x80000` and routes them via `lookup main`, and installs `ts-*` iptables chains. Android's `main` table has no default route (it lives in per-network tables such as `rmnet_data3`), so the control plane dies with `network is unreachable` and the node stays `logged out`.

**That is exactly why `tailscale update` used to break this module** — it downloads that linux build.

## What this build adds over the upstream module

- **Binary guard**: a known-good copy plus sha256 is stored at install time; the service restores it whenever the binary was replaced, and the CLI refuses `tailscale update` outright.
- **Destination-scoped routing**: `ip route <prefix> dev tailscale0 table 1099` plus `ip rule to <prefix> lookup 1099`, for every prefix in `/data/adb/tailscale/routes` (default `100.64.0.0/10`). No marks, no iptables, nothing else on the device touched.
- **Advertised subnets, discovered automatically**: the module reads `Peer.PrimaryRoutes` from `tailscale status --json`, writes them to `routes.auto` and installs routing for them — on every start and every 60 s. Hand-written entries in `routes` are merged and never overwritten. (Upstream can only ever route `100.64.0.0/10`.)
- **Proxy coexistence, implementation-agnostic**: keeps `RETURN` for tunnel traffic at rule 1 of `mangle PREROUTING` (`-i`), `mangle OUTPUT` (`-o`) and `nat OUTPUT` (`-o`). It names no proxy, so **no proxy configuration has to change and swapping the proxy module needs no edits here**. This matters because Surfing/Clash TPROXY inserts a `DIVERT` jump at mangle PREROUTING rule 1 that matches TCP only and hijacks the SYN-ACK of every connection leaving through the tunnel: the browser hangs while ping keeps working.
- **Watchdog**: re-asserts the routing and the exemption every 15 s (Android's netd rewrites the tables on every network transition).
- **Diagnostics**: `tailscaled.service diag` (binary hash vs. expected, daemon and watchdog PIDs, routes, per-chain exemption verdict, logs) and `tailscaled.service routes`.

## WebUI

Open it from the module card in KernelSU / APatch.

- **Status** — live state, tailnet address, routed prefixes, binary-guard verdict,
  the three proxy-exemption verdicts, Start/Stop/Restart, Login (tappable
  `login.tailscale.com` link) and Log out.
- **Routes** — edit `routes` and apply live, plus **Discover** to pull the
  tailnet's subnet routes into `routes.auto`.
- **Features** — switches for Accept subnet routes / Accept DNS / Shields up /
  Advertise as an exit node, a hostname field and an advertised-routes field.
- **Log**, **Diagnostics** — daemon log (auto-refresh) and the full dump.

Every action is a call to `tailscaled.service`, so the whole UI is reproducible
from a terminal. Two things are deliberately **not** offered, with the reason
shown in the UI: using an exit node (a `GOOS=android` daemon cannot mark its own
sockets, so `0.0.0.0/0` into the tunnel loops) and Tailscale SSH (`ts_omit_ssh`).

## Usage

```
su -c 'tailscaled.service start'
su -c 'tailscale login'
su -c 'tailscale set --accept-dns=false'
su -c 'tailscaled.service diag'
```

## Notes

- **arm64 only.**
- Tailscale SSH is not included (`ts_omit_ssh`).
- No exit-node support: without `SO_MARK`/socket-protect, routing all traffic into the tunnel would loop the daemon's own packets.
- UPX is not used; it needs executable anonymous mappings, which some ROMs refuse.
