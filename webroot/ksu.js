// Thin promise wrapper over the KernelSU / APatch WebUI bridge.
// The manager injects a global `ksu` object; every command runs as root.

function bridgeAvailable() {
  return typeof ksu !== 'undefined' && typeof ksu.exec === 'function';
}

/**
 * Run a shell command as root.
 * @param {string} command
 * @param {{cwd?: string, env?: Record<string,string>}} [options]
 * @returns {Promise<{errno:number, stdout:string, stderr:string}>}
 */
export function exec(command, options = {}) {
  return new Promise((resolve) => {
    if (!bridgeAvailable()) {
      resolve({ errno: -1, stdout: '', stderr: 'KernelSU bridge unavailable' });
      return;
    }
    const cb = `__ksu_cb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    window[cb] = (errno, stdout, stderr) => {
      delete window[cb];
      resolve({ errno: Number(errno), stdout: stdout || '', stderr: stderr || '' });
    };
    try {
      ksu.exec(command, JSON.stringify(options), cb);
    } catch (e) {
      delete window[cb];
      resolve({ errno: -1, stdout: '', stderr: String(e) });
    }
  });
}

/** Show a native toast (falls back to a DOM toast handled by the caller). */
export function toast(message) {
  if (typeof ksu !== 'undefined' && typeof ksu.toast === 'function') {
    try { ksu.toast(String(message)); return true; } catch (_) { /* fall through */ }
  }
  return false;
}

export { bridgeAvailable };
