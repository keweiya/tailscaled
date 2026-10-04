#!/system/bin/sh
# Boot entry: start the daemon (unless the module is disabled) and watch the
# module's disable flag so toggling it in the manager takes effect immediately.
DIR=${0%/*}
. "${DIR}/../settings.ini"

start_service() {
  [ -f "${module_dir}/disable" ] && return 0
  "${tailscaled_service}" start >/dev/null 2>&1
}

start_inotifyd() {
  for _pid in $(pidof inotifyd 2>/dev/null); do
    if grep -q "${tailscaled_inotify}" "/proc/${_pid}/cmdline" 2>/dev/null; then
      kill -9 "${_pid}" 2>/dev/null
    fi
  done
  : > "${tailscaled_service_log}"
  echo "$(date +'%Y-%m-%d %H:%M:%S') [Info]: Starting tailscaled inotify service" >> "${tailscaled_service_log}"
  inotifyd "${tailscaled_inotify}" "${module_dir}" >> "${tailscaled_service_log}" 2>&1 &
}

mkdir -p "${tailscaled_run_dir}" 2>/dev/null
module_version=$(awk -F'=' '/^version=/ { print $2 }' "${module_prop}" 2>/dev/null)
log Info "tailscaled module version: ${module_version}"

start_service
start_inotifyd
