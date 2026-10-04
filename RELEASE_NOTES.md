Self-contained KernelSU / Magisk / APatch module running `tailscaled` on a rooted Android device, with the routing it needs so browsers and apps can reach the tailnet and a peer's advertised subnets.

## Fixed: the daemon would not start

The previous builds used `GOOS=android`, which **cannot work** for a standalone daemon. `wgengine/router` takes its implementation from `router.HookNewUserspaceRouter`, and only `osrouter`'s platform files register it — while `osrouter/router_linux.go` is `//go:build !android`. Result:

```
wgengine.NewUserspaceEngine(tun "tailscale0") error: creating router: unsupported OS "android"
```

tailscaled exited immediately, so there was nothing to log into. (The official app only survives this by shipping its own Java `VpnService` router.) This build is **`GOOS=linux`**, and carries the three fixes a linux build needs on Android:

| Problem | Fix |
|---|---|
| Android's `main` table has no default route, but osrouter routes the daemon's own sockets with `ip rule … lookup main` → `network is unreachable` | the module keeps a default route in `main` and re-asserts it whenever netd rewrites the tables |
| Stock marks `0x40000`/`0x80000` collide with the permission bits of `netd`'s fwmark layout | `linuxfw-mark.patch` moves them to reserved bits (`0x10020000`) |
| A TPROXY proxy (Surfing/Clash) jumps `DIVERT` at mangle `PREROUTING` rule 1 and hijacks the tunnel's TCP replies — ping works, the browser hangs | `RETURN` for tunnel traffic is kept at rule 1 of `PREROUTING`, `OUTPUT` and nat `OUTPUT` |

## Subnets now need no configuration

osrouter puts the tailnet prefixes and **any subnet route you accept** into table 52 itself, at a rule preference ahead of netd's. So reaching `192.168.100.1` is just:

```
su -c 'tailscale set --accept-routes'
```

## Simpler, faster WebUI

Three tabs instead of five, and no route editing to do:

- **Status** — state, tailnet address, backend state, account, and three health checks (binary guard, default route, proxy exemption), Start/Stop/Restart and Login.
- **Settings** — Accept subnet routes, Accept DNS, Shields up, Advertise as an exit node, device name, and Log out.
- **Log** — one pane toggling between the daemon log and the diagnostic dump.

Polls every 15 s instead of 5 s, and the status command no longer makes a second
`tailscale status` call per refresh.

## Still true

- arm64 only; binary guard plus a CLI that refuses `tailscale update`.
- Tailscale SSH is not included (`ts_omit_ssh`).
- Advertising this device as an exit node works; *using* one does not.
- No UPX.
