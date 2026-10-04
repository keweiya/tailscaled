import { exec, toast as nativeToast } from './ksu.js';

const STATE_DIR = '/data/adb/tailscale';
const DAEMON_LOG = `${STATE_DIR}/run/tailscaled.log`;
const DIAG_LOG = `${STATE_DIR}/run/diag.log`;
const SVC = 'tailscaled.service';

const $ = (id) => document.getElementById(id);
const state = { status: {}, busy: false, source: 'daemon', auto: false, timer: null };

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
  document.querySelectorAll('button').forEach((b) => { b.disabled = busy; });
}

function parseKv(text) {
  const out = {};
  text.split('\n').forEach((line) => {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return out;
}

function setText(id, value, cls = '') {
  const el = $(id);
  if (el.textContent !== value) el.textContent = value;
  if (el.className !== cls) el.className = cls;
}

/* ---------------------------------------------------------------- status ---- */
async function refreshStatus({ announce = false } = {}) {
  const res = await run(`${SVC} webstatus`, { quiet: true });
  const s = parseKv(res.stdout || '');
  state.status = s;

  const running = s.daemon === '1';
  const backend = s.backend || '';
  const mainBad = s.osrouter === '1' && s.main_default !== 'ok';

  $('dot').className = `dot ${
    !running ? 'bad' : mainBad ? 'warn' : (backend === 'Running' ? 'good' : 'warn')
  }`;
  setText('status-main', running ? (backend || 'running') : 'stopped');
  setText('status-sub', running
    ? `${s.ip4 || 'no address'}${s.user ? ` · ${s.user}` : ''}`
    : 'tailscaled is not running');

  setText('v-module', s.version || '-');
  const stale = running && s.daemon_current === '0';
  setText('v-daemon', running ? `running (${s.pid || '?'})${stale ? ' — STALE, restart' : ''}` : 'stopped', stale ? 'bad' : '');
  setText('v-build', s.osrouter === '1' ? 'linux + osrouter' : 'standalone (no osrouter)', s.osrouter === '1' ? '' : 'warn');
  setText('v-ip', s.ip4 || '-');
  setText('v-backend', backend || '-');
  setText('v-user', s.user || '-');

  const binOk = s.binary_ok === '1';
  setText('v-binary', binOk ? 'OK — matches the module build' : 'CHANGED — will be restored', binOk ? '' : 'bad');

  if (s.osrouter === '1') {
    const ok = s.main_default === 'ok';
    setText('v-main', ok ? 'OK — control plane can reach the internet' : 'MISSING — control plane will fail', ok ? '' : 'bad');
  } else {
    setText('v-main', 'n/a (standalone routing)');
  }

  const ex = s.exempt_prerouting === 'OK' && s.exempt_output === 'OK';
  setText('v-exempt', `${s.exempt_prerouting || '?'} / ${s.exempt_output || '?'} / ${s.exempt_nat || '?'} (in/out/nat)`,
    ex ? '' : 'warn');

  const problems = [];
  if (!running) problems.push('tailscaled is not running — press Start, then check the Log tab.');
  if (running && s.daemon_current === '0') problems.push('The running daemon was started before this module was installed, so the old binary is still executing — press Restart.');
  if (running && mainBad) problems.push('The main routing table has no default route, so the control plane cannot connect. Press Restart; if it persists, send me the Log.');
  if (running && backend && backend !== 'Running' && backend !== 'NeedsLogin') problems.push(`Backend state is "${backend}".`);
  if (running && backend === 'NeedsLogin') problems.push('Not logged in yet — press Login.');
  if (running && s.health) problems.push(s.health);
  const h = $('health');
  h.textContent = problems.join(' ');
  h.style.display = problems.length ? '' : 'none';

  if (announce) toast('status refreshed');
}

/* ---------------------------------------------------------------- actions --- */
async function action(name) {
  setBusy(true);
  try {
    await run(`${SVC} ${name}`);
    await new Promise((r) => setTimeout(r, 1500));
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
    const res = await run('tailscale up --timeout=8s', { quiet: true });
    const url = extractUrl(`${res.stdout}\n${res.stderr}`);
    if (url) {
      $('login-url').href = url;
      $('login-url').textContent = url;
      $('login-box').style.display = '';
      toast('login link ready — tap it');
    } else if (/already logged in|Logged in/i.test(res.stdout)) {
      toast('already logged in');
    } else {
      const tail = (res.stdout || res.stderr || '').trim().split('\n').slice(-2).join(' ');
      toast(tail.slice(0, 160) || 'no login link returned', 'error');
    }
    await refreshStatus();
  } finally {
    setBusy(false);
  }
}

/* --------------------------------------------------------------- settings --- */
const SWITCHES = {
  'sw-accept-routes': 'accept-routes',
  'sw-accept-dns': 'accept-dns',
  'sw-shields-up': 'shields-up',
  'sw-advertise-exit-node': 'advertise-exit-node',
};

function setSwitch(id, on) {
  $(id).checked = on;
  $(id).closest('.switch-row').classList.toggle('on', on);
}

async function loadPrefs() {
  const res = await run(`${SVC} prefs`, { quiet: true });
  if (!res.stdout || /prefs_ok=0/.test(res.stdout)) return;
  const p = parseKv(res.stdout);
  setSwitch('sw-accept-routes', p.accept_routes === '1');
  setSwitch('sw-accept-dns', p.accept_dns === '1');
  setSwitch('sw-shields-up', p.shields_up === '1');
  setSwitch('sw-advertise-exit-node', (p.advertise_routes || '').indexOf('0.0.0.0/0') >= 0);
  if (document.activeElement !== $('in-hostname')) $('in-hostname').value = p.hostname || '';
}

async function togglePref(id) {
  const key = SWITCHES[id];
  const want = $(id).checked;
  $(id).disabled = true;
  const res = await run(`${SVC} set-pref ${key} ${want ? 'on' : 'off'}`, { quiet: true });
  if (res.errno === 0) {
    toast(`${key} ${want ? 'on' : 'off'}`);
    await loadPrefs();
    await refreshStatus();
  } else {
    const msg = (res.stderr || res.stdout || '').trim().split('\n').pop();
    toast((msg || `${key} failed`).slice(0, 150), 'error');
    setSwitch(id, !want);
  }
  $(id).disabled = false;
}

async function setHostname() {
  const v = $('in-hostname').value.trim();
  if (!/^[A-Za-z0-9.-]+$/.test(v)) { toast('letters, digits, dots and dashes only', 'error'); return; }
  const res = await run(`${SVC} set-pref hostname ${v}`, { quiet: true });
  toast(res.errno === 0 ? `hostname set to ${v}` : 'could not set the hostname', res.errno === 0 ? 'info' : 'error');
  await loadPrefs();
}

/* Two-tap arming instead of window.confirm: some manager WebViews do not
   implement confirm() and would silently return false. */
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
    toast('logged out — press Login to authorise again');
  } finally {
    setBusy(false);
  }
}

