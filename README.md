# Tailscale for Android (KernelSU / Magisk module)

A self-contained module that runs `tailscaled` on a rooted Android device and
lets browsers and apps reach the tailnet and a peer's advertised subnets.

It is built **`GOOS=linux`** on purpose — see below — and carries the three fixes
that make a linux build survive Android.

Forked from [mgksu/tailscaled](https://github.com/mgksu/tailscaled) (itself a
fork of [anasfanani/Magisk-Tailscaled](https://github.com/anasfanani/Magisk-Tailscaled)).

---

## Why `GOOS=linux`, not `GOOS=android`

The obvious build for a phone is `GOOS=android`, and it is what most modules try.
It **cannot work for a standalone daemon**. `wgengine/router` gets its
implementation from `router.HookNewUserspaceRouter`, and that hook is only ever
registered by `osrouter`'s platform files — while `osrouter/router_linux.go`
carries `//go:build !android`. Build for android and the hook stays empty, so:

```
wgengine.NewUserspaceEngine(tun "tailscale0") error: creating router: unsupported OS "android"
getLocalBackend error: createEngine: creating router: unsupported OS "android"
```

tailscaled exits immediately. (The official Android app only avoids this because
it ships its own Java `VpnService` router and registers it on that hook.
`--tun=userspace-networking` also starts, but then nothing is routed at the
kernel level, so no browser or app could ever reach `192.168.100.1`.)

So this module builds `GOOS=linux` and makes the linux build survive Android.

### The one thing that breaks, and the fix

With `GOOS=linux`, osrouter is active and tags tailscaled's own sockets with the
**bypass mark**, routing them with `ip rule ... lookup main`. **Android's `main`
table has no default route** — netd keeps its default in per-network tables such
as `rmnet_data3` — so the daemon's own traffic to the control plane and DERP dies
with `network is unreachable` and the node never comes up.

The module therefore keeps a default route in `main` (plus a connected route for
the source subnet) and re-asserts it whenever netd rewrites the tables.

Two kernel-level collisions are handled too:

| Problem | Fix |
|---|---|
| Stock marks `0x40000` / `0x80000` collide with the **"permission" bits (18–19)** of Android's `netd` fwmark layout, misrouting the control plane | build patch moves them to reserved bits: `0x8000000` and `0x10020000` (`linuxfw-mark.patch`) |
| A TPROXY proxy (Surfing/Clash) jumps `DIVERT` at mangle `PREROUTING` rule 1 and hijacks the tunnel's TCP replies — ping works, the browser hangs | the module keeps `-i tailscale0 -j RETURN` at rule 1 of `PREROUTING`, `OUTPUT` and nat `OUTPUT`, re-asserted every 15 s |

Everything else is osrouter's job, and it does it well: it installs its rules at
preference 5210–5270 (ahead of netd's 11000) and puts the tailnet prefixes — plus
**any subnet route you accept** — into table 52. So there is no route management
to do by hand.

## Install

1. Download the latest `tailscaled-<version>.zip` from
   [Releases](https://github.com/keweiya/tailscaled/releases).
2. Install it in KernelSU / Magisk / APatch and reboot.
3. Log in:

```sh
su -c 'tailscale login'
su -c 'tailscale set --accept-dns=false'
```

`--accept-dns=false` is recommended: MagicDNS relies on a local DNS listener that
does not exist in this setup.

---

## Configuration: what lives where

Two directories matter. The **module directory** is what the manager installs and
replaces; the **state directory** holds everything that must survive an update.

```
/data/adb/modules/tailscaled/            module dir (replaced on update)
├── module.prop                          id/name/version; description shows the run state
├── system/bin/tailscale                 CLI wrapper (blocks `tailscale update`)
├── system/bin/tailscaled                daemon wrapper
├── system/bin/tailscaled.service        control-command wrapper
└── META-INF/ customize.sh               installer only

/data/adb/service.d/tailscaled_service.sh  boot entry (installed by customize.sh)

/data/adb/tailscale/                     state dir (KEPT across module updates)
├── settings.ini         <-- paths, TUN name, table id, rule priority
├── routes               optional manual prefixes (osrouter handles the normal case)
├── bin/
│   ├── tailscale        combined binary (CLI)
│   ├── tailscaled       combined binary (daemon)
│   ├── tailscaled.orig  known-good copy for the binary guard
│   └── tailscaled.sha256
├── scripts/             start.sh, tailscaled.service, tailscaled.inotify
└── run/                 state and logs
    ├── tailscaled.state     identity + Tailscale preferences (login lives here)
    ├── tailscaled.sock
    ├── tailscaled.log       daemon log
    ├── diag.log             what the routing logic did, step by step
    ├── runs.log / service.log
    └── tailscaled.pid / watchdog.pid
```

`settings.ini` and `routes` are only copied **on first install**, so your edits
survive module updates. Deleting them restores the defaults.

| What you want to change | Where |
|---|---|
| Which networks go through the tunnel | `/data/adb/tailscale/routes`, then `tailscaled.service restart` |
| TUN name / table id / rule priority (advanced) | `/data/adb/tailscale/settings.ini` |
| MagicDNS, hostname, SSH, exit node, `--accept-routes` | **not a file** — these are Tailscale preferences, set with the CLI and stored in `run/tailscaled.state`: `tailscale set --accept-dns=false`, `tailscale set --accept-routes`, `tailscale up --hostname=...` |
| Anything about a proxy | not in this module — see the coexistence section |

> `--accept-routes` and `routes` are complementary: `--accept-routes` makes
> `tailscaled` *accept* the advertised routes in its netmap, and `routes` makes
> the *kernel* send those destinations into the tunnel. Both are needed for a
> subnet to work.

## WebUI

The module ships a KernelSU / APatch WebUI: open it from the module card in the
manager. Three tabs, deliberately few controls:

| Tab | What it does |
|---|---|
| **Status** | state dot, tailnet address, `BackendState`, account, and three health checks (**binary**, **default route**, **proxy exemption**). Start / Stop / Restart, plus **Login**, which fetches a `login.tailscale.com` link and shows it as a tappable URL. Refreshes every 15 s. |
| **Settings** | switches for **Accept subnet routes**, **Accept DNS**, **Shields up** and **Advertise as an exit node**; a device **hostname** field; what this build cannot do (using an exit node, SSH, self-update) and **Log out**. |
| **Log** | one pane, toggling between the daemon log and the full diagnostic dump, with an auto-refresh switch and a clear button. |

The WebUI only calls the service script, so anything it does you can also do over
`adb shell` / a terminal with the commands below. If the status dot is red and
reads *unavailable*, the manager's root bridge is not answering — use the CLI.

## Commands

```sh
# service
tailscaled.service start|stop|restart|status
tailscaled.service routes            # routing that is installed (manual + discovered)
tailscaled.service routes-reload     # re-read the route files and apply
tailscaled.service routes-sync       # discover tailnet subnets and apply them
tailscaled.service diag              # full diagnostic dump
tailscaled.service webstatus         # machine-readable state (what the WebUI uses)
tailscaled.service prefs             # machine-readable Tailscale preferences
tailscaled.service log {runs|service|tailscaled|diag}

# preferences (whitelisted: accept-routes, accept-dns, shields-up,
# advertise-exit-node, advertise-routes, hostname, auto-update)
tailscaled.service set-pref accept-routes on
tailscaled.service set-pref accept-dns off
tailscaled.service set-pref advertise-routes 192.168.1.0/24
tailscaled.service logout

# the CLI, as usual
tailscale status
tailscale ip
tailscale ping <peer>
```

`tailscaled.service diag` prints the binary hash vs. the expected one, the daemon
and watchdog PIDs, the installed routes and rules, whether a proxy's `DIVERT`
jump is present, and the tail of the logs. **Start there when something is off.**

---

## Reaching a peer's advertised subnet

Nothing to configure by hand. osrouter installs accepted subnet routes into
table 52 for you, so it is two steps:

```sh
su -c 'tailscale set --accept-routes'
```

and the peer's route must be approved in the admin console. Then
`http://192.168.100.1` works in any browser.

The WebUI does the same thing: **Settings → Accept subnet routes**.

Check it with `tailscaled.service routes`, which prints table 52:

```
mode:                    osrouter (linux build) - tailscaled owns the routing
default route in main:   default via 10.20.30.1 dev rmnet_data3
tailnet in table 52:
  100.64.0.0/10 dev tailscale0
  192.168.100.0/24 dev tailscale0
```

`/data/adb/tailscale/routes` still exists as a manual fallback if you ever need
to force a prefix into the tunnel, but you should not need it.

## Coexisting with a proxy (Surfing / Clash / Mihomo / anything)

**You do not need to edit the proxy's configuration.** This module never marks or
reroutes anything except the tailnet prefixes, so it does not compete with a proxy
for traffic.

What a proxy *can* do is intercept the tunnel itself. On every start — and every
15 s afterwards — the module puts a `RETURN` for tunnel traffic at rule 1 of three
chains:

```sh
iptables -t mangle -I PREROUTING 1 -i tailscale0 -j RETURN   # replies coming back
iptables -t mangle -I OUTPUT     1 -o tailscale0 -j RETURN   # packets leaving
iptables -t nat    -I OUTPUT     1 -o tailscale0 -j RETURN   # REDIRECT-style proxies
```

These are harmless with no proxy installed (they simply return early for tunnel
traffic) and they name **no proxy**, so **switching to a different proxy module
needs no change here**. `tailscaled.service diag` shows whether each one is in
place.

### Why the inbound rule matters

Surfing's TPROXY inserts a `DIVERT` jump at mangle `PREROUTING` rule 1:

```sh
iptables -t mangle -I PREROUTING -p tcp -m socket -j DIVERT
```

It matches **TCP only** and has no interface condition. `DIVERT` marks
(`0x1000000`) and `ACCEPT`s the packet, so the SYN-ACK of every TCP connection
leaving through `tailscale0` is routed to the proxy's TPROXY port instead of the
local socket and **the handshake never completes**. ICMP is never matched, which
is why the symptom is the deceptive *"ping works, but the browser/curl hangs"*.

The exemption must be rule 1 **of `PREROUTING` itself**. Putting it inside
`BOX_EXTERNAL` does nothing, because `DIVERT` is evaluated first.

If you would rather do it in the proxy's own config, Surfing's
`ignore_out_list=("tailscale0")` handles the outbound direction — but it is not
required, and it does not fix the inbound direction.

## Notes and limitations

* **arm64 only.**
* **No Tailscale SSH** — built with `ts_omit_ssh`.
* **Using an exit node is not supported** (advertising this device as one is
  fine): that needs the daemon's own sockets kept out of the tunnel, which needs
  `SO_MARK`/`VpnService.protect`, and neither is available to a standalone
  daemon.
* **No UPX.** The binary is shipped uncompressed; UPX needs executable anonymous
  mappings, which some ROMs/SELinux policies refuse.

---

## Layout

```
META-INF/                 installer
customize.sh              installs to /data/adb/tailscale, stores the binary guard
service.sh                boot entry (waits for boot, then runs start.sh)
system/bin/               tailscale / tailscaled / tailscaled.service wrappers
webroot/                  KernelSU / APatch WebUI (index.html, app.js, ksu.js, style.css)
tailscale/settings.ini    all paths, prefixes, table ids  -> /data/adb/tailscale/
tailscale/routes          prefixes routed into the TUN     -> /data/adb/tailscale/
tailscale/scripts/        start.sh, tailscaled.service, tailscaled.inotify
uninstall.sh              stops the daemon and removes our routes
```

`settings.ini` and `routes` are only copied on first install, so your edits
survive module updates.

---

## Building

Pushing a tag / running the **Build tailscale for Android** workflow compiles
`tailscale/tailscale` for `GOOS=linux GOARCH=arm64` with tags
`ts_include_cli,ts_omit_ssh`, and applies `linuxfw-mark.patch` (the fwmark move
described above). The workflow asserts that `osrouter` **is** linked in and that
`0x1e020000` is present before packaging, so a silently wrong build cannot be
released. It then publishes a release plus an updated `update.json`.

---

## Credits

* [anasfanani/Magisk-Tailscaled](https://github.com/anasfanani/Magisk-Tailscaled) — original module
* [mgksu/tailscaled](https://github.com/mgksu/tailscaled) — the fork this is based on
* [Tailscale](https://tailscale.com) — BSD-3-Clause
