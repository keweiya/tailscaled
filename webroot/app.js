import { exec, toast as nativeToast } from './ksu.js';

const STATE_DIR = '/data/adb/tailscale';
const ROUTES_FILE = `${STATE_DIR}/routes`;
const DAEMON_LOG = `${STATE_DIR}/run/tailscaled.log`;
const DIAG_LOG = `${STATE_DIR}/run/diag.log`;
const SVC = 'tailscaled.service';

const $ = (id) => document.getElementById(id);
const state = { status: {}, prefs: {}, busy: false, autoLog: false, logTimer: null };

/* ------------------------------------------------------------------ toast -- */
function toast(message, kind = 'info') {
  if (nativeToast(message)) return;
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 3500);
}

/* ------------------------------------------------------------------- run ---- */
async function run(command, { quiet = false } = {}) {
  const res = await exec(command);
  if (res.errno !== 0 && !quiet) {
    const msg = (res.stderr || res.stdout || `exit ${res.errno}`).trim().split('\n').pop();
    toast(msg.slice(0, 160), 'error');
  }
  return res;
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('button[data-action]').forEach((b) => { b.disabled = busy; });
  $('refresh').disabled = busy;
}

/* ---------------------------------------------------------------- status ---- */
function parseKv(text) {
  const out = {};
  text.split('\n').forEach((line) => {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return out;
}

async function refreshStatus({ silent = true } = {}) {
  const res = await run(`${SVC} webstatus`, { quiet: true });
  if (res.errno !== 0 && !res.stdout) {
    $('status-main').textContent = 'unavailable';
    $('dot').className = 'dot bad';
    return;
  }
  const s = parseKv(res.stdout);
  state.status = s;

  const running = s.daemon === '1';
  $('dot').className = `dot ${running ? (s.backend === 'Running' ? 'good' : 'warn') : 'bad'}`;
  $('status-main').textContent = running
    ? (s.backend || 'running')
    : 'stopped';
  $('status-sub').textContent = running
    ? `${s.ip4 || 'no address'}${s.user ? ` · ${s.user}` : ''}`
    : 'tailscaled is not running';

  $('v-version').textContent = s.version || '-';
  $('v-daemon').textContent = running ? `running (${s.pid || '?'})` : 'stopped';
  $('v-watchdog').textContent = s.watchdog === '1' ? `running (${s.watchdog_pid || '?'})` : 'not running';
  $('v-iface').textContent = s.iface || '-';
  $('v-ip').textContent = s.ip4 || '-';
  $('v-routes').textContent = s.routes || '-';
  $('v-binary').textContent = s.binary_ok === '1' ? 'verified (matches pristine copy)' : 'CHANGED - will be restored';
  $('v-binary').className = s.binary_ok === '1' ? '' : 'bad';

  const ex = `${s.exempt_prerouting || '?'} / ${s.exempt_output || '?'} / ${s.exempt_nat || '?'}`;
  $('v-exempt').textContent = `${ex} (pre/out/nat)`;
  $('v-exempt').className = (s.exempt_prerouting === 'OK' && s.exempt_output === 'OK')
    ? '' : 'warn';

  $('health').textContent = s.health || '';
  $('health').style.display = s.health ? '' : 'none';

  if (!silent) toast('status refreshed');
}

/* ---------------------------------------------------------------- actions --- */
async function action(name) {
  setBusy(true);
  try {
    await run(`${SVC} ${name}`);
    await new Promise((r) => setTimeout(r, 1200));
    await refreshStatus();
    toast(`service ${name} done`);
  } finally {
    setBusy(false);
  }
}

function extractUrl(text) {
  const m = String(text).match(/https:\/\/login\.tailscale\.com\/[A-Za-z0-9/?=&_.-]+/);
  return m ? m[0] : '';
}

async function login() {
  setBusy(true);
  try {
    toast('requesting a login link…');
    const res = await run(`tailscale up --timeout=8s`, { quiet: true });
    const url = extractUrl(`${res.stdout}\n${res.stderr}`);
    if (url) {
      $('login-url').href = url;
      $('login-url').textContent = url;
      $('login-box').style.display = '';
      toast('login link ready - tap it');
    } else if (/already logged in|Logged in/i.test(res.stdout)) {
      toast('already logged in');
    } else {
      const tail = (res.stdout || res.stderr || '').trim().split('\n').slice(-3).join(' ');
      toast(tail.slice(0, 160) || 'no login link returned', 'error');
    }
    await refreshStatus();
  } finally {
    setBusy(false);
  }
}

/* ----------------------------------------------------------------- routes --- */
async function loadRoutes() {
  const res = await run(`cat ${ROUTES_FILE}`, { quiet: true });
  $('routes').value = res.errno === 0 ? res.stdout : '';
}

function validateRoutes(text) {
  if (text.includes('ROUTES_EOF')) return 'the text must not contain the line ROUTES_EOF';
  const bad = text.split('\n').find((l) => l.trim() && !/^[0-9a-fA-F:.\/\s#]+$/.test(l));
  return bad ? `invalid line: ${bad.trim()}` : '';
}

async function saveRoutes() {
  const text = $('routes').value;
  const err = validateRoutes(text);
  if (err) { toast(err, 'error'); return; }
  if (!text.trim()) { toast('refusing to write an empty file', 'error'); return; }

  setBusy(true);
  try {
    const cmd = `cat > ${ROUTES_FILE} <<'ROUTES_EOF'\n${text}\nROUTES_EOF\n${SVC} routes-reload`;
    const res = await run(cmd, { quiet: true });
    if (res.errno === 0) {
      toast('routes saved and applied');
      await refreshStatus();
    } else {
      toast((res.stderr || 'save failed').trim().slice(0, 160), 'error');
    }
  } finally {
    setBusy(false);
  }
}

async function resetRoutes() {
  $('routes').value = '# Tailscale address range. Do not remove.\n100.64.0.0/10\n\n'
    + '# Advertised subnet routes, one per line, e.g.:\n# 192.168.100.0/24\n';
  toast('default content loaded - press Save to apply');
}

/* -------------------------------------------------------------------- logs --- */
async function loadLog() {
  const res = await run(`tail -n 300 ${DAEMON_LOG} 2>/dev/null || echo "(no daemon log yet)"`, { quiet: true });
  const el = $('log');
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  el.textContent = res.stdout || '(empty)';
  if (stick) el.scrollTop = el.scrollHeight;
}

async function loadDiag() {
  const res = await run(`${SVC} diag`, { quiet: true });
  $('diag').textContent = res.stdout || res.stderr || '(no output)';
}

async function clearLogs() {
  await run(`: > ${DAEMON_LOG}; : > ${DIAG_LOG}`, { quiet: true });
  await loadLog();
  await loadDiag();
  toast('logs cleared');
}

function toggleAutoLog() {
  state.autoLog = !state.autoLog;
  $('auto').textContent = state.autoLog ? 'auto: on' : 'auto: off';
  $('auto').classList.toggle('on', state.autoLog);
  clearInterval(state.logTimer);
  if (state.autoLog) state.logTimer = setInterval(loadLog, 3000);
}

/* ---------------------------------------------------------------- features --- */
const SWITCHES = {
  'sw-accept-routes': 'accept-routes',
  'sw-accept-dns': 'accept-dns',
  'sw-shields-up': 'shields-up',
  'sw-advertise-exit-node': 'advertise-exit-node',
};

function setSwitch(id, on) {
  const el = $(id);
  el.checked = on;
  el.closest('.switch-row').classList.toggle('on', on);
}

function discoveredList() {
  return ((state.prefs || {}).discovered || '').split(',').filter(Boolean);
}

function renderDiscovered() {
  const list = discoveredList();
  $('discovered').textContent = list.length ? list.join('\n') : '(none discovered yet)';
}

async function loadPrefs() {
  const res = await run(`${SVC} prefs`, { quiet: true });
  if (!res.stdout) { $('discovered').textContent = 'tailscaled is not running'; return; }
  const p = parseKv(res.stdout);
  state.prefs = p;
  setSwitch('sw-accept-routes', p.accept_routes === '1');
  setSwitch('sw-accept-dns', p.accept_dns === '1');
  setSwitch('sw-shields-up', p.shields_up === '1');
  setSwitch('sw-advertise-exit-node', (p.advertise_routes || '').indexOf('0.0.0.0/0') >= 0);
  if (document.activeElement !== $('in-hostname')) $('in-hostname').value = p.hostname || '';
  renderDiscovered();
}

async function togglePref(id) {
  const key = SWITCHES[id];
  const el = $(id);
  const want = el.checked;
  el.disabled = true;
  const res = await run(`${SVC} set-pref ${key} ${want ? 'on' : 'off'}`, { quiet: true });
  if (res.errno === 0) {
    toast(`${key} ${want ? 'enabled' : 'disabled'}`);
    await loadPrefs();
    await refreshStatus();
  } else {
    const msg = (res.stderr || res.stdout || '').trim().split('\n').pop();
    toast((msg || `${key} failed`).slice(0, 150), 'error');
    setSwitch(id, !want);
  }
  el.disabled = false;
}

async function setHostname() {
  const v = $('in-hostname').value.trim();
  if (!/^[A-Za-z0-9.-]+$/.test(v)) { toast('letters, digits, dots and dashes only', 'error'); return; }
  const res = await run(`${SVC} set-pref hostname ${v}`, { quiet: true });
  toast(res.errno === 0 ? `hostname set to ${v}` : 'could not set the hostname', res.errno === 0 ? 'info' : 'error');
  await loadPrefs();
}

async function setAdvertiseRoutes() {
  const v = $('in-advertise').value.trim();
  if (v && !/^[0-9a-fA-F:.,/]+$/.test(v)) { toast('invalid CIDR list', 'error'); return; }
  const res = await run(`${SVC} set-pref advertise-routes ${v}`, { quiet: true });
  toast(res.errno === 0 ? 'advertised routes updated' : 'could not update', res.errno === 0 ? 'info' : 'error');
  await loadPrefs();
}

/* Discover the subnet routes the tailnet offers and install them.
   Exit code 2 means --accept-routes is off, so there was nothing to see: turn it
   on and retry automatically rather than making the user guess. */
async function discover() {
  setBusy(true);
  try {
    let res = await run(`${SVC} routes-sync`, { quiet: true });
    if (res.errno === 2) {
      toast('accept-routes was off - enabling it and retrying…');
      await run(`${SVC} set-pref accept-routes on`, { quiet: true });
      await new Promise((r) => setTimeout(r, 2000));
      res = await run(`${SVC} routes-sync`, { quiet: true });
    }
    await loadPrefs();
    await loadRoutes();
    await refreshStatus();
    if (res.errno === 0) {
      const n = discoveredList().length;
      toast(n ? `discovered ${n} subnet route(s)` : 'no subnet routes visible yet (approved in the admin console?)');
    } else {
      toast((res.stderr || 'discovery failed').trim().split('\n').pop().slice(0, 150), 'error');
    }
  } finally {
    setBusy(false);
  }
}

/* Two-tap arming instead of confirm(): some manager WebViews do not implement
   window.confirm and would silently return false. */
function armButton(el, label, handler) {
  let armed = false;
  let timer = null;
  el.onclick = async () => {
    if (!armed) {
      armed = true;
      el.dataset.label = el.textContent;
      el.textContent = label;
      el.classList.add('armed');
      timer = setTimeout(() => { armed = false; el.textContent = el.dataset.label; el.classList.remove('armed'); }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    el.textContent = el.dataset.label;
    el.classList.remove('armed');
    await handler();
  };
}

async function logout() {
  setBusy(true);
  try {
    await run(`${SVC} logout`);
    await refreshStatus();
    await loadPrefs();
    toast('logged out - tap Login to authorise again');
  } finally {
    setBusy(false);
  }
}

/* -------------------------------------------------------------------- tabs --- */
function showTab(name) {
  ['status', 'routes', 'features', 'log', 'diag'].forEach((t) => {
    $(`tab-${t}`).classList.toggle('active', t === name);
    $(`panel-${t}`).style.display = t === name ? '' : 'none';
  });
  if (name === 'log') loadLog();
  if (name === 'diag') loadDiag();
  if (name === 'routes') { loadRoutes(); renderDiscovered(); }
  if (name === 'features') loadPrefs();
}

/* -------------------------------------------------------------------- init --- */
function wire() {
  $('refresh').onclick = async () => { await refreshStatus({ silent: false }); };
  document.querySelectorAll('button[data-action]').forEach((b) => {
    b.onclick = () => action(b.dataset.action);
  });
  $('btn-login').onclick = login;
  armButton($('btn-logout'), 'tap again to log out', logout);

  $('btn-save').onclick = saveRoutes;
  $('btn-reset').onclick = resetRoutes;
  $('btn-discover').onclick = discover;

  $('btn-prefs-refresh').onclick = async () => { await loadPrefs(); toast('features refreshed'); };
  Object.keys(SWITCHES).forEach((id) => { $(id).onchange = () => togglePref(id); });
  $('btn-hostname').onclick = setHostname;
  $('btn-advertise').onclick = setAdvertiseRoutes;

  $('btn-log-refresh').onclick = loadLog;
  $('btn-diag-refresh').onclick = loadDiag;
  $('btn-clear').onclick = clearLogs;
  $('auto').onclick = toggleAutoLog;

  $('tab-status').onclick = () => showTab('status');
  $('tab-routes').onclick = () => showTab('routes');
  $('tab-features').onclick = () => showTab('features');
  $('tab-log').onclick = () => showTab('log');
  $('tab-diag').onclick = () => showTab('diag');
}

wire();
showTab('status');
refreshStatus({ silent: true });
loadPrefs();

let tick = 0;
setInterval(() => {
  if (state.busy || document.visibilityState !== 'visible') return;
  refreshStatus();
  tick += 1;
  if (tick % 4 === 0 && $('panel-features').style.display !== 'none') loadPrefs();
}, 5000);