/* -------------------------------------------------------------------- log --- */
async function loadOutput() {
  const res = state.source === 'daemon'
    ? await run(`tail -n 250 ${DAEMON_LOG} 2>/dev/null || echo "(no daemon log yet)"`, { quiet: true })
    : await run(`${SVC} diag`, { quiet: true });
  const el = $('out');
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  el.textContent = res.stdout || res.stderr || '(empty)';
  if (stick) el.scrollTop = el.scrollHeight;
}

function setSource(which) {
  state.source = which;
  $('btn-src-daemon').classList.toggle('on', which === 'daemon');
  $('btn-src-diag').classList.toggle('on', which === 'diag');
  $('src-label').textContent = which === 'daemon' ? 'Daemon log' : 'Diagnostics';
  loadOutput();
}

function toggleAuto() {
  state.auto = !state.auto;
  $('auto').textContent = state.auto ? 'auto: on' : 'auto: off';
  $('auto').classList.toggle('on', state.auto);
  clearInterval(state.timer);
  if (state.auto) state.timer = setInterval(loadOutput, 5000);
}

async function clearLogs() {
  await run(`: > ${DAEMON_LOG}; : > ${DIAG_LOG}`, { quiet: true });
  await loadOutput();
  toast('logs cleared');
}

/* -------------------------------------------------------------------- tabs --- */
function showTab(name) {
  ['status', 'settings', 'log'].forEach((t) => {
    $(`tab-${t}`).classList.toggle('active', t === name);
    $(`panel-${t}`).style.display = t === name ? '' : 'none';
  });
  if (name === 'log') loadOutput();
  if (name === 'settings') loadPrefs();
}

/* -------------------------------------------------------------------- init --- */
function wire() {
  $('refresh').onclick = () => refreshStatus({ announce: true });
  document.querySelectorAll('button[data-action]').forEach((b) => {
    b.onclick = () => action(b.dataset.action);
  });
  $('btn-login').onclick = login;
  armButton($('btn-logout'), 'tap again to log out', logout);

  $('btn-prefs-refresh').onclick = async () => { await loadPrefs(); toast('features refreshed'); };
  Object.keys(SWITCHES).forEach((id) => { $(id).onchange = () => togglePref(id); });
  $('btn-hostname').onclick = setHostname;

  $('btn-src-daemon').onclick = () => setSource('daemon');
  $('btn-src-diag').onclick = () => setSource('diag');
  $('btn-log-refresh').onclick = loadOutput;
  $('btn-clear').onclick = clearLogs;
  $('auto').onclick = toggleAuto;

  $('tab-status').onclick = () => showTab('status');
  $('tab-settings').onclick = () => showTab('settings');
  $('tab-log').onclick = () => showTab('log');
}

wire();
showTab('status');
refreshStatus();

// 15 s, not 5: each poll spawns a root shell and asks tailscaled for its status,
// which is not free on a phone.
setInterval(() => {
  if (state.busy || document.visibilityState !== 'visible') return;
  refreshStatus();
}, 15000);
