// =============================================================================
// Homehost Dashboard — frontend controller
// Zero-dependency ES6 module. No build step required.
// =============================================================================

// ---- Configuration -----------------------------------------------------
// Override this single constant when the API runs on a different origin
// during development (e.g. 'http://localhost:8000'). Leave as '' to call
// the same origin the dashboard itself is served from in production.
const API_BASE = '';

const ENDPOINTS = Object.freeze({
  status: `${API_BASE}/api/v1/status`,
  health: `${API_BASE}/api/v1/health`,
  config: `${API_BASE}/api/v1/config`,
});

const DEFAULT_POLL_INTERVAL_MS = 3000;
const FETCH_TIMEOUT_MS = 5000;

// Statuses considered "good" / "warn" / "bad" for coloring dots & badges.
const GOOD_STATES = new Set(['running', 'active']);
const WARN_STATES = new Set(['paused', 'inactive', 'restarting']);
const BAD_STATES = new Set(['exited', 'failed', 'dead', 'error']);

// =============================================================================
// DOM references (cached once at module init)
// =============================================================================

const dom = {
  cardGrid: document.getElementById('card-grid'),
  emptyState: document.getElementById('empty-state'),
  errorBanner: document.getElementById('error-banner'),
  errorMessage: document.getElementById('error-message'),
  filterText: document.getElementById('filter-text'),
  filterChips: document.getElementById('filter-chips'),
  healthCpu: document.getElementById('health-cpu'),
  healthCpuBar: document.getElementById('health-cpu-bar'),
  healthRam: document.getElementById('health-ram'),
  healthRamBar: document.getElementById('health-ram-bar'),
  healthDisk: document.getElementById('health-disk'),
  healthDiskBar: document.getElementById('health-disk-bar'),
  healthUptime: document.getElementById('health-uptime'),
};

// =============================================================================
// Module-scoped state (not attached to window — no leaking globals)
// =============================================================================

let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
let pollTimerId = null;
let isPolling = false;
let activePollController = null;

let filterText = '';
let filterStatus = 'all';

// key -> { root, refs, cache } for diff-rendering. Keys are namespaced,
// e.g. "container:<id>" or "service:<name>", so containers and services
// never collide.
const cardRegistry = new Map();

// =============================================================================
// Formatting helpers (small, pure)
// =============================================================================

const clampPercent = (value) => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

const formatPercent = (value) => `${clampPercent(value).toFixed(1)}%`;

const formatMB = (mb) => {
  const value = Number(mb) || 0;
  return value >= 1024 ? `${(value / 1024).toFixed(2)} GB` : `${value.toFixed(0)} MB`;
};

const formatGB = (gb) => `${(Number(gb) || 0).toFixed(1)} GB`;

const formatUptime = (totalSeconds) => {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
};

const levelForPercent = (pct) => {
  if (pct >= 90) return 'bad';
  if (pct >= 70) return 'warn';
  return 'good';
};

const formatPorts = (ports) => {
  if (!Array.isArray(ports) || ports.length === 0) return [];
  return ports.map((p) => {
    const proto = p.protocol ? `/${p.protocol}` : '';
    if (p.host == null) return `${p.container}${proto}`;
    return `${p.host}:${p.container}${proto}`;
  });
};

const statusLevel = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (GOOD_STATES.has(normalized)) return 'good';
  if (WARN_STATES.has(normalized)) return 'warn';
  if (BAD_STATES.has(normalized)) return 'bad';
  return 'neutral';
};

// =============================================================================
// API response adapters — the backend reports bytes and Docker-native port
// keys (e.g. "80/tcp") for precision/flexibility; this layer converts those
// into the MB/GB + {host, container, protocol} shape the render code uses.
// =============================================================================

const bytesToMB = (bytes) => (Number(bytes) || 0) / 1e6;
const bytesToGB = (bytes) => (Number(bytes) || 0) / 1e9;

function normalizePorts(ports) {
  if (!Array.isArray(ports)) return [];
  return ports.map((p) => {
    const [containerPort, protocol] = String(p.container_port || '').split('/');
    return { host: p.host_port ?? null, container: containerPort, protocol };
  });
}

function normalizeStatusData(statusData) {
  const containers = Array.isArray(statusData.containers) ? statusData.containers : [];
  return {
    ...statusData,
    containers: containers.map((c) => ({
      ...c,
      mem_usage_mb: bytesToMB(c.memory_usage_bytes),
      mem_limit_mb: bytesToMB(c.memory_limit_bytes),
      ports: normalizePorts(c.ports),
    })),
  };
}

