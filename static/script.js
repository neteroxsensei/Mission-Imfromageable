const DEFAULTS_BY_SHAPE = {
  cylinder: { radius: 4, length: 14 },
  sphere: { radius: 6 },
  cube: { width: 10, depth: 10, height: 10 },
};

const SHAPE_FIELDS = {
  cylinder: [
    { key: 'radius', label: 'Radius', step: 0.1 },
    { key: 'length', label: 'Length', step: 0.1 },
  ],
  sphere: [
    { key: 'radius', label: 'Radius', step: 0.1 },
  ],
  cube: [
    { key: 'width', label: 'Width', step: 0.1 },
    { key: 'depth', label: 'Depth', step: 0.1 },
    { key: 'height', label: 'Height', step: 0.1 },
  ],
};

const COLOR_HEX = {
  green: '#34d399',
  orange: '#fbbf24',
  teal: '#2dd4bf',
  purple: '#a855f7',
  grey: '#9ca3af',
  gray: '#9ca3af',
  blue: '#60a5fa',
  red: '#f87171',
  yellow: '#facc15',
};

const globalScope = typeof window !== 'undefined' ? window : globalThis;

const STATIC_MODULE_LIBRARY = [];

let assetLabels = globalScope.ASSET_LABELS || {};
globalScope.ASSET_LABELS = assetLabels;
globalScope.assetLabels = assetLabels;

let moduleLibrary = [...STATIC_MODULE_LIBRARY];
globalScope.moduleLibrary = moduleLibrary;
const moduleLibraryMap = new Map();
let moduleLibraryQuery = '';

function refreshLibraryCache() {
  assetLabels = {};
  globalScope.ASSET_LABELS = assetLabels;
  globalScope.assetLabels = assetLabels;
  moduleLibraryMap.clear();
  moduleLibrary.forEach((entry) => {
    if (!entry.asset) {
      return;
    }
    assetLabels[entry.asset] = entry.label;
    moduleLibraryMap.set(entry.asset, entry);
  });
}

refreshLibraryCache();

function mergeLibraryEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return [];
  }
  const newlyAdded = [];
  entries.forEach((entry) => {
    if (!entry || !entry.asset) {
      return;
    }
    const assetKey = String(entry.asset);
    if (moduleLibraryMap.has(assetKey)) {
      return;
    }
    moduleLibrary.push(entry);
    newlyAdded.push(entry);
  });
  if (newlyAdded.length) {
    moduleLibrary.sort((a, b) => {
      const typeA = String(a.type || '').toLowerCase();
      const typeB = String(b.type || '').toLowerCase();
      if (typeA !== typeB) {
        return typeA.localeCompare(typeB);
      }
      return String(a.label || '').toLowerCase().localeCompare(String(b.label || '').toLowerCase());
    });
    refreshLibraryCache();
    renderLibrary();
    populateAssetPreset();
  }
  return newlyAdded;
}

if (globalScope && typeof globalScope === 'object') {
  globalScope.mergeLibraryEntries = mergeLibraryEntries;
}

const DEFAULT_HABITAT = { type: 'cylinder', ...DEFAULTS_BY_SHAPE.cylinder };

const habitatCache = {
  cylinder: { ...DEFAULTS_BY_SHAPE.cylinder },
  sphere: { ...DEFAULTS_BY_SHAPE.sphere },
  cube: { ...DEFAULTS_BY_SHAPE.cube },
};

let habitat = { ...DEFAULT_HABITAT };
let modules = [];
let editingModuleId = null;
let activateTabById = () => {};
const metricsCharts = {
  volume: null,
  usage: null,
  footprint: null,
};
let currentMetrics = null;
let currentRequirements = null;
let renderStyle = 'realistic';
let crewSize = 4;
let missionPromptText = '';
let saveLayoutTimer = null;
let requirementCatalogMap = null;
let requirementCatalogPromise = null;
let requirementTypeIndex = null;
let stageCriticalTimer = null;
let stageCriticalPromise = null;

const statusContainer = document.getElementById('appStatus');
const statusTimerMap = new WeakMap();
let autoAnalysisTimer = null;
let autoAnalysisPromise = null;
let isOptimizing = false;

const OVERFLOW_REASON_TEXT = {
  'height-exceeds': 'Too tall for habitat clearance',
  'footprint-exceeds': 'Exceeds habitat footprint width/depth',
  'length-exceeds': 'Exceeds habitat length',
  'cross-section-exceeds': 'Cross-section exceeds hull radius',
  'volume-exceeds': 'Exceeds spherical volume',
  'space-exhausted': 'No remaining floor area',
  'invalid-dimensions': 'Module dimensions are invalid',
  'invalid-habitat': 'Habitat dimensions are invalid',
};

const moduleRemovalOverlay = document.getElementById('moduleRemovalOverlay');
const moduleRemovalDialog = moduleRemovalOverlay ? moduleRemovalOverlay.querySelector('.modal__dialog') : null;
const moduleRemovalList = document.getElementById('moduleRemovalList');
const moduleRemovalMessage = document.getElementById('moduleRemovalMessage');
const moduleRemovalConfirm = document.getElementById('moduleRemovalConfirm');
const moduleRemovalCancel = document.getElementById('moduleRemovalCancel');
const moduleRemovalBackdrop = moduleRemovalOverlay ? moduleRemovalOverlay.querySelector('.modal__backdrop') : null;
const moduleRemovalFocusSelectors = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const moduleRemovalRemoveAll = document.getElementById('moduleRemovalRemoveAll');
const MODULE_REMOVAL_ALL = '__REMOVE_ALL__';
let moduleRemovalResolver = null;
let moduleRemovalFocusedBeforeOpen = null;
let moduleRemovalSelectedId = null;
let moduleRemovalKeyHandler = null;

const crewInput = document.getElementById('crewSize');
const missionPromptInput = document.getElementById('missionPrompt');
const enforceRequirementsBtn = document.getElementById('enforceRequirementsBtn');

function pushStatus(message, { tone = 'info', timeout = 5000 } = {}) {
  if (!statusContainer || !message) {
    return;
  }

  const toneClassMap = {
    success: 'app-status__message--success',
    warning: 'app-status__message--warning',
    danger: 'app-status__message--danger',
  };

  const note = document.createElement('div');
  note.className = 'app-status__message';
  if (toneClassMap[tone]) {
    note.classList.add(toneClassMap[tone]);
  }
  note.textContent = message;

  statusContainer.appendChild(note);

  while (statusContainer.children.length > 3) {
    const first = statusContainer.firstElementChild;
    if (!first) {
      break;
    }
    if (statusTimerMap.has(first)) {
      clearTimeout(statusTimerMap.get(first));
      statusTimerMap.delete(first);
    }
    statusContainer.removeChild(first);
  }

  if (timeout > 0) {
    const timer = setTimeout(() => {
      if (note.parentNode === statusContainer) {
        statusContainer.removeChild(note);
      }
      statusTimerMap.delete(note);
    }, timeout);
    statusTimerMap.set(note, timer);
  }
}

function numberOr(value, fallback) {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
}

function formatNumber(value, decimals = 2) {
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) {
    return '—';
  }
  const fixed = num.toFixed(decimals);
  return fixed.replace(/\.0+$/, '').replace(/(\.[1-9]*)0+$/, '$1');
}

function clamp(value, min, max) {
  const v = Number.isFinite(value) ? value : 0;
  const lower = Number.isFinite(min) ? min : v;
  const upper = Number.isFinite(max) ? max : v;
  if (lower > upper) {
    return (lower + upper) / 2;
  }
  return Math.min(Math.max(v, lower), upper);
}

function vectorClampToCircle(x, z, hx, hz, radius) {
  const safeRadius = Math.max(0, radius);
  if (safeRadius <= 0) {
    return { x: 0, z: 0 };
  }

  const cornerRadius = (cx, cz) => Math.hypot(Math.abs(cx) + hx, Math.abs(cz) + hz);

  if (cornerRadius(x, z) <= safeRadius + 1e-6) {
    return { x, z };
  }

  if (cornerRadius(0, 0) > safeRadius + 1e-6) {
    return { x: 0, z: 0 };
  }

  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    const cx = x * mid;
    const cz = z * mid;
    if (cornerRadius(cx, cz) <= safeRadius + 1e-6) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return { x: x * low, z: z * low };
}

