# Tailscale for Android (KernelSU / Magisk module)

A self-contained module that runs a **`GOOS=android`** `tailscaled` on a rooted
Android device, with the routing it needs, and lets browsers and apps reach the
tailnet and advertised subnets.

Forked from [mgksu/tailscaled](https://github.com/mgksu/tailscaled) (itself a
fork of [anasfanani/Magisk-Tailscaled](https://github.com/anasfanani/Magisk-Tailscaled)).

---

## Why `GOOS=android` is the whole point

Tailscale's kernel routing lives in `wgengine/router/osrouter`, and that package
is compiled out on Android:

```go
// wgengine/router/osrouter/router_linux.go
//go:build !android
```

So a `GOOS=android` `tailscaled`:

* installs **no** `ip rule`s and **no** routes,
* installs **no** `ts-input` / `ts-forward` / `ts-postrouting` iptables chains,
* never sets `SO_MARK` (`netns.UseSocketMark()` returns `false`).

The official Android app supplies routing through Java `VpnService`. A standalone
daemon has to supply it itself — that is what this module does, with the smallest
possible footprint.

### The failure this avoids

The **official linux build** (what `pkgs.tailscale.com` ships, and what
`tailscale update` downloads) does the opposite. It tags its own sockets with
`fwmark 0x80000` and routes them through `lookup main`, and it installs iptables
chains. On Android the `main` routing table has no default route
(Android keeps its default route in per-network tables such as `rmnet_data3`),
so the control plane dies with `network is unreachable` and the node stays
`logged out`.

**Consequence: never run `tailscale update`.** It replaces the module's binary
with the linux one and blocks the link. This module defends against that twice:

1. `system/bin/tailscale` refuses the `update` subcommand.
2. On every start the service compares the binary against a stored checksum and
   restores the known-good copy if it was replaced.

---

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

## Commands

```sh
tailscaled.service start|stop|restart|status
tailscaled.service routes        # show the routing that is installed
tailscaled.service diag          # full diagnostic dump
tailscaled.service log {runs|service|tailscaled|diag}

tailscale status
tailscale ip
tailscale ping <peer>
tailscale set --accept-dns=false
```

`tailscaled.service diag` prints the binary hash vs. the expected one, the daemon
and watchdog PIDs, the installed routes and rules, whether a proxy's `DIVERT`
jump is present, and the tail of the logs. **Start there when something is off.**

---

## Reaching advertised subnets

A `GOOS=android` daemon has no `osrouter`, so `--accept-routes` cannot install
kernel routes. List the prefixes you want instead — one per line in
`/data/adb/tailscale/routes`:

```
100.64.0.0/10
192.168.100.0/24
```

```sh
su -c 'tailscaled.service restart'
```

The prefix must be advertised by a peer (`tailscale up
--advertise-routes=192.168.100.0/24`) and approved in the admin console. Then
`http://192.168.100.1` works in any browser.

Under the hood this is only:

```sh
ip route replace <prefix> dev tailscale0 table 1099
ip rule  add to <prefix> lookup 1099 pref 12000
```

Selection is **by destination**: nothing else on the device is touched, so a
proxy's rules are never disturbed.

---

## Coexisting with Surfing / Clash / Mihomo

This module does not fight the proxy, because it never marks or reroutes anything
except the tailnet prefixes. One thing does need care:

Surfing's TPROXY insert a `DIVERT` jump at mangle `PREROUTING` rule 1:

```sh
iptables -t mangle -I PREROUTING -p tcp -m socket -j DIVERT
```

It matches **TCP only** with no interface condition, and `DIVERT` marks
(`0x1000000`) and `ACCEPT`s the packet. The SYN-ACK of every TCP connection
leaving through `tailscale0` therefore gets routed to the proxy's TPROXY port
instead of the local socket: **the handshake never completes**. ICMP is never
matched, so the symptom is the deceptive *"ping works, but the browser/curl
hangs"*.

The module keeps an exemption ahead of it:

```sh
iptables -t mangle -I PREROUTING 1 -i tailscale0 -j RETURN
```

The watchdog re-asserts it every 15 s, so it survives a proxy reload, an app
toggle, or a Surfing update that rewrites its firewall.

> The exemption must live in `PREROUTING` itself. Putting it inside
> `BOX_EXTERNAL` does nothing, because `DIVERT` is evaluated first.

---

## Notes and limitations

* **arm64 only.**
* **No Tailscale SSH** — built with `ts_omit_ssh` (`feature/ssh` excludes
  android while `cmd/tailscaled/ssh.go` does not, so it cannot be linked).
* **No exit node** support. There is no `SO_MARK`/socket-protect on Android, so
  routing *all* traffic into the tunnel would loop the daemon's own packets.
  Only the listed prefixes are routed, so there is no loop — but an exit node
  will not work either.
* **No UPX.** The binary is shipped uncompressed; UPX requires executable
  anonymous mappings, which some ROMs/SELinux policies refuse.

---

## Layout

```
META-INF/                 installer
customize.sh              installs to /data/adb/tailscale, stores the binary guard
service.sh                boot entry (waits for boot, then runs start.sh)
system/bin/               tailscale / tailscaled / tailscaled.service wrappers
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
`tailscale/tailscale` for `GOOS=android GOARCH=arm64` with:

```
ts_include_cli,ts_omit_ssh,ts_omit_systray,ts_omit_syslog,ts_omit_dbus,ts_omit_resolved,ts_omit_networkmanager
```

and one source patch: the resolver path becomes `/data/adb/tailscale/resolv.conf`
(Android has no usable `/etc/resolv.conf`). The workflow verifies the resulting
binary contains no `osrouter` code before packaging, and publishes a release plus
an updated `update.json`.

---

## Credits

* [anasfanani/Magisk-Tailscaled](https://github.com/anasfanani/Magisk-Tailscaled) — original module
* [mgksu/tailscaled](https://github.com/mgksu/tailscaled) — the fork this is based on
* [Tailscale](https://tailscale.com) — BSD-3-Clause
