#!/system/bin/sh
# Installed as /data/adb/service.d/tailscaled_service.sh.
# Wait for boot to finish and for the network to become usable, then start the
# service. Starting the daemon before there is a route only produces failed
# control-plane dials; the service's own watchdog fixes the routing afterwards
# either way, but waiting makes the first attempt clean.
while [ "$(getprop sys.boot_completed)" != "1" ]; do
  sleep 2
done

# Bounded wait for an actually usable default route.
_i=0
while [ "$_i" -lt 30 ]; do
  [ -n "$(ip route get 8.8.8.8 2>/dev/null | head -n1)" ] && break
  sleep 2
  _i=$((_i + 2))
done

/data/adb/tailscale/scripts/start.sh