function vectorClampToSphere(x, y, z, hx, hy, hz, radius) {
  const safeRadius = Math.max(0, radius);
  if (safeRadius <= 0) {
    return { x: 0, y: 0, z: 0 };
  }

  const cornerRadius = (cx, cy, cz) => {
    const rx = Math.abs(cx) + hx;
    const ry = Math.abs(cy) + hy;
    const rz = Math.abs(cz) + hz;
    return Math.sqrt((rx * rx) + (ry * ry) + (rz * rz));
  };

  if (cornerRadius(x, y, z) <= safeRadius + 1e-6) {
    return { x, y, z };
  }

  if (cornerRadius(0, 0, 0) > safeRadius + 1e-6) {
    return { x: 0, y: 0, z: 0 };
  }

  let low = 0;
  let high = 1;
  for (let i = 0; i < 50; i += 1) {
    const mid = (low + high) / 2;
    const cx = x * mid;
    const cy = y * mid;
    const cz = z * mid;
    if (cornerRadius(cx, cy, cz) <= safeRadius + 1e-6) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const factor = low;
  return { x: x * factor, y: y * factor, z: z * factor };
}

function clampModuleToHabitat(mod, currentHabitat = habitat) {
  const type = String(currentHabitat.type || DEFAULT_HABITAT.type).toLowerCase();
  const result = { ...mod };

  const width = Math.abs(numberOr(result.w, 1));
  const depth = Math.abs(numberOr(result.d, 1));
  const height = Math.abs(numberOr(result.h, 1));

  result.w = width;
  result.d = depth;
  result.h = height;

  if (type === 'sphere') {
    const radius = Math.max(0, numberOr(currentHabitat.radius, DEFAULTS_BY_SHAPE.sphere.radius));
    if (radius <= 0) {
      return { ...result, x: 0, y: 0, z: 0, w: 0, d: 0, h: 0 };
    }
    let hx = width / 2;
    let hy = depth / 2;
    let hz = height / 2;
    const moduleRadius = Math.sqrt((hx * hx) + (hy * hy) + (hz * hz));
    if (moduleRadius > radius && moduleRadius > 0) {
      const shrink = radius / moduleRadius;
      result.w *= shrink;
      result.d *= shrink;
      result.h *= shrink;
      hx *= shrink;
      hy *= shrink;
      hz *= shrink;
    }
    const clamped = vectorClampToSphere(result.x, result.y, result.z, hx, hy, hz, radius);
    result.x = clamped.x;
    result.y = clamped.y;
    result.z = clamped.z;
    return result;
  }

  if (type === 'cube') {
    const widthTotal = Math.max(0, numberOr(currentHabitat.width, DEFAULTS_BY_SHAPE.cube.width));
    const depthTotal = Math.max(0, numberOr(currentHabitat.depth, DEFAULTS_BY_SHAPE.cube.depth));
    const heightTotal = Math.max(0, numberOr(currentHabitat.height, DEFAULTS_BY_SHAPE.cube.height));

    result.w = Math.min(result.w, widthTotal);
    result.d = Math.min(result.d, depthTotal);
    result.h = Math.min(result.h, heightTotal);

    const hx = result.w / 2;
    const hy = result.d / 2;
    const hz = result.h / 2;

    const maxX = Math.max(0, (widthTotal / 2) - hx);
    const maxY = Math.max(0, (depthTotal / 2) - hy);
    const maxZ = Math.max(0, (heightTotal / 2) - hz);

    result.x = clamp(result.x, -maxX, maxX);
    result.y = clamp(result.y, -maxY, maxY);
    result.z = clamp(result.z, -maxZ, maxZ);
    return result;
  }

  const radius = Math.max(0, numberOr(currentHabitat.radius, DEFAULTS_BY_SHAPE.cylinder.radius));
  const length = Math.max(0, numberOr(currentHabitat.length, DEFAULTS_BY_SHAPE.cylinder.length));
  const halfLength = length / 2;

  result.d = length > 0 ? Math.min(result.d, length) : 0;
  const hy = result.d / 2;
  if (halfLength > 0) {
    const maxY = Math.max(0, halfLength - hy);
    result.y = clamp(result.y, -maxY, maxY);
  } else {
    result.y = 0;
  }

  if (radius <= 0) {
    return { ...result, x: 0, z: 0, w: 0, h: 0 };
  }

  let hx = result.w / 2;
  let hz = result.h / 2;
  const moduleRadius = Math.hypot(hx, hz);
  if (moduleRadius > radius && moduleRadius > 0) {
    const shrink = radius / moduleRadius;
    result.w *= shrink;
    result.h *= shrink;
    hx *= shrink;
    hz *= shrink;
  }

  const clamped = vectorClampToCircle(result.x, result.z, hx, hz, radius);
  result.x = clamped.x;
  result.z = clamped.z;
  return result;
}

function ensureHabitatDefaults(raw = {}) {
  const type = String(raw.type || DEFAULT_HABITAT.type).toLowerCase();
  const defaults = DEFAULTS_BY_SHAPE[type] || DEFAULTS_BY_SHAPE.cylinder;
  const sanitized = { type };
  Object.keys(defaults).forEach((key) => {
    sanitized[key] = numberOr(raw[key], defaults[key]);
  });
  return sanitized;
}

function cacheHabitatDimensions(current) {
  const { type, ...dims } = current;
  habitatCache[type] = { ...dims };
}

function normalizeModule(mod = {}) {
  const fallback = {
    w: numberOr(mod.w ?? mod.size, 1),
    h: numberOr(mod.h ?? mod.size, 1),
    d: numberOr(mod.d ?? mod.size, 1),
  };

  const base = {
    id: String(mod.id || '').trim() || `module-${Date.now()}`,
    type: mod.type || 'generic',
    shape: mod.shape || 'box',
    x: numberOr(mod.x, 0),
    y: numberOr(mod.y, 0),
    z: numberOr(mod.z, 0),
    w: fallback.w,
    h: fallback.h,
    d: fallback.d,
    color: mod.color || 'grey',
  };

  const allowedKeys = new Set(Object.keys(base));
  const extras = {};
  Object.keys(mod || {}).forEach((key) => {
    if (!allowedKeys.has(key)) {
      extras[key] = mod[key];
    }
  });

  return { ...base, ...extras };
}

function habitatFieldId(key) {
  return `habitat${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function colorToHex(name) {
  if (!name) {
    return '#94a3b8';
  }
  const key = String(name).toLowerCase();
  return COLOR_HEX[key] || name;
}

function assetLabel(assetKey) {
  if (!assetKey) {
    return '';
  }
  const key = String(assetKey);
  return assetLabels[key] || key;
}

function getHabitatFootprint() {
  const type = (habitat.type || DEFAULT_HABITAT.type).toLowerCase();
  if (type === 'sphere') {
    const radius = numberOr(habitat.radius, DEFAULTS_BY_SHAPE.sphere.radius);
    const diameter = radius * 2;
    return {
      type,
      width: diameter,
      depth: diameter,
      height: diameter,
      radius,
    };
  }
  if (type === 'cube') {
    const width = numberOr(habitat.width, DEFAULTS_BY_SHAPE.cube.width);
    const depth = numberOr(habitat.depth, DEFAULTS_BY_SHAPE.cube.depth);
    const height = numberOr(habitat.height, DEFAULTS_BY_SHAPE.cube.height);
    return {
      type,
      width,
      depth,
      height,
    };
  }
  const radius = numberOr(habitat.radius, DEFAULTS_BY_SHAPE.cylinder.radius);
  const length = numberOr(habitat.length, DEFAULTS_BY_SHAPE.cylinder.length);
  const diameter = radius * 2;
  return {
    type,
    width: diameter,
    depth: length,
    height: diameter,
    radius,
    length,
  };
}

function chooseGridStep(range) {
  if (!Number.isFinite(range) || range <= 0) {
    return 1;
  }
  const approx = range / 8;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(approx, 1e-6)));
  const normalized = approx / magnitude;
  let factor = 1;
  if (normalized <= 1) {
    factor = 1;
  } else if (normalized <= 2) {
    factor = 2;
  } else if (normalized <= 5) {
    factor = 5;
  } else {
    factor = 10;
  }
  return factor * magnitude;
}

async function loadLayout() {
  try {
    const res = await fetch('/layout');
    if (!res.ok) {
      throw new Error(`Layout request failed (${res.status})`);
    }
    const data = await res.json();
    const nextHabitat = ensureHabitatDefaults(data.habitat);
    const pendingModules = Array.isArray(data.modules)
      ? data.modules.map(normalizeModule)
      : [];
    habitat = nextHabitat;
    cacheHabitatDimensions(habitat);
    modules = pendingModules.map((mod) => clampModuleToHabitat(mod, habitat));
    if (typeof data.render_style === 'string') {
      renderStyle = data.render_style.toLowerCase();
    } else if (!renderStyle) {
      renderStyle = 'realistic';
    }
    crewSize = Number.parseInt(data.crew ?? crewSize, 10) || crewSize;
    missionPromptText = String(data.mission_prompt ?? missionPromptText);
    currentRequirements = null;
  } catch (err) {
    console.error('Failed to load layout', err);
    pushStatus('Failed to load saved layout. Starting with defaults.', { tone: 'warning', timeout: 6000 });
    habitat = { ...DEFAULT_HABITAT };
    modules = [];
    renderStyle = 'realistic';
    crewSize = 4;
    missionPromptText = '';
    currentRequirements = null;
  }

  renderHabitatForm();
  renderTable();
  renderMap();
  renderLibrary();
  updateRenderStyleControl();
  updateCrewControls();
  updateMetricsView(currentMetrics, currentRequirements);
  scheduleAutoAnalysis('initial-load');
}

function renderHabitatForm() {
  const shapeSelect = document.getElementById('habitatShape');
  if (!shapeSelect) {
    return;
  }
  shapeSelect.value = habitat.type;
  updateShapeFields(habitat.type);
}

function updateShapeFields(type) {
  const container = document.getElementById('shapeFields');
  if (!container) {
    return;
  }

  const fields = SHAPE_FIELDS[type] || SHAPE_FIELDS.cylinder;
  const defaults = DEFAULTS_BY_SHAPE[type] || DEFAULTS_BY_SHAPE.cylinder;

  container.innerHTML = fields.map(({ key, label, step }) => {
    const value = numberOr(habitat[key], defaults[key]);
    return `
      <label>${label}
        <input type="number" min="0" step="${step}" id="${habitatFieldId(key)}" value="${value}">
      </label>
    `;
  }).join('\n');
}

async function saveLayout() {
  try {
    const res = await fetch('/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        habitat,
        modules,
        render_style: renderStyle,
        crew: crewSize,
        mission_prompt: missionPromptText,
      }),
    });
    if (!res.ok) {
      throw new Error(`Save failed (${res.status})`);
    }
    queueCriticalModuleStaging();
  } catch (err) {
    console.error('Failed to save layout', err);
  }
}

function updateModuleSummary() {
  const summary = document.getElementById('moduleTableSummary');
  if (!summary) {
    return;
  }

  summary.innerHTML = '';

  const addItem = (label, value) => {
    const item = document.createElement('div');
    item.className = 'modules-table__summary-item';
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    item.append(dt, dd);
    summary.appendChild(item);
  };

  if (!modules.length) {
    addItem('Modules', '0');
    addItem('Types', '—');
    addItem('Functional', '—');
    return;
  }

  const typeSet = new Set();
  const colorSet = new Set();
  let functionCount = 0;

  modules.forEach((mod) => {
    if (mod.type) {
      typeSet.add(String(mod.type).toLowerCase());
    }
    if (mod.function) {
      functionCount += 1;
    }
    if (mod.color) {
      colorSet.add(String(mod.color).toLowerCase());
    }
  });

  const functionPercent = Math.round((functionCount / modules.length) * 100);

  addItem('Modules', String(modules.length));
  addItem('Types', String(typeSet.size));
  addItem('Functional', `${functionCount}/${modules.length} | ${Number.isFinite(functionPercent) ? `${functionPercent}%` : '—'}`);
  if (colorSet.size) {
    addItem('Palette', String(colorSet.size));
  }
}

function renderTable() {
  const table = document.getElementById('moduleTable');
  const tbody = table ? table.querySelector('tbody') : null;
  if (!tbody) {
    return;
  }

  const headerLabels = table
    ? Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim())
    : [];

  tbody.innerHTML = '';

  if (!modules.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = headerLabels.length || 9;
    td.className = 'modules-table__empty';
    td.textContent = 'No modules yet — add a prefab or craft one in the form above.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    updateModuleSummary();
    renderLibrary();
    return;
  }

  modules.forEach((m) => {
    const tr = document.createElement('tr');
    const visual = m.asset ? assetLabel(m.asset) || m.asset : '—';

    const cells = [];

    const idCell = document.createElement('td');
    const idLabel = document.createElement('strong');
    idLabel.textContent = m.id;
    idCell.appendChild(idLabel);
    if (m.asset) {
      const assetChip = document.createElement('span');
      assetChip.className = 'modules-table__chip';
      assetChip.textContent = visual;
      idCell.appendChild(assetChip);
    }
    cells.push(idCell);

    const typeCell = document.createElement('td');
    const typePill = document.createElement('span');
    typePill.className = 'modules-table__pill';
    typePill.textContent = m.type || '—';
    typeCell.appendChild(typePill);
    cells.push(typeCell);

    const functionCell = document.createElement('td');
    if (m.function) {
      const fnPill = document.createElement('span');
      fnPill.className = 'modules-table__pill';
      fnPill.textContent = m.function;
      functionCell.appendChild(fnPill);
    } else {
      functionCell.textContent = '—';
    }
    cells.push(functionCell);

    const shapeCell = document.createElement('td');
    shapeCell.textContent = m.shape || '—';
    cells.push(shapeCell);

    const visualCell = document.createElement('td');
    visualCell.textContent = visual;
    cells.push(visualCell);

    const positionCell = document.createElement('td');
    positionCell.textContent = `x ${formatNumber(m.x)} | y ${formatNumber(m.y)} | z ${formatNumber(m.z)}`;
    cells.push(positionCell);

    const sizeCell = document.createElement('td');
    sizeCell.textContent = `${formatNumber(m.w)} x ${formatNumber(m.h)} x ${formatNumber(m.d)}`;
    cells.push(sizeCell);

    const colorCell = document.createElement('td');
    const colorWrap = document.createElement('div');
    colorWrap.className = 'modules-table__color';
    const colorSwatch = document.createElement('span');
    colorSwatch.className = 'modules-table__color-swatch';
    const colorLabel = document.createElement('span');
    const colorName = m.color || '—';
    const colorHex = COLOR_HEX[colorName] || null;
    if (colorHex) {
      colorSwatch.style.backgroundColor = colorHex;
    } else if (colorName && colorName !== '—') {
      colorSwatch.style.backgroundColor = colorName;
    }
    colorLabel.textContent = colorName;
    colorWrap.append(colorSwatch, colorLabel);
    colorCell.appendChild(colorWrap);
    cells.push(colorCell);

    const actionsCell = document.createElement('td');
    const actionWrap = document.createElement('div');
    actionWrap.className = 'modules-table__actions';

    const actions = [
      { label: 'Edit', action: 'edit' },
      { label: 'Duplicate', action: 'duplicate' },
      { label: 'Delete', action: 'delete' },
    ];

    actions.forEach(({ label, action }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modules-table__btn';
      btn.dataset.action = action;
      btn.dataset.moduleId = m.id;
      btn.dataset.moduleFunction = m.function || '';
      btn.textContent = label;
      actionWrap.appendChild(btn);
    });

    actionsCell.appendChild(actionWrap);
    cells.push(actionsCell);

    cells.forEach((cell, index) => {
      const headerLabel = headerLabels[index];
      if (headerLabel) {
        cell.dataset.label = headerLabel;
      }
      tr.appendChild(cell);
    });

    tbody.appendChild(tr);
  });

  updateModuleSummary();
  renderLibrary();
}

function scheduleAutoAnalysis(reason = 'update') {
  if (autoAnalysisTimer) {
    clearTimeout(autoAnalysisTimer);
  }
  autoAnalysisTimer = setTimeout(() => {
    autoAnalysisTimer = null;
    runAutoAnalysis(reason).catch((err) => {
      console.error('Auto analysis failed', err);
      pushStatus('Auto-analysis failed. Check the console for details.', { tone: 'warning', timeout: 6000 });
    });
  }, 320);
}

async function runAutoAnalysis(reason = 'update') {
  if (isOptimizing) {
    return autoAnalysisPromise;
  }
  if (autoAnalysisPromise) {
    return autoAnalysisPromise;
  }

  autoAnalysisPromise = (async () => {
    if (!modules.length) {
      await simulate({ skipSave: true, quiet: true });
      pushStatus('Simulation refreshed for an empty layout.', { tone: 'info', timeout: 2600 });
      return;
    }

    let optimizeResult = null;
    try {
      optimizeResult = await optimizeLayout({ silent: true, skipSimulation: true, reason });
    } catch (err) {
      pushStatus('Auto-optimize failed. Inspect the console for context.', { tone: 'warning', timeout: 6000 });
      throw err;
    } finally {
      try {
        await simulate({ skipSave: true, quiet: true });
      } catch (simErr) {
        console.error('Auto simulation failed', simErr);
        pushStatus('Auto-simulation failed. Check the console for details.', { tone: 'warning', timeout: 6000 });
      }
    }

    if (optimizeResult && optimizeResult.statusMessage) {
      pushStatus(optimizeResult.statusMessage, { tone: optimizeResult.statusTone, timeout: 2800 });
    } else {
      pushStatus('Layout auto-optimized after module update.', { tone: 'success', timeout: 2600 });
    }
  })()
    .finally(() => {
      autoAnalysisPromise = null;
    });

  return autoAnalysisPromise;
}

function ensureAssetOption(value) {
  const select = document.getElementById('assetPreset');
  if (!select || !value) {
    return;
  }
  const exists = Array.from(select.options).some((option) => option.value === value);
  if (!exists) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = assetLabel(value) || value;
    select.appendChild(option);
  }
}

function updateRenderStyleControl() {
  const select = document.getElementById('renderStyle');
  if (!select) {
    return;
  }
  const normalized = String(renderStyle || 'realistic').toLowerCase();
  if (Array.from(select.options).every((option) => option.value !== normalized)) {
    const option = document.createElement('option');
    option.value = normalized;
    option.textContent = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    select.appendChild(option);
  }
  if (select.value !== normalized) {
    select.value = normalized;
  }
}

function resetModuleFormState() {
  editingModuleId = null;
  if (moduleSubmitButton) {
    moduleSubmitButton.textContent = 'Add Module';
  }
  if (moduleForm) {
    moduleForm.dataset.editing = 'false';
  }
}

function populateModuleForm(module) {
  if (!moduleForm) {
    return;
  }
  ensureAssetOption(module.asset);
  const idField = document.getElementById('id');
  const typeField = document.getElementById('type');
  const shapeField = document.getElementById('shape');
  const colorField = document.getElementById('color');
  const assetField = document.getElementById('assetPreset');
  const xField = document.getElementById('x');
  const yField = document.getElementById('y');
  const zField = document.getElementById('z');
  const wField = document.getElementById('w');
  const hField = document.getElementById('h');
  const dField = document.getElementById('d');

  if (idField) idField.value = module.id;
  if (typeField) typeField.value = module.type;
  if (shapeField) shapeField.value = module.shape;
  if (colorField) colorField.value = module.color;
  if (assetField) assetField.value = module.asset || '';
  if (xField) xField.value = formatNumber(module.x, 3);
  if (yField) yField.value = formatNumber(module.y, 3);
  if (zField) zField.value = formatNumber(module.z, 3);
  if (wField) wField.value = formatNumber(module.w, 3);
  if (hField) hField.value = formatNumber(module.h, 3);
  if (dField) dField.value = formatNumber(module.d, 3);

  editingModuleId = module.id;
  if (moduleSubmitButton) {
    moduleSubmitButton.textContent = 'Update Module';
  }
  moduleForm.dataset.editing = 'true';
  activateTabById('module-tab');
}

async function deleteModuleById(moduleId) {
  const index = modules.findIndex((mod) => mod.id === moduleId);
  if (index === -1) {
    return;
  }
  modules.splice(index, 1);
  if (editingModuleId === moduleId) {
    resetModuleFormState();
    if (moduleForm) {
      moduleForm.reset();
    }
    if (assetPresetSelect) {
      assetPresetSelect.value = '';
    }
  }
  await saveLayout();
  renderTable();
  renderMap();
  pushStatus(`Module ${moduleId} removed from the layout.`, { tone: 'info', timeout: 3000 });
  scheduleAutoAnalysis('module-removed');
}

async function duplicateModuleById(moduleId) {
  const original = modules.find((mod) => mod.id === moduleId);
  if (!original) {
    return;
  }
  const clone = {
    ...original,
    id: ensureUniqueModuleId(original.id, null),
    x: numberOr(original.x, 0) + 0.5,
    y: numberOr(original.y, 0) + 0.5,
  };
  const clamped = clampModuleToHabitat(clone);
  modules.push(clamped);
  await saveLayout();
  renderTable();
  renderMap();
  pushStatus(`Module ${clamped.id} duplicated.`, { tone: 'info', timeout: 3000 });
  scheduleAutoAnalysis('module-duplicated');
}

function computeExtents() {
  const footprint = getHabitatFootprint();
  let minX = -footprint.width / 2;
  let maxX = footprint.width / 2;
  let minY = -footprint.depth / 2;
  let maxY = footprint.depth / 2;

  modules.forEach((m) => {
    const width = numberOr(m.w, 1);
    const depth = numberOr(m.d, 1);
    const x = numberOr(m.x, 0);
    const y = numberOr(m.y, 0);
    minX = Math.min(minX, x - width / 2);
    maxX = Math.max(maxX, x + width / 2);
    minY = Math.min(minY, y - depth / 2);
    maxY = Math.max(maxY, y + depth / 2);
  });

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || minX === maxX) {
    minX = -5;
    maxX = 5;
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY === maxY) {
    minY = -5;
    maxY = 5;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (spanX < 1) {
    const mid = (minX + maxX) / 2;
    minX = mid - 0.5;
    maxX = mid + 0.5;
  }
  if (spanY < 1) {
    const mid = (minY + maxY) / 2;
    minY = mid - 0.5;
    maxY = mid + 0.5;
  }

  return { minX, maxX, minY, maxY };
}

function renderMap() {
  const canvas = document.getElementById('layoutCanvas');
  if (!canvas) {
    return;
  }
  const ctx = canvas.getContext('2d');
  const { width: canvasWidth, height: canvasHeight } = canvas;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const { minX, maxX, minY, maxY } = computeExtents();
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scale = 0.8 * Math.min(canvasWidth / spanX, canvasHeight / spanY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const toCanvasX = (value) => (canvasWidth / 2) + (value - centerX) * scale;
  const toCanvasY = (value) => (canvasHeight / 2) - (value - centerY) * scale;

  const gridStep = chooseGridStep(Math.max(spanX, spanY));

  ctx.beginPath();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  for (let x = Math.ceil(minX / gridStep) * gridStep; x <= maxX; x += gridStep) {
    const px = toCanvasX(x);
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvasHeight);
  }
  for (let y = Math.ceil(minY / gridStep) * gridStep; y <= maxY; y += gridStep) {
    const py = toCanvasY(y);
    ctx.moveTo(0, py);
    ctx.lineTo(canvasWidth, py);
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  const zeroX = toCanvasX(0);
  const zeroY = toCanvasY(0);
  ctx.moveTo(zeroX, 0);
  ctx.lineTo(zeroX, canvasHeight);
  ctx.moveTo(0, zeroY);
  ctx.lineTo(canvasWidth, zeroY);
  ctx.stroke();

  ctx.fillStyle = '#1f2937';
  ctx.font = '12px system-ui';
  ctx.fillText('Y', canvasWidth - 14, zeroY - 6);
  ctx.fillText('X', zeroX + 6, 14);

  ctx.beginPath();
  ctx.arc(zeroX, zeroY, 3, 0, Math.PI * 2);
  ctx.fill();

  const type = (habitat.type || DEFAULT_HABITAT.type).toLowerCase();
  ctx.lineWidth = 2;
  if (type === 'sphere') {
    const radius = numberOr(habitat.radius, DEFAULTS_BY_SHAPE.sphere.radius);
    const rPx = radius * scale;
    ctx.strokeStyle = '#2563eb';
    ctx.beginPath();
    ctx.ellipse(zeroX, zeroY, rPx, rPx, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const footprint = getHabitatFootprint();
    const halfW = footprint.width / 2;
    const halfD = footprint.depth / 2;
    const left = toCanvasX(-halfW);
    const right = toCanvasX(halfW);
    const top = toCanvasY(halfD);
    const bottom = toCanvasY(-halfD);
    ctx.strokeStyle = '#2563eb';
    if (type === 'cylinder') {
      ctx.setLineDash([10, 6]);
    }
    ctx.strokeRect(
      Math.min(left, right),
      Math.min(top, bottom),
      Math.abs(right - left),
      Math.abs(bottom - top),
    );
    ctx.setLineDash([]);
  }

  modules.forEach((m) => {
    const width = numberOr(m.w, 1);
    const depth = numberOr(m.d, 1);
    const x = numberOr(m.x, 0);
    const y = numberOr(m.y, 0);
    const left = toCanvasX(x - width / 2);
    const right = toCanvasX(x + width / 2);
    const top = toCanvasY(y + depth / 2);
    const bottom = toCanvasY(y - depth / 2);
    const color = colorToHex(m.color);

    ctx.globalAlpha = 0.25;
    ctx.fillStyle = color;
    ctx.fillRect(
      Math.min(left, right),
      Math.min(top, bottom),
      Math.abs(right - left),
      Math.abs(bottom - top),
    );

    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      Math.min(left, right),
      Math.min(top, bottom),
      Math.abs(right - left),
      Math.abs(bottom - top),
    );

    ctx.fillStyle = '#0f172a';
    ctx.font = '12px system-ui';
    ctx.fillText(
      m.id,
      Math.min(left, right) + 4,
      Math.min(top, bottom) + 14,
    );
  });

  const indicatorPx = gridStep * scale;
  if (indicatorPx > 30) {
    const margin = 18;
    const y = canvasHeight - margin;
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(margin, y);
    ctx.lineTo(margin + indicatorPx, y);
    ctx.moveTo(margin, y - 4);
    ctx.lineTo(margin, y + 4);
    ctx.moveTo(margin + indicatorPx, y - 4);
    ctx.lineTo(margin + indicatorPx, y + 4);
    ctx.stroke();
    ctx.fillStyle = '#1f2937';
    ctx.font = '12px system-ui';
    ctx.fillText(`${formatNumber(gridStep, 1)} m`, margin, y - 8);
  }

  if (!modules.length) {
    ctx.fillStyle = '#64748b';
    ctx.font = '14px system-ui';
    ctx.fillText('Add modules to see their footprint', 20, canvasHeight / 2);
  }
}

function moduleDimensions(mod) {
  return {
    width: Math.max(numberOr(mod.w, 1), 0.1),
    depth: Math.max(numberOr(mod.d, 1), 0.1),
  };
}

function modulesOverlapRect(a, b) {
  if (!a || !b || a.id === b.id) {
    return false;
  }
  const aDims = moduleDimensions(a);
  const bDims = moduleDimensions(b);
  const dx = Math.abs(numberOr(a.x, 0) - numberOr(b.x, 0));
  const dy = Math.abs(numberOr(a.y, 0) - numberOr(b.y, 0));
  return dx < (aDims.width + bDims.width) / 2 && dy < (aDims.depth + bDims.depth) / 2;
}

function findOverlaps(modList) {
  const overlaps = [];
  for (let i = 0; i < modList.length; i += 1) {
    for (let j = i + 1; j < modList.length; j += 1) {
      if (modulesOverlapRect(modList[i], modList[j])) {
        overlaps.push([modList[i].id, modList[j].id]);
      }
    }
  }
  return overlaps;
}

function fitsWithinFootprint(mod, x, y, footprint) {
  const dims = moduleDimensions(mod);
  const halfW = dims.width / 2;
  const halfD = dims.depth / 2;
  const minX = -footprint.width / 2;
  const maxX = footprint.width / 2;
  const minY = -footprint.depth / 2;
  const maxY = footprint.depth / 2;

  if (x - halfW < minX || x + halfW > maxX || y - halfD < minY || y + halfD > maxY) {
    return false;
  }

  const type = (habitat.type || DEFAULT_HABITAT.type).toLowerCase();
  if (type === 'sphere') {
    const radius = numberOr(habitat.radius, DEFAULTS_BY_SHAPE.sphere.radius);
    const corners = [
      [x - halfW, y - halfD],
      [x - halfW, y + halfD],
      [x + halfW, y - halfD],
      [x + halfW, y + halfD],
    ];
    return corners.every(([cx, cy]) => Math.hypot(cx, cy) <= radius);
  }
  if (type === 'cylinder') {
    const radius = numberOr(habitat.radius, DEFAULTS_BY_SHAPE.cylinder.radius);
    const xExtents = [x - halfW, x + halfW];
    return xExtents.every((value) => Math.abs(value) <= radius);
  }
  return true;
}

function computePlacementStep(modList) {
  if (!modList.length) {
    return 0.5;
  }
  let minSpan = Number.POSITIVE_INFINITY;
  modList.forEach((mod) => {
    const dims = moduleDimensions(mod);
    minSpan = Math.min(minSpan, dims.width, dims.depth);
  });
  if (!Number.isFinite(minSpan) || minSpan <= 0) {
    return 0.5;
  }
  return Math.max(0.25, Math.min(minSpan / 2, 1));
}

function ensureUniqueModuleId(desired, excludeId) {
  const normalized = String(desired || 'module')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const core = normalized || 'module';
  const existing = new Set(
    modules
      .filter((mod) => mod.id !== excludeId)
      .map((mod) => String(mod.id || '').toLowerCase()),
  );

  let candidate = core;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${core}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function generateModuleId(base) {
  return ensureUniqueModuleId(base, null);
}

function axisCandidates(min, max, step) {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 0.5;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0];
  }
  if (min > max) {
    const mid = (min + max) / 2;
    return [mid];
  }
  const values = [];
  const epsilon = safeStep / 4;
  for (let value = min; value <= max + epsilon; value += safeStep) {
    const rounded = Math.round(value * 1000) / 1000;
    values.push(rounded);
  }
  values.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  if (!values.length) {
    values.push((min + max) / 2);
  }
  return values;
}

function findAutoPlacement(module, existing = modules) {
  const footprint = getHabitatFootprint();
  const dims = moduleDimensions(module);
  const halfW = dims.width / 2;
  const halfD = dims.depth / 2;
  const minX = (-footprint.width / 2) + halfW;
  const maxX = (footprint.width / 2) - halfW;
  const minY = (-footprint.depth / 2) + halfD;
  const maxY = (footprint.depth / 2) - halfD;

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return { x: numberOr(module.x, 0), y: numberOr(module.y, 0) };
  }

  const step = Math.max(0.25, computePlacementStep(existing.concat(module)));
  const xs = axisCandidates(minX, maxX, step);
  const ys = axisCandidates(minY, maxY, step);

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  ys.forEach((yPos) => {
    xs.forEach((xPos) => {
      if (!fitsWithinFootprint(module, xPos, yPos, footprint)) {
        return;
      }
      const candidate = { ...module, x: xPos, y: yPos };
      const overlaps = existing.some((other) => modulesOverlapRect(candidate, other));
      if (overlaps) {
        return;
      }
      const score = Math.hypot(xPos, yPos);
      if (score < bestScore - 1e-6) {
        bestScore = score;
        best = { x: xPos, y: yPos };
      }
    });
  });

  if (best) {
    return best;
  }

  return {
    x: clamp(numberOr(module.x, 0), minX, maxX),
    y: clamp(numberOr(module.y, 0), minY, maxY),
  };
}

async function spawnModuleFromTemplate(template) {
  const dims = template.size || {};
  const width = numberOr(dims.w ?? dims.width ?? dims.size, 1.6);
  const depth = numberOr(dims.d ?? dims.depth ?? dims.size, 1.2);
  const height = numberOr(dims.h ?? dims.height ?? dims.size, 1.6);
  const defaultZ = numberOr(template.defaultZ, height / 2);

  const provisional = normalizeModule({
    id: generateModuleId(template.asset || template.type || 'module'),
    type: template.type || 'generic',
    shape: template.shape || 'box',
    color: template.color || 'grey',
    w: width,
    d: depth,
    h: height,
    x: numberOr(template.x, 0),
    y: numberOr(template.y, 0),
    z: numberOr(template.z, defaultZ),
    asset: template.asset,
  });

  provisional.asset = template.asset;
  const clamped = clampModuleToHabitat(provisional);
  const placement = findAutoPlacement(clamped);
  clamped.x = placement.x;
  clamped.y = placement.y;
  const overlaps = modules.some((existing) => modulesOverlapRect(clamped, existing));
  modules.push(clamped);
  await saveLayout();
  renderTable();
  renderMap();
  pushStatus(`Module ${clamped.id} added from the library.`, { tone: 'success', timeout: 3200 });
  scheduleAutoAnalysis('library-template');
  if (overlaps) {
    console.warn(`Module "${clamped.id}" overlaps existing geometry; adjust its placement manually.`);
    pushStatus(`Module ${clamped.id} overlaps existing geometry. Adjust placement to avoid collisions.`, { tone: 'warning', timeout: 7000 });
  }
}

function renderLibrary() {
  const container = document.getElementById('moduleLibrary');
  if (!container) {
    return;
  }

  container.innerHTML = '';

  const hasEntries = moduleLibrary.length > 0;
  const query = moduleLibraryQuery.trim();
  const normalizedQuery = query.toLowerCase();
  const filtered = hasEntries
    ? moduleLibrary.filter((item) => {
      if (!normalizedQuery) {
        return true;
      }
      const haystack = [
        item.label,
        item.type,
        item.function,
        item.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    : [];

  if (!hasEntries) {
    const placeholder = document.createElement('p');
    placeholder.className = 'module-library__placeholder';
    placeholder.textContent = 'Loading ready-made critical prefabs…';
    container.appendChild(placeholder);
    return;
  }

  if (!filtered.length) {
    const placeholder = document.createElement('p');
    placeholder.className = 'module-library__placeholder';
    placeholder.textContent = query ? `No prefabs found for "${query}".` : 'No prefabs available.';
    container.appendChild(placeholder);
    return;
  }

  filtered.forEach((item) => {
    const count = modules.filter((mod) => mod.asset === item.asset).length;

    const card = document.createElement('div');
    card.className = 'module-card';

    const header = document.createElement('div');
    header.className = 'module-card__header';

    const title = document.createElement('span');
    title.className = 'module-card__title';
    title.textContent = item.label;
    header.appendChild(title);

    const tag = document.createElement('span');
    tag.className = 'module-card__tag';
    tag.textContent = item.type;
    header.appendChild(tag);

    const swatch = document.createElement('span');
    swatch.className = 'module-card__swatch';
    swatch.style.backgroundColor = colorToHex(item.color);
    header.appendChild(swatch);

    if (count) {
      const badge = document.createElement('span');
      badge.className = 'module-card__count';
      badge.textContent = `×${count}`;
      header.appendChild(badge);
    }

    card.appendChild(header);

    if (item.description) {
      const description = document.createElement('p');
      description.className = 'module-card__description';
      description.textContent = item.description;
      card.appendChild(description);
    }

    const metrics = document.createElement('div');
    metrics.className = 'module-card__metrics';
    metrics.innerHTML = `
      <span>${formatNumber(item.size.w)} × ${formatNumber(item.size.d)} × ${formatNumber(item.size.h)} m</span>
      <span>z ${formatNumber(item.defaultZ || item.size.h / 2)} m</span>
    `;
    card.appendChild(metrics);

    const actions = document.createElement('div');
    actions.className = 'module-card__actions';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'module-card__action';
    addBtn.textContent = 'Add to layout';
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      card.classList.add('module-card--pending');
      try {
        await spawnModuleFromTemplate(item);
        card.classList.add('module-card--added');
        setTimeout(() => card.classList.remove('module-card--added'), 900);
      } finally {
        addBtn.disabled = false;
        card.classList.remove('module-card--pending');
      }
    });
    actions.appendChild(addBtn);
    card.appendChild(actions);

    container.appendChild(card);
  });
}

function destroyMetricsCharts() {
  Object.keys(metricsCharts).forEach((key) => {
    const chart = metricsCharts[key];
    if (chart && typeof chart.destroy === 'function') {
      chart.destroy();
    }
    metricsCharts[key] = null;
  });
}

function updateMetricsView(metrics, requirements = currentRequirements) {
  currentMetrics = metrics || null;
  currentRequirements = requirements || null;
  const metricsPre = document.getElementById('metrics');
  if (metricsPre) {
    if (metrics || requirements) {
      metricsPre.textContent = JSON.stringify({ metrics, requirements }, null, 2);
    } else {
      metricsPre.textContent = 'Run a simulation to generate metrics.';
    }
  }
  const summary = document.getElementById('requirementsSummary');
  if (summary) {
    if (!requirements) {
      summary.innerHTML = '<strong>Critical Coverage</strong><span>No requirement data yet.</span>';
    } else {
      const covered = Number.parseInt(requirements.covered ?? 0, 10);
      const total = Number.parseInt(requirements.required ?? 0, 10);
      const score = Number.parseFloat(requirements.score ?? 0);
      const missingList = Array.isArray(requirements.missing) ? requirements.missing : [];
      const missingText = missingList.length
        ? `Missing: ${missingList.map((item) => `${item.type} — ${item.function}`).join('; ')}`
        : 'All critical functionalities satisfied.';
      const percent = Math.max(0, Math.min(score, 100));
      summary.innerHTML = `
        <strong>Critical Coverage</strong>
        <div class="requirements-progress"><span style="width:${percent}%"></span></div>
        <span>${covered}/${total} critical functions included · ${percent.toFixed(1)}%</span>
        <span>${missingText}</span>
      `;
    }
  }
  renderMetricsCharts(metrics, requirements);
}

function updateCrewControls() {
  if (crewInput && crewInput.value !== String(crewSize)) {
    crewInput.value = crewSize;
  }
  if (missionPromptInput && missionPromptInput.value !== missionPromptText) {
    missionPromptInput.value = missionPromptText;
  }
}

function renderMetricsCharts(metrics, requirements) {
  const hasCharts = typeof window.Chart === 'function';
  const volumeCanvas = document.getElementById('metricsVolumeChart');
  const usageCanvas = document.getElementById('metricsUsageChart');
  const footprintCanvas = document.getElementById('metricsFootprintChart');

  if (!hasCharts || !volumeCanvas || !usageCanvas || !footprintCanvas) {
    return;
  }

  const safeMetrics = metrics || {};

  if (!metrics) {
    destroyMetricsCharts();
    [volumeCanvas, usageCanvas, footprintCanvas].forEach((canvas) => {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    });
    return;
  }

  const volumeConfig = {
    type: 'bar',
    data: {
      labels: ['Habitat', 'Modules'],
      datasets: [{
        label: 'Volume (m³)',
        data: [
          numberOr(safeMetrics.habitat_volume_m3, 0),
          numberOr(safeMetrics.module_volume_m3, 0),
        ],
        backgroundColor: ['#38bdf8', '#f97316'],
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#e2e8f0' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#e2e8f0' },
          grid: { color: 'rgba(148, 163, 184, 0.2)' },
        },
      },
      plugins: {
        legend: { display: false },
      },
    },
  };

  const usageRatio = Math.max(0, Math.min(1, numberOr(requirements?.score, 0) / 100));
  const usageConfig = {
    type: 'doughnut',
    data: {
      labels: ['Critical Covered', 'Missing'],
      datasets: [{
        data: [usageRatio, Math.max(0, 1 - usageRatio)],
        backgroundColor: ['#22c55e', '#1f2937'],
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#e2e8f0', boxWidth: 12 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${(Number(ctx.raw) * 100).toFixed(1)}%`,
          },
        },
      },
    },
  };

  const footprint = safeMetrics.footprint_m || {};
  const footprintConfig = {
    type: 'radar',
    data: {
      labels: ['Width', 'Depth', 'Height'],
      datasets: [{
        label: 'Footprint (m)',
        data: [
          numberOr(footprint.width, 0),
          numberOr(footprint.depth, 0),
          numberOr(footprint.height, 0),
        ],
        backgroundColor: 'rgba(99, 102, 241, 0.25)',
        borderColor: '#6366f1',
        pointBackgroundColor: '#6366f1',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        r: {
          angleLines: { color: 'rgba(148, 163, 184, 0.2)' },
          grid: { color: 'rgba(148, 163, 184, 0.2)' },
          suggestedMin: 0,
          ticks: {
            display: true,
            color: '#94a3b8',
            backdropColor: 'transparent',
          },
          pointLabels: {
            color: '#e2e8f0',
            font: { size: 12 },
          },
        },
      },
    },
  };

  const chartConfigs = [
    ['volume', volumeCanvas, volumeConfig],
    ['usage', usageCanvas, usageConfig],
    ['footprint', footprintCanvas, footprintConfig],
  ];

  chartConfigs.forEach(([key, canvas, config]) => {
    if (!metricsCharts[key]) {
      metricsCharts[key] = new window.Chart(canvas, config);
    } else {
      metricsCharts[key].data = config.data;
      metricsCharts[key].options = config.options;
      metricsCharts[key].update();
    }
  });
}

