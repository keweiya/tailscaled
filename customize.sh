#!/system/bin/sh
SKIPUNZIP=0
SKIPMOUNT=false

if [ "$BOOTMODE" != true ]; then
  ui_print "! Please install in Magisk / KernelSU / APatch Manager"
  ui_print "! Install from recovery is NOT supported"
  abort "-----------------------------------------------------------"
elif [ "$KSU" = true ] && [ "$KSU_VER_CODE" -lt 10670 ]; then
  abort "error: Please update your KernelSU and KernelSU Manager"
fi

if [ "$ARCH" != "arm64" ]; then
  abort "! Unsupported architecture: $ARCH (arm64 only)"
fi

SERVICE_DIR="/data/adb/service.d"
INSTALL_DIR="/data/adb/tailscale"
INSTALL_BIN_DIR="$INSTALL_DIR/bin"

if [ -f "$INSTALL_DIR/scripts/tailscaled.service" ]; then
  ui_print "- Stopping the running tailscaled service"
  "$INSTALL_DIR/scripts/tailscaled.service" stop >/dev/null 2>&1
fi

ui_print "- Creating directories"
mkdir -p "$INSTALL_DIR" "$INSTALL_BIN_DIR" "$SERVICE_DIR"

# The combined binary serves as both the daemon and the CLI.
ui_print "- Installing binaries"
mv -f "$MODPATH/files/tailscale.combined" "$INSTALL_BIN_DIR/tailscale"
cp -f "$INSTALL_BIN_DIR/tailscale" "$INSTALL_BIN_DIR/tailscaled"

# Keep a known-good copy of the binary plus its checksum. `tailscale update`
# downloads the OFFICIAL upstream release, which is compiled for GOOS=linux and
# therefore activates Tailscale's osrouter (fwmark/lookup main/ts-* iptables
# chains) that cannot work on Android - that is what blocks the link. The
# service compares the hashes on every start and restores this copy.
ui_print "- Storing the known-good binary copy"
cp -f "$INSTALL_BIN_DIR/tailscaled" "$INSTALL_BIN_DIR/tailscaled.orig"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$INSTALL_BIN_DIR/tailscaled.orig" | awk '{print $1}' > "$INSTALL_BIN_DIR/tailscaled.sha256"
elif command -v busybox >/dev/null 2>&1; then
  busybox sha256sum "$INSTALL_BIN_DIR/tailscaled.orig" | awk '{print $1}' > "$INSTALL_BIN_DIR/tailscaled.sha256"
fi
[ -s "$INSTALL_BIN_DIR/tailscaled.sha256" ] || ui_print "! could not compute the checksum (guarded by size instead)"

# Scripts / settings. Copy without overwriting an existing settings.ini or routes
# file so local edits survive an update.
ui_print "- Installing scripts"
mkdir -p "$INSTALL_DIR/scripts"
cp -f "$MODPATH"/tailscale/scripts/* "$INSTALL_DIR/scripts/"
for f in settings.ini routes; do
  if [ -f "$INSTALL_DIR/$f" ]; then
    ui_print "  keeping existing $INSTALL_DIR/$f"
  else
    cp -f "$MODPATH/tailscale/$f" "$INSTALL_DIR/$f" 2>/dev/null
  fi
done

rm -rf "$MODPATH/files" "$MODPATH/tailscale"

ui_print "- Setting permissions"
set_perm_recursive "$INSTALL_DIR" 0 0 0755 0755
set_perm_recursive "$MODPATH/system/bin" 0 0 0755 0755
# KernelSU / APatch read the WebUI from the module directory itself.
[ -d "$MODPATH/webroot" ] && set_perm_recursive "$MODPATH/webroot" 0 0 0755 0644
set_perm "$MODPATH/service.sh" 0 0 0755
mv -f "$MODPATH/service.sh" "$SERVICE_DIR/tailscaled_service.sh"

ui_print "-----------------------------------------------------------"
ui_print " Instructions"
ui_print "-----------------------------------------------------------"
ui_print "- Reboot the device."
ui_print "- Open this module's card in the manager for the WebUI:"
ui_print "  Status / Routes / Features / Log / Diagnostics"
ui_print ""
ui_print "- Or from a terminal:"
ui_print "  su -c 'tailscaled.service start'"
ui_print "  su -c 'tailscale login'"
ui_print "  su -c 'tailscaled.service diag'"
ui_print ""
ui_print "- To reach a peer's advertised subnet (e.g. 192.168.100.0/24):"
ui_print "  su -c 'tailscale set --accept-routes'"
ui_print "  (the route must also be approved in the admin console)"
ui_print ""
ui_print "! Do NOT run 'tailscale update': it installs the official"
ui_print "! GOOS=linux binary, which cannot work here. The service"
ui_print "! detects and reverts it, but simply avoid it."