function normalizeHealthData(health) {
  if (!health || health.health_error) return health;
  const memory = health.memory || {};
  const disk = health.disk || {};
  return {
    ...health,
    ram: {
      used_gb: bytesToGB(memory.used_bytes),
      total_gb: bytesToGB(memory.total_bytes),
      percent: memory.percent,
    },
    disk: {
      used_gb: bytesToGB(disk.used_bytes),
      total_gb: bytesToGB(disk.total_bytes),
      percent: disk.percent,
    },
  };
}

// =============================================================================
// Fetch helpers — timeout + cooperative abort, no overlapping requests
// =============================================================================

/**
 * Fetches JSON from `url`, aborting after FETCH_TIMEOUT_MS or whenever
 * `parentSignal` aborts (e.g. because a newer poll cycle superseded this
 * one). Guarantees no dangling timers/listeners on any exit path.
 */
async function fetchJSON(url, parentSignal) {
  const localController = new AbortController();
  const timeoutId = setTimeout(() => localController.abort(), FETCH_TIMEOUT_MS);
  const onParentAbort = () => localController.abort();
  parentSignal.addEventListener('abort', onParentAbort);

  try {
    const response = await fetch(url, { signal: localController.signal });
    if (!response.ok) {
      throw new Error(`${url} responded with HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
    parentSignal.removeEventListener('abort', onParentAbort);
  }
}

// =============================================================================
// Error banner
// =============================================================================

const showError = (message) => {
  dom.errorMessage.textContent = message;
  dom.errorBanner.hidden = false;
};

const hideError = () => {
  dom.errorBanner.hidden = true;
};

const humanizeFetchError = (err) => {
  if (err && err.name === 'AbortError') {
    return 'Homehost API timed out. Retrying on next poll...';
  }
  return 'Cannot reach the Homehost API. Retrying on next poll...';
};

// =============================================================================
// Health strip rendering
// =============================================================================

const setBar = (barEl, pct) => {
  const clamped = clampPercent(pct);
  barEl.style.width = `${clamped}%`;
  barEl.dataset.level = levelForPercent(clamped);
};

function renderHealth(health) {
  if (!health || health.health_error) return;

  dom.healthCpu.textContent = formatPercent(health.cpu_percent);
  setBar(dom.healthCpuBar, health.cpu_percent);

  const ram = health.ram || {};
  dom.healthRam.textContent = `${formatGB(ram.used_gb)} / ${formatGB(ram.total_gb)}`;
  setBar(dom.healthRamBar, ram.percent);

  const disk = health.disk || {};
  dom.healthDisk.textContent = `${formatGB(disk.used_gb)} / ${formatGB(disk.total_gb)}`;
  setBar(dom.healthDiskBar, disk.percent);

  dom.healthUptime.textContent = formatUptime(health.uptime_seconds);
}

// =============================================================================
// Card construction & diff-rendering
// =============================================================================

let toggleIdCounter = 0;
const nextToggleId = () => `card-toggle-${(toggleIdCounter += 1)}`;

/** Builds the static DOM skeleton for a card and returns handles to the
 * pieces that will need updating on subsequent polls. */
function buildCardSkeleton(kind, name) {
  const root = document.createElement('article');
  root.className = 'card';
  root.dataset.kind = kind;
  root.dataset.name = name;

  const toggleId = nextToggleId();

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'card-expand-toggle';
  toggle.id = toggleId;

  const header = document.createElement('label');
  header.className = 'card-header';
  header.setAttribute('for', toggleId);

  const typeIcon = document.createElement('span');
  typeIcon.className = 'card-type-icon';
  typeIcon.setAttribute('aria-hidden', 'true');
  typeIcon.textContent = kind === 'container' ? '▢' : '⚙';

  const dot = document.createElement('span');
  dot.className = 'status-dot';

  const nameEl = document.createElement('span');
  nameEl.className = 'card-name';
  nameEl.textContent = name;

  const oneline = document.createElement('span');
  oneline.className = 'card-oneline';

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '›';

  header.append(typeIcon, dot, nameEl, oneline, chevron);

  const detail = document.createElement('div');
  detail.className = 'card-detail';
  const detailInner = document.createElement('div');
  detailInner.className = 'card-detail-inner';
  const detailContent = document.createElement('div');
  detailContent.className = 'card-detail-content';
  detailInner.appendChild(detailContent);
  detail.appendChild(detailInner);

  root.append(toggle, header, detail);

  return {
    root,
    refs: { dot, nameEl, oneline, detailContent },
  };
}

const makeDetailRow = (key, value) => {
  const row = document.createElement('div');
  row.className = 'detail-row';
  const keyEl = document.createElement('span');
  keyEl.className = 'detail-key';
  keyEl.textContent = key;
  const valueEl = document.createElement('span');
  valueEl.className = 'detail-value';
  valueEl.textContent = value;
  row.append(keyEl, valueEl);
  return row;
};

const makeGaugeRow = (label, pct) => {
  const wrap = document.createElement('div');
  wrap.className = 'detail-gauge-row';
  const row = document.createElement('div');
  row.className = 'detail-row';
  const keyEl = document.createElement('span');
  keyEl.className = 'detail-key';
  keyEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'detail-value';
  valueEl.textContent = formatPercent(pct);
  row.append(keyEl, valueEl);

  const track = document.createElement('div');
  track.className = 'detail-gauge-track';
  const fill = document.createElement('div');
  fill.className = 'detail-gauge-fill';
  fill.style.width = `${clampPercent(pct)}%`;
  fill.dataset.level = levelForPercent(clampPercent(pct));
  track.appendChild(fill);

  wrap.append(row, track);
  return wrap;
};

/** Renders (or re-renders) the full detail panel content for a container. */
function renderContainerDetail(container, refs) {
  refs.detailContent.replaceChildren();

  const badge = document.createElement('span');
  badge.className = 'status-badge';
  badge.textContent = container.status || 'unknown';
  refs.detailContent.appendChild(makeDetailRow('image', container.image || 'unknown'));
  refs.detailContent.appendChild(makeDetailRow('id', container.id || '-'));

  const statusRow = document.createElement('div');
  statusRow.className = 'detail-row';
  const statusKey = document.createElement('span');
  statusKey.className = 'detail-key';
  statusKey.textContent = 'status';
  statusRow.append(statusKey, badge);
  refs.detailContent.appendChild(statusRow);

  refs.detailContent.appendChild(makeGaugeRow('cpu', container.cpu_percent));

  const memPct =
    container.mem_limit_mb > 0 ? (container.mem_usage_mb / container.mem_limit_mb) * 100 : 0;
  refs.detailContent.appendChild(makeGaugeRow('memory', memPct));
  refs.detailContent.appendChild(
    makeDetailRow('mem usage', `${formatMB(container.mem_usage_mb)} / ${formatMB(container.mem_limit_mb)}`)
  );

  const portsLabels = formatPorts(container.ports);
  const portsRow = document.createElement('div');
  portsRow.className = 'detail-row';
  const portsKey = document.createElement('span');
  portsKey.className = 'detail-key';
  portsKey.textContent = 'ports';
  const portsValue = document.createElement('span');
  portsValue.className = 'detail-value';
  if (portsLabels.length === 0) {
    portsValue.textContent = '—';
  } else {
    const list = document.createElement('span');
    list.className = 'detail-ports-list';
    portsLabels.forEach((label) => {
      const tag = document.createElement('span');
      tag.className = 'port-tag';
      tag.textContent = label;
      list.appendChild(tag);
    });
    portsValue.replaceChildren(list);
  }
  portsRow.append(portsKey, portsValue);
  refs.detailContent.appendChild(portsRow);
}

/** Renders (or re-renders) the full detail panel content for a systemd service. */
function renderServiceDetail(service, refs) {
  refs.detailContent.replaceChildren();

  const badge = document.createElement('span');
  badge.className = 'status-badge';
  badge.textContent = service.active_state || 'unknown';

  const statusRow = document.createElement('div');
  statusRow.className = 'detail-row';
  const statusKey = document.createElement('span');
  statusKey.className = 'detail-key';
  statusKey.textContent = 'active_state';
  statusRow.append(statusKey, badge);
  refs.detailContent.appendChild(statusRow);
  refs.detailContent.appendChild(makeDetailRow('type', 'systemd service'));
}

const containerOneline = (c) => `${c.status || 'unknown'} · cpu ${formatPercent(c.cpu_percent)}`;
const serviceOneline = (s) => s.active_state || 'unknown';

/**
 * Diff-renders one logical group (containers or services) into the shared
 * card grid. Cards are keyed so unchanged cards are left untouched, changed
 * fields are patched in place, and only genuinely new/removed items cause
 * DOM node creation/removal — this avoids full-grid rebuild flicker and
 * layout shift on every poll tick.
 */
function diffRenderGroup(kind, items, keyOf, onelineOf, renderDetail, seenKeys) {
  items.forEach((item) => {
    const key = keyOf(item);
    seenKeys.add(key);

    const status = kind === 'container' ? item.status : item.active_state;
    const normalizedStatus = String(status || 'unknown').toLowerCase();
    const oneline = onelineOf(item);

    let entry = cardRegistry.get(key);

    if (!entry) {
      const { root, refs } = buildCardSkeleton(kind, item.name);
      entry = { root, refs, cache: {} };
      cardRegistry.set(key, entry);
      dom.cardGrid.appendChild(root);
    }

    const { root, refs, cache } = entry;

    if (cache.status !== normalizedStatus) {
      root.dataset.status = normalizedStatus;
      cache.status = normalizedStatus;
    }

    if (cache.oneline !== oneline) {
      refs.oneline.textContent = oneline;
      cache.oneline = oneline;
    }

    // Detail panel content changes frequently (cpu/mem/ports); only touch
    // the DOM when the serialized snapshot actually differs.
    const snapshot = JSON.stringify(item);
    if (cache.snapshot !== snapshot) {
      renderDetail(item, refs);
      cache.snapshot = snapshot;
    }
  });
}

/** Removes cards for containers/services that disappeared from the API
 * response since the last poll. */
function pruneStaleCards(seenKeys) {
  for (const [key, entry] of cardRegistry) {
    if (!seenKeys.has(key)) {
      entry.root.remove();
      cardRegistry.delete(key);
    }
  }
}

function renderCards(statusData) {
  const seenKeys = new Set();

  const containers = Array.isArray(statusData.containers) ? statusData.containers : [];
  const services = Array.isArray(statusData.services) ? statusData.services : [];

  diffRenderGroup(
    'container',
    containers,
    (c) => `container:${c.id || c.name}`,
    containerOneline,
    renderContainerDetail,
    seenKeys
  );

  diffRenderGroup(
    'service',
    services,
    (s) => `service:${s.name}`,
    serviceOneline,
    renderServiceDetail,
    seenKeys
  );

  pruneStaleCards(seenKeys);
}

// =============================================================================
// Client-side filtering (name text + status chip), fully instant/offline
// =============================================================================

function applyFilters() {
  const needle = filterText.trim().toLowerCase();
  let visibleCount = 0;

  for (const entry of cardRegistry.values()) {
    const { root } = entry;
    const name = (root.dataset.name || '').toLowerCase();
    const status = root.dataset.status || 'unknown';

    const matchesText = needle === '' || name.includes(needle);
    const matchesStatus = filterStatus === 'all' || status === filterStatus;
    const visible = matchesText && matchesStatus;

    root.hidden = !visible;
    if (visible) visibleCount += 1;
  }

  dom.emptyState.hidden = visibleCount !== 0;
}

function setFilterStatus(status) {
  filterStatus = status;
  dom.filterChips.querySelectorAll('.chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.filter === status));
  });
  applyFilters();
}

// =============================================================================
// Polling loop — async/await + AbortController, no overlapping requests
// =============================================================================

/**
 * A single poll tick fetches status + health together. `isPolling` guards
 * against a slow request still being in flight when the next interval
 * fires; `activePollController` lets us proactively abort a stale request
 * if one is ever left dangling, so we never race two polls or leak
 * listeners/timers.
 */
async function pollTick() {
  if (isPolling) return;
  isPolling = true;

  if (activePollController) {
    activePollController.abort();
  }
  const controller = new AbortController();
  activePollController = controller;

  try {
    const [rawStatusData, rawHealthData] = await Promise.all([
      fetchJSON(ENDPOINTS.status, controller.signal),
      fetchJSON(ENDPOINTS.health, controller.signal),
    ]);
    const statusData = normalizeStatusData(rawStatusData);
    const healthData = normalizeHealthData(rawHealthData);

    renderCards(statusData);
    renderHealth(healthData);
    applyFilters();

    if (statusData.docker_error) {
      showError(`Docker: ${statusData.docker_error}`);
    } else {
      hideError();
    }
  } catch (err) {
    // Last-known-good cards/health stay on screen; only the banner changes.
    showError(humanizeFetchError(err));
  } finally {
    isPolling = false;
  }
}

function startPolling() {
  pollTick();
  if (pollTimerId !== null) {
    clearInterval(pollTimerId);
  }
  pollTimerId = setInterval(pollTick, pollIntervalMs);
}

// =============================================================================
// Bootstrap
// =============================================================================

async function loadConfig() {
  try {
    const controller = new AbortController();
    const config = await fetchJSON(ENDPOINTS.config, controller.signal);
    if (config && Number.isFinite(config.poll_interval_seconds) && config.poll_interval_seconds > 0) {
      pollIntervalMs = config.poll_interval_seconds * 1000;
    }
  } catch (err) {
    // Config is a nice-to-have; fall back to the default interval silently
    // and surface connectivity problems once real polling begins instead.
  }
}

function bindEvents() {
  dom.filterText.addEventListener('input', (event) => {
    filterText = event.target.value;
    applyFilters();
  });

  dom.filterChips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    setFilterStatus(chip.dataset.filter);
  });
}

async function init() {
  bindEvents();
  await loadConfig();
  startPolling();
}

init();