function canonicalRequirementText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function requirementKey(typeKey, functionKey) {
  return `${typeKey}|${functionKey}`;
}

function parseFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function firstFinite(...values) {
  for (let i = 0; i < values.length; i += 1) {
    const num = Number(values[i]);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return null;
}

async function ensureRequirementCatalog() {
  if (requirementCatalogMap && requirementTypeIndex) {
    return { catalog: requirementCatalogMap, typeIndex: requirementTypeIndex };
  }
  if (!requirementCatalogPromise) {
    requirementCatalogPromise = fetch('/requirements/catalog')
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Requirement catalog request failed (${res.status})`);
        }
        return res.json();
      })
      .then((data) => {
        const catalog = new Map();
        const typeIndex = new Map();
        const entries = Array.isArray(data.requirements) ? data.requirements : [];
        entries.forEach((item) => {
          const canonicalType = canonicalRequirementText(item.canonicalType || item.type);
          const canonicalFunction = canonicalRequirementText(item.canonicalFunction || item.function);
          if (!canonicalType || !canonicalFunction) {
            return;
          }
          const key = requirementKey(canonicalType, canonicalFunction);
          const entry = {
            type: item.type,
            function: item.function,
            canonicalType,
            canonicalFunction,
            minWidth: parseFiniteNumber(item.minWidth),
            minDepth: parseFiniteNumber(item.minDepth),
            minHeight: parseFiniteNumber(item.minHeight),
            typeCriticality: parseFiniteNumber(item.typeCriticality),
            functionCriticality: parseFiniteNumber(item.functionCriticality),
            volume4: parseFiniteNumber(item.volume4),
            volume6: parseFiniteNumber(item.volume6),
            volumeDelta: parseFiniteNumber(item.volumeDelta),
          };
          catalog.set(key, entry);
          if (!typeIndex.has(canonicalType)) {
            typeIndex.set(canonicalType, new Set());
          }
          typeIndex.get(canonicalType).add(canonicalFunction);
        });
        requirementCatalogMap = catalog;
        requirementTypeIndex = typeIndex;
        return { catalog, typeIndex };
      })
      .catch((err) => {
        console.error('Failed to load requirement catalog', err);
        if (!requirementCatalogMap) {
          requirementCatalogMap = new Map();
        }
        if (!requirementTypeIndex) {
          requirementTypeIndex = new Map();
        }
        return { catalog: requirementCatalogMap, typeIndex: requirementTypeIndex };
      });
  }
  return requirementCatalogPromise;
}

function lookupRequirementForModule(module) {
  if (!requirementCatalogMap || !requirementTypeIndex) {
    return null;
  }
  const typeCandidate = canonicalRequirementText(module.type || module.kind || '');
  const functionCandidate = canonicalRequirementText(
    module.function || module.functionality || module.id || '',
  );
  if (typeCandidate && functionCandidate) {
    const directKey = requirementKey(typeCandidate, functionCandidate);
    if (requirementCatalogMap.has(directKey)) {
      return requirementCatalogMap.get(directKey);
    }
  }
  if (typeCandidate && requirementTypeIndex.has(typeCandidate)) {
    const functions = requirementTypeIndex.get(typeCandidate);
    if (functions.size === 1) {
      const [onlyFunction] = Array.from(functions);
      const key = requirementKey(typeCandidate, onlyFunction);
      if (requirementCatalogMap.has(key)) {
        return requirementCatalogMap.get(key);
      }
    }
    const searchSpace = [
      canonicalRequirementText(module.function),
      canonicalRequirementText(module.id),
      canonicalRequirementText(module.kind),
      canonicalRequirementText(module.type),
    ];
    for (let i = 0; i < searchSpace.length; i += 1) {
      const candidate = searchSpace[i];
      if (candidate && functions.has(candidate)) {
        const key = requirementKey(typeCandidate, candidate);
        if (requirementCatalogMap.has(key)) {
          return requirementCatalogMap.get(key);
        }
      }
    }
  }
  return null;
}

function buildModuleInfoList(modulesList) {
  return modulesList.map((mod) => {
    const size = (mod.size && typeof mod.size === 'object') ? mod.size : {};
    const requirement = lookupRequirementForModule(mod);
    const rawWidth = firstFinite(mod.w, size.w, size.width);
    const rawDepth = firstFinite(mod.d, size.d, size.depth);
    const rawHeight = firstFinite(mod.h, size.h, size.height);
    const minWidth = requirement?.minWidth ?? 0;
    const minDepth = requirement?.minDepth ?? 0;
    const minHeight = requirement?.minHeight ?? 0;
    const width = Math.max(numberOr(rawWidth, 1), minWidth, 0.1);
    const depth = Math.max(numberOr(rawDepth, 1), minDepth, 0.1);
    const height = Math.max(numberOr(rawHeight, 1), minHeight, 0.1);
    const functionCriticality = Number.isFinite(requirement?.functionCriticality)
      ? requirement.functionCriticality
      : null;
    const typeCriticality = Number.isFinite(requirement?.typeCriticality)
      ? requirement.typeCriticality
      : null;
    return {
      id: mod.id,
      module: mod,
      type: mod.type || mod.kind || 'generic',
      width,
      depth,
      height,
      volume: width * depth * height,
      requirement,
      functionCriticality,
      typeCriticality,
    };
  });
}

function resolveHabitatBounds(footprint = {}) {
  const type = String(footprint.type || habitat.type || DEFAULT_HABITAT.type).toLowerCase();
  const width = Math.max(numberOr(footprint.width, 0), 0);
  const depth = Math.max(numberOr(footprint.depth, 0), 0);
  const height = Math.max(numberOr(footprint.height, width || 0), 0);

  if (type === 'cube') {
    const halfWidth = width / 2;
    const halfDepth = depth / 2;
    const halfHeight = height / 2;
    return {
      type,
      width,
      depth,
      height,
      halfWidth,
      halfDepth,
      halfHeight,
      radius: null,
      floorZ: -halfHeight,
      ceilingZ: halfHeight,
    };
  }

  const radius = Math.max(numberOr(footprint.radius, width / 2), 0);
  const diameter = radius * 2;
  const length = Math.max(numberOr(footprint.length, depth), 0);
  const halfDepth = length / 2;
  const safeHeight = type === 'sphere' ? diameter : Math.max(height || diameter, 0);

  if (type === 'sphere') {
    return {
      type,
      width: diameter,
      depth: diameter,
      height: safeHeight,
      halfWidth: diameter / 2,
      halfDepth: diameter / 2,
      halfHeight: safeHeight / 2,
      radius,
      floorZ: -radius,
      ceilingZ: radius,
    };
  }

  return {
    type,
    width: diameter,
    depth: length,
    height: safeHeight,
    halfWidth: diameter / 2,
    halfDepth,
    halfHeight: safeHeight / 2,
    radius,
    floorZ: -radius,
    ceilingZ: radius,
  };
}

function describeOverflowReason(reason) {
  if (!reason) {
    return '';
  }
  return OVERFLOW_REASON_TEXT[reason] || 'Does not fit';
}

function evaluateModuleFeasibility(info, bounds) {
  if (!info || !bounds) {
    return { ok: false, reason: 'invalid-data' };
  }

  const epsilon = 1e-6;
  const width = Number.isFinite(info.width) ? info.width : 0;
  const depth = Number.isFinite(info.depth) ? info.depth : 0;
  const height = Number.isFinite(info.height) ? info.height : 0;

  if (width <= 0 || depth <= 0 || height <= 0) {
    return { ok: false, reason: 'invalid-dimensions' };
  }

  if (bounds.height > 0 && height > bounds.height + epsilon) {
    return { ok: false, reason: 'height-exceeds' };
  }

  if (bounds.type === 'cube') {
    if ((bounds.width > 0 && width > bounds.width + epsilon)
      || (bounds.depth > 0 && depth > bounds.depth + epsilon)) {
      return { ok: false, reason: 'footprint-exceeds' };
    }
    return { ok: true };
  }

  if (bounds.type === 'sphere') {
    const radius = Number.isFinite(bounds.radius) ? bounds.radius : 0;
    if (radius <= 0) {
      return { ok: false, reason: 'invalid-habitat' };
    }
    const hx = width / 2;
    const hy = depth / 2;
    const hz = height / 2;
    const moduleRadius = Math.sqrt((hx * hx) + (hy * hy) + (hz * hz));
    if (moduleRadius > radius + epsilon) {
      return { ok: false, reason: 'volume-exceeds' };
    }
    return { ok: true };
  }

  const radius = Number.isFinite(bounds.radius) ? bounds.radius : 0;
  if (radius <= 0) {
    return { ok: false, reason: 'invalid-habitat' };
  }
  const halfDepth = Number.isFinite(bounds.halfDepth) ? bounds.halfDepth : 0;
  if (halfDepth > 0 && depth > (halfDepth * 2) + epsilon) {
    return { ok: false, reason: 'length-exceeds' };
  }
  const hx = width / 2;
  const hz = height / 2;
  if (Math.hypot(hx, hz) > radius + epsilon) {
    return { ok: false, reason: 'cross-section-exceeds' };
  }
  return { ok: true };
}

function placementWithinHabitat(placement, dims, bounds) {
  if (!placement || !dims || !bounds) {
    return false;
  }
  const epsilon = 1e-6;
  const halfW = dims.width / 2;
  const halfD = dims.depth / 2;
  const halfH = dims.height / 2;

  if (halfW < 0 || halfD < 0 || halfH < 0) {
    return false;
  }

  if (bounds.type === 'cube') {
    if (bounds.halfWidth > 0 && (placement.x + halfW > bounds.halfWidth + epsilon || placement.x - halfW < -bounds.halfWidth - epsilon)) {
      return false;
    }
    if (bounds.halfDepth > 0 && (placement.y + halfD > bounds.halfDepth + epsilon || placement.y - halfD < -bounds.halfDepth - epsilon)) {
      return false;
    }
    if (placement.z + halfH > bounds.ceilingZ + epsilon || placement.z - halfH < bounds.floorZ - epsilon) {
      return false;
    }
    return true;
  }

  if (bounds.type === 'sphere') {
    const radius = Number.isFinite(bounds.radius) ? bounds.radius : 0;
    if (radius <= 0) {
      return false;
    }
    const clamped = vectorClampToSphere(
      placement.x,
      placement.y,
      placement.z,
      halfW,
      halfD,
      halfH,
      radius,
    );
    return (
      Math.abs(clamped.x - placement.x) <= epsilon
      && Math.abs(clamped.y - placement.y) <= epsilon
      && Math.abs(clamped.z - placement.z) <= epsilon
    );
  }

  const radius = Number.isFinite(bounds.radius) ? bounds.radius : 0;
  if (radius <= 0) {
    return false;
  }
  if (bounds.halfDepth > 0 && (placement.y + halfD > bounds.halfDepth + epsilon || placement.y - halfD < -bounds.halfDepth - epsilon)) {
    return false;
  }
  if (placement.z + halfH > bounds.ceilingZ + epsilon || placement.z - halfH < bounds.floorZ - epsilon) {
    return false;
  }
  const clamped = vectorClampToCircle(placement.x, placement.z, halfW, halfH, radius);
  return (
    Math.abs(clamped.x - placement.x) <= epsilon
    && Math.abs(clamped.z - placement.z) <= epsilon
  );
}

function attemptTypeClusterLayout(moduleInfos, footprint, options = {}) {
  const bounds = resolveHabitatBounds(footprint || {});
  const width = Number.isFinite(bounds.width) ? bounds.width : 0;
  const depth = Number.isFinite(bounds.depth) ? bounds.depth : 0;
  const heightLimit = Number.isFinite(bounds.height) ? bounds.height : 0;

  if (width <= 0 || depth <= 0 || heightLimit <= 0) {
    const overflowCopy = moduleInfos.slice();
    const overflowVolume = overflowCopy.reduce(
      (sum, info) => sum + (Number.isFinite(info?.volume) ? info.volume : 0),
      0,
    );
    return {
      placements: new Map(),
      overflow: overflowCopy,
      meta: {
        options,
        overflowVolume,
        placedVolume: 0,
        usableWidth: 0,
        usableDepth: 0,
        overflowReasons: {},
        floorZ: bounds.floorZ ?? 0,
        ceilingZ: bounds.ceilingZ ?? 0,
        habitatType: bounds.type,
      },
    };
  }

  const marginFactor = Number.isFinite(options.marginFactor) ? options.marginFactor : 0.05;
  const minMargin = Number.isFinite(options.minMargin) ? options.minMargin : 0.5;
  const gapFactor = Number.isFinite(options.gapFactor) ? options.gapFactor : 0.5;
  const minGap = Number.isFinite(options.minGap) ? options.minGap : 0.25;
  const allowRotate = Boolean(options.allowRotate);
  const moduleOrder = options.moduleOrder === 'area-asc' ? 'area-asc' : 'area-desc';
  const groupOrder = options.groupOrder === 'ascending' ? 'ascending' : 'descending';

  const minX = -width / 2;
  const maxX = width / 2;
  const minY = -depth / 2;
  const maxY = depth / 2;
  const margin = Math.max(minMargin, Math.min(width, depth) * marginFactor);
  const gap = Math.max(minGap, margin * gapFactor);
  const usableWidth = Math.max(width - (2 * margin), 0);
  const usableDepth = Math.max(depth - (2 * margin), 0);

  if (usableWidth <= 0 || usableDepth <= 0) {
    const overflowCopy = moduleInfos.slice();
    const overflowVolume = overflowCopy.reduce(
      (sum, info) => sum + (Number.isFinite(info?.volume) ? info.volume : 0),
      0,
    );
    return {
      placements: new Map(),
      overflow: overflowCopy,
      meta: {
        options,
        overflowVolume,
        placedVolume: 0,
        usableWidth,
        usableDepth,
        overflowReasons: {},
        floorZ: bounds.floorZ ?? 0,
        ceilingZ: bounds.ceilingZ ?? 0,
        habitatType: bounds.type,
      },
    };
  }

  const overflowSet = new Set();
  const overflowReasons = new Map();
  const placeableInfos = [];

  moduleInfos.forEach((info) => {
    const feasibility = evaluateModuleFeasibility(info, bounds);
    if (!feasibility.ok) {
      if (info?.id != null) {
        overflowSet.add(info.id);
        if (feasibility.reason) {
          overflowReasons.set(info.id, feasibility.reason);
        }
      }
      return;
    }
    placeableInfos.push(info);
  });

  const typeGroups = new Map();
  placeableInfos.forEach((info) => {
    const typeKey = canonicalRequirementText(info.type || info.module.type || info.module.kind || 'generic') || 'generic';
    if (!typeGroups.has(typeKey)) {
      typeGroups.set(typeKey, []);
    }
    typeGroups.get(typeKey).push(info);
  });

  const groups = Array.from(typeGroups.values());
  groups.sort((groupA, groupB) => {
    const totalA = groupA.reduce((sum, item) => sum + (Number.isFinite(item.volume) ? item.volume : 0), 0);
    const totalB = groupB.reduce((sum, item) => sum + (Number.isFinite(item.volume) ? item.volume : 0), 0);
    if (groupOrder === 'ascending') {
      return totalA - totalB;
    }
    return totalB - totalA;
  });
  const placements = new Map();
  let groupStartY = minY + margin;

  function buildCandidateDimensions(info, state) {
    const dims = [];
    const baseWidth = Math.max(Math.min(info.width, usableWidth), 0.1);
    const baseDepth = Math.max(Math.min(info.depth, usableDepth), 0.1);
    dims.push({ width: baseWidth, depth: baseDepth, rotated: false });
    if (allowRotate && Math.abs(info.width - info.depth) > 1e-6) {
      const rotatedWidth = Math.max(Math.min(info.depth, usableWidth), 0.1);
      const rotatedDepth = Math.max(Math.min(info.width, usableDepth), 0.1);
      if (rotatedWidth !== baseWidth || rotatedDepth !== baseDepth) {
        dims.push({ width: rotatedWidth, depth: rotatedDepth, rotated: true });
      }
    }
    const remainingWidth = Math.max(usableWidth - state.xCursor, 0);
    dims.sort((a, b) => Math.abs(remainingWidth - a.width) - Math.abs(remainingWidth - b.width));
    return dims;
  }

  function attemptPlacement(info, dims, state) {
    const height = Math.max(info.height, 0.1);
    let nextXCursor = state.xCursor;
    let nextRowStartY = state.rowStartY;
    let nextRowHeight = state.rowHeight;

    if (nextXCursor + dims.width > usableWidth + 1e-6) {
      nextXCursor = 0;
      nextRowStartY = state.rowStartY + state.rowHeight + gap;
      nextRowHeight = 0;
    }

    const centerY = nextRowStartY + (dims.depth / 2);
    if (centerY + (dims.depth / 2) > maxY - margin + 1e-6) {
      return null;
    }

    const centerX = (minX + margin) + nextXCursor + (dims.width / 2);
    if (centerX + (dims.width / 2) > maxX - margin + 1e-6) {
      return null;
    }

    const halfHeight = height / 2;
    const baseZ = (bounds.floorZ ?? 0) + halfHeight;
    const placement = {
      x: centerX,
      y: centerY,
      z: baseZ,
      w: dims.width,
      d: dims.depth,
      h: height,
    };

    if (!placementWithinHabitat(placement, { width: dims.width, depth: dims.depth, height }, bounds)) {
      const ceilingLimit = (bounds.ceilingZ ?? baseZ) - halfHeight;
      if (!Number.isFinite(ceilingLimit) || ceilingLimit < baseZ - 1e-6) {
        return null;
      }

      let low = baseZ;
      let high = ceilingLimit;
      let best = null;
      for (let iter = 0; iter < 24; iter += 1) {
        const mid = (low + high) / 2;
        placement.z = mid;
        if (placementWithinHabitat(placement, { width: dims.width, depth: dims.depth, height }, bounds)) {
          best = mid;
          high = mid;
        } else {
          low = mid;
        }
        if (high - low < 1e-3) {
          break;
        }
      }

      if (best === null) {
        return null;
      }
      placement.z = best;
    }

    return {
      placement,
      xCursor: nextXCursor + dims.width + gap,
      rowStartY: nextRowStartY,
      rowHeight: Math.max(nextRowHeight, dims.depth),
      groupBottom: Math.max(state.groupBottom, centerY + (dims.depth / 2)),
    };
  }

  for (let gIndex = 0; gIndex < groups.length; gIndex += 1) {
    const group = groups[gIndex].slice();
    group.sort((a, b) => {
      const areaA = (a.width * a.depth);
      const areaB = (b.width * b.depth);
      if (moduleOrder === 'area-asc') {
        return areaA - areaB;
      }
      return areaB - areaA;
    });

    const state = {
      xCursor: 0,
      rowStartY: groupStartY,
      rowHeight: 0,
      groupBottom: groupStartY,
    };

    for (let i = 0; i < group.length; i += 1) {
      const info = group[i];
      const candidates = buildCandidateDimensions(info, state);
      let placed = false;
      for (let cIndex = 0; cIndex < candidates.length; cIndex += 1) {
        const attempt = attemptPlacement(info, candidates[cIndex], state);
        if (!attempt) {
          continue;
        }
        placements.set(info.id, attempt.placement);
        state.xCursor = attempt.xCursor;
        state.rowStartY = attempt.rowStartY;
        state.rowHeight = attempt.rowHeight;
        state.groupBottom = attempt.groupBottom;
        placed = true;
        break;
      }
      if (!placed) {
        overflowSet.add(info.id);
        if (!overflowReasons.has(info.id)) {
          overflowReasons.set(info.id, 'space-exhausted');
        }
      }
    }

    groupStartY = state.groupBottom + gap;
    if (groupStartY > maxY - margin) {
      for (let j = gIndex + 1; j < groups.length; j += 1) {
        groups[j].forEach((info) => {
          overflowSet.add(info.id);
          if (!overflowReasons.has(info.id)) {
            overflowReasons.set(info.id, 'space-exhausted');
          }
        });
      }
      break;
    }
  }

  moduleInfos.forEach((info) => {
    if (!placements.has(info.id)) {
      overflowSet.add(info.id);
      if (!overflowReasons.has(info.id)) {
        overflowReasons.set(info.id, 'space-exhausted');
      }
    }
  });

  const overflow = moduleInfos
    .filter((info) => overflowSet.has(info.id))
    .map((info) => ({ ...info, overflowReason: overflowReasons.get(info.id) || null }));
  const overflowVolume = overflow.reduce(
    (sum, info) => sum + (Number.isFinite(info?.volume) ? info.volume : 0),
    0,
  );
  const placedVolume = moduleInfos.reduce(
    (sum, info) => sum + (placements.has(info.id) && Number.isFinite(info?.volume) ? info.volume : 0),
    0,
  );

  return {
    placements,
    overflow,
    meta: {
      options,
      overflowVolume,
      placedVolume,
      usableWidth,
      usableDepth,
      overflowReasons: Object.fromEntries(overflowReasons.entries()),
      floorZ: bounds.floorZ ?? 0,
      ceilingZ: bounds.ceilingZ ?? 0,
      habitatType: bounds.type,
    },
  };
}

function evaluateLayoutStrategies(moduleInfos, footprint) {
  const strategies = [
    { key: 'default' },
    { key: 'rotate', allowRotate: true },
    { key: 'tight-gap', allowRotate: true, marginFactor: 0.04, gapFactor: 0.4 },
    { key: 'compact', allowRotate: true, marginFactor: 0.03, gapFactor: 0.3, moduleOrder: 'area-asc' },
    {
      key: 'dense',
      allowRotate: true,
      marginFactor: 0.02,
      gapFactor: 0.25,
      minMargin: 0.35,
      minGap: 0.2,
      moduleOrder: 'area-asc',
      groupOrder: 'ascending',
    },
  ];

  let bestResult = null;
  for (let i = 0; i < strategies.length; i += 1) {
    const strategy = strategies[i];
    const attempt = attemptTypeClusterLayout(moduleInfos, footprint, strategy);
    const decorated = { ...attempt, strategy };
    if (!bestResult) {
      bestResult = decorated;
    } else {
      const currentOverflow = decorated.overflow.length;
      const bestOverflow = bestResult.overflow.length;
      const currentVolume = decorated.meta?.overflowVolume ?? Number.POSITIVE_INFINITY;
      const bestVolume = bestResult.meta?.overflowVolume ?? Number.POSITIVE_INFINITY;
      if (
        currentOverflow < bestOverflow
        || (currentOverflow === bestOverflow && currentVolume < bestVolume)
      ) {
        bestResult = decorated;
      }
    }
    if (!decorated.overflow.length) {
      bestResult = decorated;
      break;
    }
  }
  return bestResult;
}

function populateModuleRemovalDialog(overflowInfos, allInfos, attempt = 0) {
  if (!moduleRemovalList) {
    return;
  }

  moduleRemovalList.innerHTML = '';
  moduleRemovalList.classList.remove('modal__list--empty');
  if (moduleRemovalRemoveAll) {
    moduleRemovalRemoveAll.disabled = !(overflowInfos && overflowInfos.length);
  }
  if (moduleRemovalMessage) {
    moduleRemovalMessage.textContent = attempt > 0
      ? 'Space is still constrained. Remove another module or clear all overflow to continue optimizing.'
      : 'Some modules cannot fit inside the habitat. Select a module to remove or clear all overflow to free up space.';
  }

  const overflowDetailMap = new Map((overflowInfos || []).map((info) => [info.id, info]));
  const overflowIds = new Set((overflowInfos || []).map((info) => info.id));
  const sorted = (allInfos || [])
    .slice()
    .sort((a, b) => {
      const aOverflow = overflowIds.has(a.id) ? 1 : 0;
      const bOverflow = overflowIds.has(b.id) ? 1 : 0;
      if (aOverflow !== bOverflow) {
        return bOverflow - aOverflow;
      }
      const volA = Number.isFinite(a.volume) ? a.volume : 0;
      const volB = Number.isFinite(b.volume) ? b.volume : 0;
      if (volA !== volB) {
        return volB - volA;
      }
      return String(a.id).localeCompare(String(b.id));
    });

  if (!sorted.length) {
    const emptyNote = document.createElement('li');
    emptyNote.className = 'modal__empty';
    emptyNote.textContent = 'No modules available to remove.';
    moduleRemovalList.appendChild(emptyNote);
    moduleRemovalList.classList.add('modal__list--empty');
    if (moduleRemovalConfirm) {
      moduleRemovalConfirm.disabled = true;
    }
    moduleRemovalSelectedId = null;
    return;
  }

  const fragment = document.createDocumentFragment();
  sorted.forEach((info) => {
    if (!info || !info.module) {
      return;
    }
    const role = info.module.function || info.module.type || info.type || 'Module';
    const dimsText = `${formatNumber(info.width, 1)}m × ${formatNumber(info.depth, 1)}m × ${formatNumber(info.height, 1)}m`;
    const volumeText = `${formatNumber(info.volume, 1)} m³`;

    const item = document.createElement('li');
    item.className = 'modal__option';

    const label = document.createElement('label');
    label.className = 'modal__option-label';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'moduleRemovalChoice';
    radio.value = info.id;
    radio.className = 'modal__option-input';

    const body = document.createElement('div');
    body.className = 'modal__option-body';

    const title = document.createElement('div');
    title.className = 'modal__option-title';
    title.textContent = info.id;

    const meta = document.createElement('div');
    meta.className = 'modal__option-meta';
    meta.textContent = `${role} • ${dimsText} • ${volumeText}`;

    body.appendChild(title);
    body.appendChild(meta);

    if (overflowIds.has(info.id)) {
      const overflowInfo = overflowDetailMap.get(info.id) || info;
      const reasonText = describeOverflowReason(overflowInfo?.overflowReason);
      const badge = document.createElement('span');
      badge.className = 'modal__badge modal__badge--alert';
      badge.textContent = reasonText || 'Does not fit';
      body.appendChild(badge);
    }

    label.appendChild(radio);
    label.appendChild(body);
    item.appendChild(label);
    fragment.appendChild(item);
  });

  moduleRemovalList.appendChild(fragment);
  moduleRemovalSelectedId = null;
  if (moduleRemovalConfirm) {
    moduleRemovalConfirm.disabled = true;
  }
}

function closeModuleRemovalDialog(result) {
  if (moduleRemovalOverlay) {
    moduleRemovalOverlay.classList.remove('modal--open');
    moduleRemovalOverlay.setAttribute('aria-hidden', 'true');
  }
  if (moduleRemovalKeyHandler) {
    document.removeEventListener('keydown', moduleRemovalKeyHandler, true);
  }
  moduleRemovalKeyHandler = null;

  const resolver = moduleRemovalResolver;
  moduleRemovalResolver = null;
  moduleRemovalSelectedId = null;

  if (moduleRemovalConfirm) {
    moduleRemovalConfirm.disabled = true;
  }
  if (moduleRemovalList) {
    moduleRemovalList.innerHTML = '';
    moduleRemovalList.classList.remove('modal__list--empty');
  }
  
  const focusTarget = moduleRemovalFocusedBeforeOpen;
  moduleRemovalFocusedBeforeOpen = null;
  if (focusTarget && typeof focusTarget.focus === 'function') {
    focusTarget.focus();
  }

  if (typeof resolver === 'function') {
    resolver(typeof result === 'string' ? result : null);
  }
}

function showModuleRemovalDialog({ overflowInfos, allInfos, attempt = 0 }) {
  if (!moduleRemovalOverlay || !moduleRemovalDialog || !moduleRemovalList || !moduleRemovalConfirm) {
    return Promise.resolve(null);
  }

  populateModuleRemovalDialog(overflowInfos, allInfos, attempt);

  return new Promise((resolve) => {
    moduleRemovalResolver = resolve;
    moduleRemovalFocusedBeforeOpen = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    moduleRemovalOverlay.classList.add('modal--open');
    moduleRemovalOverlay.setAttribute('aria-hidden', 'false');

    if (typeof moduleRemovalDialog.focus === 'function') {
      moduleRemovalDialog.focus({ preventScroll: true });
    }

    const firstRadio = moduleRemovalList.querySelector('input[type="radio"]');
    if (firstRadio && typeof firstRadio.focus === 'function') {
      firstRadio.focus({ preventScroll: true });
    }

    moduleRemovalKeyHandler = (event) => {
      if (!moduleRemovalOverlay.classList.contains('modal--open')) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModuleRemovalDialog(null);
        return;
      }
      if (event.key === 'Tab' && moduleRemovalDialog) {
        const focusable = Array.from(
          moduleRemovalDialog.querySelectorAll(moduleRemovalFocusSelectors),
        ).filter((el) => el instanceof HTMLElement && !el.hasAttribute('disabled'));
        if (!focusable.length) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === first || !moduleRemovalDialog.contains(active)) {
            last.focus();
            event.preventDefault();
          }
        } else if (active === last) {
          first.focus();
          event.preventDefault();
        }
      }
    };

    document.addEventListener('keydown', moduleRemovalKeyHandler, true);
  });
}

async function optimizeLayout(options = null) {
  const defaults = { silent: false, skipSimulation: false, reason: 'manual' };
  const resolved = typeof options === 'object' && options !== null
    ? { ...defaults, ...options }
    : typeof options === 'boolean'
      ? { ...defaults, silent: options }
      : defaults;

  const { silent, skipSimulation } = resolved;

  if (isOptimizing) {
    return { statusMessage: 'Optimization already in progress.', statusTone: 'info', overlaps: [], removed: [] };
  }

  if (!modules.length) {
    if (!silent) {
      pushStatus('Add modules before running the optimizer.', { tone: 'warning', timeout: 4200 });
    }
    return { statusMessage: 'No modules to optimize.', statusTone: 'warning', overlaps: [], removed: [] };
  }

  const footprint = getHabitatFootprint();
  if (
    !Number.isFinite(footprint.width)
    || !Number.isFinite(footprint.depth)
    || footprint.width <= 0
    || footprint.depth <= 0
  ) {
    if (!silent) {
      pushStatus('Cannot determine habitat footprint. Adjust habitat parameters first.', { tone: 'warning', timeout: 5200 });
    }
    return { statusMessage: 'Invalid habitat footprint.', statusTone: 'warning', overlaps: [], removed: [] };
  }

  await ensureRequirementCatalog();

  const moduleInfos = buildModuleInfoList(modules);
  if (!moduleInfos.length) {
    if (!silent) {
      pushStatus('No modules available for optimization.', { tone: 'warning', timeout: 4200 });
    }
    return { statusMessage: 'No modules available for optimization.', statusTone: 'warning', overlaps: [], removed: [] };
  }

  isOptimizing = true;

  try {
    const originalModules = modules.map((mod) => ({ ...mod }));
    const infoLookup = new Map(moduleInfos.map((info) => [info.id, info]));
    const removedMap = new Map();
    let workingInfos = moduleInfos.slice();
    let attemptIndex = 0;
    let layoutResult = evaluateLayoutStrategies(workingInfos, footprint) || {
      placements: new Map(),
      overflow: workingInfos.slice(),
      meta: {},
    };

    if (
      layoutResult.overflow.length
      && (!moduleRemovalOverlay || !moduleRemovalDialog || !moduleRemovalList || !moduleRemovalConfirm || !moduleRemovalRemoveAll)
    ) {
      const statusMessage = 'Layout exceeds habitat capacity and manual removal is unavailable.';
      if (!silent) {
        pushStatus(statusMessage, { tone: 'danger', timeout: 6800 });
      }
      return { statusMessage, statusTone: 'danger', overlaps: [], removed: [], criticalRemoved: [] };
    }

    while (layoutResult.overflow.length && workingInfos.length) {
      const selectionId = await showModuleRemovalDialog({
        overflowInfos: layoutResult.overflow,
        allInfos: workingInfos,
        attempt: attemptIndex,
      });

      if (!selectionId) {
        modules = originalModules.map((mod) => ({ ...mod }));
        renderTable();
        renderMap();
        const overlaps = findOverlaps(modules);
        const statusMessage = 'Optimization canceled. Layout left unchanged.';
        if (!silent) {
          pushStatus(statusMessage, { tone: 'info', timeout: 5200 });
        }
        return {
          statusMessage,
          statusTone: 'info',
          overlaps,
          removed: [],
          criticalRemoved: [],
        };
      }

      if (selectionId === MODULE_REMOVAL_ALL) {
        const overflowDetails = new Map((layoutResult.overflow || []).map((info) => [info.id, info]));
        const reasonsLookup = layoutResult.meta?.overflowReasons || {};
        const overflowIds = new Set(overflowDetails.keys());
        overflowIds.forEach((id) => {
          if (infoLookup.has(id)) {
            const snapshot = { ...infoLookup.get(id) };
            const detail = overflowDetails.get(id);
            const reason = detail?.overflowReason || reasonsLookup[id] || null;
            if (reason) {
              snapshot.overflowReason = reason;
            }
            removedMap.set(id, snapshot);
            infoLookup.delete(id);
          }
        });
        workingInfos = workingInfos.filter((info) => !overflowIds.has(info.id));
        attemptIndex += 1;

        if (!workingInfos.length) {
          layoutResult = { placements: new Map(), overflow: [], meta: {} };
          break;
        }

        layoutResult = evaluateLayoutStrategies(workingInfos, footprint) || {
          placements: new Map(),
          overflow: workingInfos.slice(),
          meta: {},
        };
        continue;
      }

      if (infoLookup.has(selectionId)) {
        const snapshot = { ...infoLookup.get(selectionId) };
        const reasonsLookup = layoutResult.meta?.overflowReasons || {};
        const overflowDetail = (layoutResult.overflow || []).find((info) => info.id === selectionId);
        const reason = overflowDetail?.overflowReason || reasonsLookup[selectionId] || null;
        if (reason) {
          snapshot.overflowReason = reason;
        }
        removedMap.set(selectionId, snapshot);
        infoLookup.delete(selectionId);
      }

      workingInfos = workingInfos.filter((info) => info.id !== selectionId);
      attemptIndex += 1;

      if (!workingInfos.length) {
        layoutResult = { placements: new Map(), overflow: [], meta: {} };
        break;
      }

      layoutResult = evaluateLayoutStrategies(workingInfos, footprint) || {
        placements: new Map(),
        overflow: workingInfos.slice(),
        meta: {},
      };
    }

    if (layoutResult.overflow.length) {
      modules = originalModules.map((mod) => ({ ...mod }));
      renderTable();
      renderMap();
      const overlaps = findOverlaps(modules);
      const outstandingReasons = Array.from(new Set(Object.values(layoutResult.meta?.overflowReasons || {})))
        .filter(Boolean);
      let statusMessage = 'Optimization failed. Insufficient habitat space even after removals.';
      const reasonDescriptions = outstandingReasons
        .map((code) => describeOverflowReason(code))
        .filter((text) => text && text !== 'Does not fit');
      if (reasonDescriptions.length) {
        statusMessage += ` Constraints preventing placement: ${reasonDescriptions.join('; ')}.`;
      }
      if (!silent) {
        pushStatus(statusMessage, { tone: 'danger', timeout: 6800 });
      }
      return {
        statusMessage,
        statusTone: 'danger',
        overlaps,
        removed: [],
        criticalRemoved: [],
      };
    }

    const keptIds = new Set(workingInfos.map((info) => info.id));
    const placementMap = layoutResult.placements || new Map();

    modules = originalModules.filter((mod) => keptIds.has(mod.id));
    modules = modules.map((mod) => {
      const placement = placementMap.get(mod.id);
      if (!placement) {
        return clampModuleToHabitat({ ...mod });
      }
      return clampModuleToHabitat({
        ...mod,
        x: placement.x,
        y: placement.y,
        z: placement.z,
        w: placement.w,
        d: placement.d,
        h: placement.h,
      });
    });

    await saveLayout();
    renderTable();
    renderMap();

    const overlaps = findOverlaps(modules);
    const removedList = Array.from(removedMap.values());
    const criticalRemoved = removedList.filter((info) => {
      const fc = Number.isFinite(info.functionCriticality) ? info.functionCriticality : null;
      const tc = Number.isFinite(info.typeCriticality) ? info.typeCriticality : null;
      return (fc !== null && fc >= 1) || (fc === null && tc === 1);
    });

    const messages = [];
    let statusTone = 'success';

    if (overlaps.length) {
      const pairs = overlaps.map(([a, b]) => `${a} <-> ${b}`);
      messages.push(`Overlapping modules detected: ${pairs.join(', ')}`);
      statusTone = 'warning';
    }
    if (removedList.length) {
      const removedText = removedList
        .map((info) => {
          const role = info.module.function || info.module.type || info.type || 'module';
          const reasonText = describeOverflowReason(info.overflowReason);
          return reasonText && reasonText !== 'Does not fit'
            ? `${info.id} (${role}, ${reasonText})`
            : `${info.id} (${role})`;
        })
        .join(', ');
      messages.push(`Removed modules per user selection: ${removedText}`);
      statusTone = 'warning';
    }
    if (criticalRemoved.length) {
      const criticalText = criticalRemoved
        .map((info) => `${info.id} (${info.module.function || info.module.type || 'module'})`)
        .join(', ');
      messages.push(`Critical modules removed: ${criticalText}`);
      statusTone = 'danger';
    }

    let statusMessage = removedList.length
      ? 'Layout optimized after removing user-selected modules.'
      : 'Layout optimized by re-evaluating empty space.';
    if (messages.length) {
      statusMessage = messages.join(' | ');
    }

    if (!skipSimulation) {
      await simulate({ skipSave: true, quiet: silent && statusTone === 'success' });
    }

    if (!silent) {
      pushStatus(statusMessage, { tone: statusTone, timeout: statusTone === 'success' ? 3200 : 6800 });
    }

    return {
      statusMessage,
      statusTone,
      overlaps,
      removed: removedList,
      criticalRemoved,
    };
  } finally {
    isOptimizing = false;
  }
}

async function simulate(options = undefined) {
  const resolved = typeof options === 'object' && options !== null
    ? { skipSave: Boolean(options.skipSave), quiet: Boolean(options.quiet) }
    : { skipSave: Boolean(options === true), quiet: false };

  if (!resolved.skipSave) {
    await saveLayout();
  }
  try {
    const res = await fetch('/simulate');
    if (!res.ok) {
      throw new Error(`Simulate failed (${res.status})`);
    }
    const data = await res.json();
    updateMetricsView(data.metrics, data.requirements);
    document.getElementById('snapshot').src = `/snapshot?nocache=${Date.now()}`;
    if (!resolved.quiet) {
      pushStatus('Simulation refreshed with the latest metrics.', { tone: 'success', timeout: 3600 });
    }
  } catch (err) {
    console.error('Simulation failed', err);
    if (!resolved.quiet) {
      pushStatus('Simulation failed. Check the console for details.', { tone: 'danger', timeout: 6000 });
    }
    throw err;
  }
}

if (moduleRemovalList) {
  moduleRemovalList.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || target.name !== 'moduleRemovalChoice') {
      return;
    }
    moduleRemovalSelectedId = target.value || null;
    const options = moduleRemovalList.querySelectorAll('.modal__option');
    options.forEach((item) => {
      item.classList.remove('modal__option--selected');
    });
    const optionItem = target.closest('.modal__option');
    if (optionItem) {
      optionItem.classList.add('modal__option--selected');
    }
    if (moduleRemovalConfirm) {
      moduleRemovalConfirm.disabled = !moduleRemovalSelectedId;
    }
  });
}

if (moduleRemovalConfirm) {
  moduleRemovalConfirm.addEventListener('click', () => {
    if (!moduleRemovalSelectedId) {
      return;
    }
    closeModuleRemovalDialog(moduleRemovalSelectedId);
  });
}

if (moduleRemovalCancel) {
  moduleRemovalCancel.addEventListener('click', () => {
    closeModuleRemovalDialog(null);
  });
}

if (moduleRemovalBackdrop) {
  moduleRemovalBackdrop.addEventListener('click', () => {
    closeModuleRemovalDialog(null);
  });
}

if (moduleRemovalRemoveAll) {
  moduleRemovalRemoveAll.addEventListener('click', () => {
    if (moduleRemovalRemoveAll.disabled) {
      return;
    }
    closeModuleRemovalDialog(MODULE_REMOVAL_ALL);
  });
}

const habitatForm = document.getElementById('habitatForm');
if (habitatForm) {
  habitatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const shapeSelect = document.getElementById('habitatShape');
    if (!shapeSelect) {
      return;
    }
    const type = shapeSelect.value;
    const fields = SHAPE_FIELDS[type] || SHAPE_FIELDS.cylinder;
    const updated = { type };
    fields.forEach(({ key }) => {
      const input = document.getElementById(habitatFieldId(key));
      const defaults = DEFAULTS_BY_SHAPE[type] || DEFAULTS_BY_SHAPE.cylinder;
      updated[key] = numberOr(input?.value, defaults[key]);
    });
    habitat = updated;
    cacheHabitatDimensions(updated);
    modules = modules.map((mod) => clampModuleToHabitat(mod));
    updateShapeFields(type);
    await saveLayout();
    renderTable();
    renderMap();
    pushStatus('Habitat shell updated. Modules will be re-optimized automatically.', { tone: 'info', timeout: 4800 });
    scheduleAutoAnalysis('habitat-updated');
  });
}

const shapeSelect = document.getElementById('habitatShape');
if (shapeSelect) {
  shapeSelect.addEventListener('change', (event) => {
    const type = event.target.value;
    const cached = habitatCache[type] || DEFAULTS_BY_SHAPE[type] || DEFAULTS_BY_SHAPE.cylinder;
    habitat = { type, ...cached };
    updateShapeFields(type);
  });
}

if (crewInput) {
  crewInput.addEventListener('change', async (event) => {
    const nextValue = Number.parseInt(event.target.value, 10);
    if (Number.isFinite(nextValue)) {
      crewSize = Math.min(Math.max(nextValue, 2), 12);
    }
    updateCrewControls();
    await saveLayout();
    pushStatus('Crew size updated. Auto-analysis queued.', { tone: 'info', timeout: 3600 });
    scheduleAutoAnalysis('crew-updated');
  });
}

if (missionPromptInput) {
  missionPromptInput.addEventListener('input', (event) => {
    missionPromptText = event.target.value;
    if (saveLayoutTimer) {
      clearTimeout(saveLayoutTimer);
    }
    saveLayoutTimer = setTimeout(() => {
      saveLayout().then(() => {
        pushStatus('Mission priorities updated. Auto-analysis queued.', { tone: 'info', timeout: 3600 });
        scheduleAutoAnalysis('mission-prompt');
      });
    }, 400);
  });
}

function queueCriticalModuleStaging(delay = 250) {
  if (stageCriticalTimer) {
    clearTimeout(stageCriticalTimer);
  }
  stageCriticalTimer = setTimeout(() => {
    stageCriticalTimer = null;
    stageCriticalModuleTemplates().catch((err) => {
      console.error('Failed to stage critical module templates', err);
    });
  }, Math.max(0, delay));
}

async function stageCriticalModuleTemplates({ silent = false } = {}) {
  if (stageCriticalPromise) {
    return stageCriticalPromise;
  }

  const payload = {
    layout: { habitat, modules, render_style: renderStyle },
    crew: crewSize,
    mission_prompt: missionPromptText,
    library_only: true,
  };

  stageCriticalPromise = (async () => {
    try {
      if (enforceRequirementsBtn) {
        enforceRequirementsBtn.disabled = true;
      }
      const res = await fetch('/requirements/enforce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`Critical staging failed (${res.status})`);
      }
      const data = await res.json();
      const templates = Array.isArray(data.library_templates)
        ? data.library_templates
        : Array.isArray(data.layout?.requirements_report?.library_templates)
          ? data.layout.requirements_report.library_templates
          : [];
      const added = mergeLibraryEntries(templates);
      if (data.requirements) {
        currentRequirements = data.requirements;
        updateMetricsView(currentMetrics, currentRequirements);
      }
      renderTable();
      renderMap();
      if (added.length && !silent) {
        const labels = added.map((entry) => entry.label || entry.function || entry.asset);
        console.info(`Critical modules staged in the library: ${labels.join(', ')}`);
      }
      return added;
    } catch (err) {
      console.error('Failed to fetch requirement templates', err);
      throw err;
    } finally {
      stageCriticalPromise = null;
      if (enforceRequirementsBtn) {
        enforceRequirementsBtn.disabled = false;
      }
    }
  })();

  return stageCriticalPromise;
}

async function loadRequirementLibrary() {
  try {
    const res = await fetch('/requirements/library');
    if (!res.ok) {
      throw new Error(`Requirement library request failed (${res.status})`);
    }
    const data = await res.json();
    const entries = Array.isArray(data.modules) ? data.modules : [];
    let updated = false;
    entries.forEach((entry) => {
      if (!entry || !entry.asset) {
        return;
      }
      if (!moduleLibraryMap.has(entry.asset)) {
        moduleLibrary.push(entry);
        updated = true;
      }
    });
    if (updated) {
      moduleLibrary.sort((a, b) => {
        const typeA = String(a.type || '').toLowerCase();
        const typeB = String(b.type || '').toLowerCase();
        if (typeA !== typeB) {
          return typeA.localeCompare(typeB);
        }
        return String(a.label || '').toLowerCase().localeCompare(String(b.label || '').toLowerCase());
      });
      refreshLibraryCache();
      renderLibrary();
      populateAssetPreset();
    }
  } catch (err) {
    console.error('Failed to load requirements module library', err);
  }
}

async function ensureCriticalModules() {
  if (enforceRequirementsBtn) {
    enforceRequirementsBtn.disabled = true;
  }
  try {
    const res = await fetch('/requirements/enforce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layout: { habitat, modules, render_style: renderStyle },
        crew: crewSize,
        mission_prompt: missionPromptText,
        library_only: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`Ensure critical failed (${res.status})`);
    }
    const data = await res.json();
    if (data.layout) {
      const ensuredHabitat = ensureHabitatDefaults(data.layout.habitat || habitat);
      habitat = ensuredHabitat;
      cacheHabitatDimensions(habitat);
      modules = Array.isArray(data.layout.modules)
        ? data.layout.modules.map(normalizeModule).map((mod) => clampModuleToHabitat(mod, habitat))
        : modules;
      if (data.layout.render_style) {
        renderStyle = String(data.layout.render_style).toLowerCase();
      }
      crewSize = Number.parseInt(data.layout.crew ?? crewSize, 10) || crewSize;
      missionPromptText = String(data.layout.mission_prompt ?? missionPromptText);
      updateRenderStyleControl();
      updateCrewControls();
      renderHabitatForm();
      renderLibrary();
    }
    renderTable();
    renderMap();
    updateMetricsView(currentMetrics, data.requirements);
    currentRequirements = data.requirements || currentRequirements;

    const templates = Array.isArray(data.library_templates)
      ? data.library_templates
      : Array.isArray(data.layout?.requirements_report?.library_templates)
        ? data.layout.requirements_report.library_templates
        : [];
    mergeLibraryEntries(templates);
    pushStatus('Critical coverage enforced. Auto optimization queued.', { tone: 'success', timeout: 4800 });
    scheduleAutoAnalysis('requirements-enforced');
  } catch (err) {
    console.error('Failed to ensure critical modules', err);
    pushStatus('Failed to enforce critical modules. Check the console for details.', { tone: 'danger', timeout: 6000 });
  } finally {
    if (enforceRequirementsBtn) {
      enforceRequirementsBtn.disabled = false;
    }
  }
}

const assetPresetSelect = document.getElementById('assetPreset');
const moduleLibrarySearchInput = document.getElementById('moduleLibrarySearch');
if (moduleLibrarySearchInput) {
  moduleLibrarySearchInput.addEventListener('input', (event) => {
    moduleLibraryQuery = String(event.target.value || '');
    renderLibrary();
  });
}

if (enforceRequirementsBtn) {
  enforceRequirementsBtn.addEventListener('click', () => {
    ensureCriticalModules();
  });
}

function populateAssetPreset() {
  if (!assetPresetSelect) {
    return;
  }
  const previous = assetPresetSelect.value;
  assetPresetSelect.innerHTML = '';
  const baseOption = document.createElement('option');
  baseOption.value = '';
  baseOption.textContent = 'Basic shape';
  assetPresetSelect.appendChild(baseOption);
  const fragment = document.createDocumentFragment();
  moduleLibrary.forEach((entry) => {
    const option = document.createElement('option');
    option.value = entry.asset;
    option.textContent = entry.label;
    fragment.appendChild(option);
  });
  assetPresetSelect.appendChild(fragment);
  if (previous && moduleLibraryMap.has(previous)) {
    assetPresetSelect.value = previous;
  }
}

if (assetPresetSelect) {
  populateAssetPreset();

  assetPresetSelect.addEventListener('change', (event) => {
    const key = event.target.value;
    if (!key) {
      return;
    }
    const template = moduleLibraryMap.get(key) || moduleLibrary.find((entry) => entry.asset === key);
    if (!template) {
      return;
    }

    const dims = template.size || {};
    const width = numberOr(dims.w ?? dims.width ?? dims.size, 1.6);
    const depth = numberOr(dims.d ?? dims.depth ?? dims.size, 1.2);
    const height = numberOr(dims.h ?? dims.height ?? dims.size, 1.6);
    const defaultZ = numberOr(template.defaultZ, height / 2);

    const typeField = document.getElementById('type');
    if (typeField) {
      typeField.value = template.type || 'generic';
    }
    const shapeField = document.getElementById('shape');
    if (shapeField) {
      shapeField.value = template.shape || 'box';
    }
    const widthField = document.getElementById('w');
    if (widthField) {
      widthField.value = width;
    }
    const depthField = document.getElementById('d');
    if (depthField) {
      depthField.value = depth;
    }
    const heightField = document.getElementById('h');
    if (heightField) {
      heightField.value = height;
    }
    const zField = document.getElementById('z');
    if (zField) {
      zField.value = defaultZ.toFixed(2);
    }
    const colorField = document.getElementById('color');
    if (colorField && template.color) {
      colorField.value = template.color;
    }
  });
}

const renderStyleSelect = document.getElementById('renderStyle');
if (renderStyleSelect) {
  renderStyleSelect.addEventListener('change', async (event) => {
    renderStyle = String(event.target.value || 'realistic').toLowerCase();
    updateRenderStyleControl();
    try {
      await simulate();
    } catch (err) {
      console.error('Simulation after style change failed', err);
    }
  });
}

const simulateButton = document.getElementById('simulateBtn');
if (simulateButton) {
  simulateButton.addEventListener('click', () => {
    void simulate().catch((err) => {
      console.error('Manual simulation failed', err);
    });
  });
}

const optimizeButton = document.getElementById('optimizeLayoutBtn');
if (optimizeButton) {
  optimizeButton.addEventListener('click', () => {
    void optimizeLayout().catch((err) => {
      console.error('Manual optimization failed', err);
      pushStatus('Optimization failed. Check the console for details.', { tone: 'danger', timeout: 6000 });
    });
  });
}

const moduleForm = document.getElementById('moduleForm');
const moduleSubmitButton = moduleForm ? moduleForm.querySelector('button[type="submit"]') : null;
if (moduleForm) {
  moduleForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const idInput = document.getElementById('id');
    const rawId = idInput ? idInput.value.trim() : '';
    if (!rawId) {
      if (idInput) {
        idInput.focus();
      }
      return;
    }

    const assetValue = assetPresetSelect ? assetPresetSelect.value : '';
    const payload = {
      id: rawId,
      type: document.getElementById('type').value,
      shape: document.getElementById('shape').value,
      x: document.getElementById('x').value,
      y: document.getElementById('y').value,
      z: document.getElementById('z').value,
      w: document.getElementById('w').value || 1,
      h: document.getElementById('h').value || 1,
      d: document.getElementById('d').value || 1,
      color: document.getElementById('color').value,
    };

    const normalized = normalizeModule(payload);
    if (assetValue) {
      normalized.asset = assetValue;
    } else {
      delete normalized.asset;
    }

    const isEditing = Boolean(editingModuleId);
    let resultingId = normalized.id;

    if (editingModuleId) {
      const targetIndex = modules.findIndex((mod) => mod.id === editingModuleId);
      if (targetIndex !== -1) {
        const finalId = normalized.id === editingModuleId
          ? normalized.id
          : ensureUniqueModuleId(normalized.id, editingModuleId);
        const updated = { ...normalized, id: finalId };
        const clamped = clampModuleToHabitat(updated);
        modules[targetIndex] = clamped;
        resultingId = clamped.id;
      } else {
        const finalId = ensureUniqueModuleId(normalized.id, null);
        const clamped = clampModuleToHabitat({ ...normalized, id: finalId });
        modules.push(clamped);
        resultingId = clamped.id;
      }
    } else {
      const finalId = modules.some((mod) => mod.id === normalized.id)
        ? ensureUniqueModuleId(normalized.id, null)
        : normalized.id;
      const clamped = clampModuleToHabitat({ ...normalized, id: finalId });
      modules.push(clamped);
      resultingId = clamped.id;
    }

    await saveLayout();
    renderTable();
    renderMap();
    moduleForm.reset();
    if (assetPresetSelect) {
      assetPresetSelect.value = '';
    }
    resetModuleFormState();
    pushStatus(`Module ${resultingId} ${isEditing ? 'updated' : 'added'} successfully.`, { tone: 'success', timeout: 3200 });
    scheduleAutoAnalysis(isEditing ? 'module-updated' : 'module-added');
  });

  resetModuleFormState();
}

const moduleTable = document.getElementById('moduleTable');
if (moduleTable) {
  moduleTable.addEventListener('click', (event) => {
    const button = event.target.closest('.modules-table__btn');
    if (!button) {
      return;
    }
    const action = button.dataset.action;
    const moduleId = button.dataset.moduleId;
    if (!moduleId) {
      return;
    }
    if (action === 'edit') {
      const module = modules.find((mod) => mod.id === moduleId);
      if (module) {
        populateModuleForm(module);
      }
    } else if (action === 'duplicate') {
      void duplicateModuleById(moduleId);
    } else if (action === 'delete') {
      void deleteModuleById(moduleId);
    }
  });
}

const aiForm = document.getElementById('aiForm');
if (aiForm) {
  aiForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const prompt = document.getElementById('aiPrompt').value;
    try {
      const res = await fetch('/ai_modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        throw new Error(`AI request failed (${res.status})`);
      }
      const data = await res.json();
      const generated = Array.isArray(data.modules)
        ? data.modules.map((mod) => clampModuleToHabitat(normalizeModule(mod)))
        : [];
      if (!generated.length) {
        console.warn('AI generator returned no modules.');
        return;
      }

      const merged = modules.concat(generated);
      const seen = new Set();
      modules = merged.map((mod) => {
        const baseId = String(mod.id || '').trim() || generateModuleId(mod.type || 'module');
        let candidate = baseId;
        let suffix = 2;
        while (seen.has(candidate)) {
          candidate = `${baseId}-${suffix}`;
          suffix += 1;
        }
        seen.add(candidate);
        return { ...mod, id: candidate };
      });

      modules = modules.map((mod) => clampModuleToHabitat(mod));
      await saveLayout();
      renderTable();
      renderMap();
      pushStatus(`${generated.length} AI-generated module${generated.length === 1 ? '' : 's'} added.`, { tone: 'success', timeout: 5000 });
      scheduleAutoAnalysis('ai-generated');
    } catch (err) {
      console.error('Failed to generate modules', err);
      pushStatus('AI module generation failed. Check the console for details.', { tone: 'danger', timeout: 6000 });
    }
  });
}

loadRequirementLibrary();
loadLayout()
  .then(() => stageCriticalModuleTemplates({ silent: true }))
  .catch((err) => {
    console.error('Failed to initialize layout or stage critical templates', err);
  });

// Expose simulate globally for the inline button handler
window.simulate = simulate;

const tabButtons = Array.from(document.querySelectorAll('.card-tabs__tab'));
if (tabButtons.length) {
  const panels = new Map();
  tabButtons.forEach((button) => {
    const targetId = button.getAttribute('data-tab-target');
    if (targetId) {
      const panel = document.getElementById(targetId);
      if (panel) {
        panels.set(button, panel);
      }
    }
  });

  const setActiveButton = (activeButton) => {
    tabButtons.forEach((button) => {
      const panel = panels.get(button);
      const isActive = button === activeButton;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
      if (panel) {
        panel.classList.toggle('is-active', isActive);
      }
    });
  };

  activateTabById = (targetId) => {
    const button = tabButtons.find((btn) => btn.getAttribute('data-tab-target') === targetId);
    if (button) {
      setActiveButton(button);
    }
  };

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setActiveButton(button);
    });
  });
}

const aiWidgetToggle = document.getElementById('aiWidgetToggle');
const aiWidgetPanel = document.getElementById('aiWidgetPanel');
const aiWidgetClose = document.getElementById('aiWidgetClose');

function setAiWidgetOpen(open) {
  if (!aiWidgetToggle || !aiWidgetPanel) {
    return;
  }
  const isOpen = Boolean(open);
  aiWidgetPanel.classList.toggle('is-open', isOpen);
  aiWidgetPanel.setAttribute('aria-hidden', String(!isOpen));
  aiWidgetToggle.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) {
    requestAnimationFrame(() => {
      const promptField = document.getElementById('aiPrompt');
      if (promptField) {
        promptField.focus({ preventScroll: true });
      }
    });
  }
}

if (aiWidgetToggle && aiWidgetPanel) {
  aiWidgetToggle.addEventListener('click', () => {
    const open = !aiWidgetPanel.classList.contains('is-open');
    setAiWidgetOpen(open);
  });
}

if (aiWidgetClose) {
  aiWidgetClose.addEventListener('click', () => {
    setAiWidgetOpen(false);
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && aiWidgetPanel && aiWidgetPanel.classList.contains('is-open')) {
    setAiWidgetOpen(false);
  }
});
