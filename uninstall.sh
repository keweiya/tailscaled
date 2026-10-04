#!/system/bin/sh
# Clean removal: stop the daemon, drop the routing we installed, then delete the
# state directory and the boot script.
INSTALL_DIR="/data/adb/tailscale"
SERVICE_DIR="/data/adb/service.d"

if [ -x "${INSTALL_DIR}/scripts/tailscaled.service" ]; then
  "${INSTALL_DIR}/scripts/tailscaled.service" stop >/dev/null 2>&1
fi

# Belt and braces: make sure nothing of ours is left in the routing tables.
for pfx in $(sed -e 's/#.*//' -e 's/[[:space:]]//g' "${INSTALL_DIR}/routes" 2>/dev/null); do
  ip rule del to "$pfx" lookup 1099 pref 12000 2>/dev/null
  ip route del "$pfx" dev tailscale0 metric 1 2>/dev/null
done
ip route flush table 1099 2>/dev/null

rm -rf "${INSTALL_DIR}"
rm -f "${SERVICE_DIR}/tailscaled_service.sh"
