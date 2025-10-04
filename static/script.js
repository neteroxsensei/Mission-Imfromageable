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

const STATIC_MODULE_LIBRARY = [
  {
    asset: 'crew_bed',
    label: 'Crew Bed',
    type: 'Private Habitation',
    function: 'Sleep accommodation',
    shape: 'box',
    color: 'green',
    size: { w: 2.2, d: 1.0, h: 1.1 },
    defaultZ: 0.55,
    description: 'Compact sleeping berth with integrated storage and headboard.',
  },
  {
    asset: 'treadmill',
    label: 'Treadmill',
    type: 'Exercise',
    function: 'Aerobic Exercise (treadmill)',
    shape: 'box',
    color: 'purple',
    size: { w: 1.4, d: 2.0, h: 1.6 },
    defaultZ: 0.8,
    description: 'Microgravity tread deck with adjustable console and hand rails.',
  },
  {
    asset: 'workbench',
    label: 'Lab Workbench',
    type: 'Maintenance & Repair',
    function: 'Physical work surface access',
    shape: 'box',
    color: 'orange',
    size: { w: 2.4, d: 1.2, h: 1.6 },
    defaultZ: 0.8,
    description: 'Multi-purpose fabrication bench with tool wall and storage shelf.',
  },
];

let moduleLibrary = [...STATIC_MODULE_LIBRARY];
let assetLabels = {};
const moduleLibraryMap = new Map();

function refreshLibraryCache() {
  assetLabels = {};
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

const crewInput = document.getElementById('crewSize');
const missionPromptInput = document.getElementById('missionPrompt');
const enforceRequirementsBtn = document.getElementById('enforceRequirementsBtn');

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
  return ASSET_LABELS[key] || key;
}

function getHabitatFootprint() {
  const type = (habitat.type || DEFAULT_HABITAT.type).toLowerCase();
  if (type === 'sphere') {
    const radius = numberOr(habitat.radius, DEFAULTS_BY_SHAPE.sphere.radius);
    const diameter = radius * 2;
    return { width: diameter, depth: diameter };
  }
  if (type === 'cube') {
    return {
      width: numberOr(habitat.width, DEFAULTS_BY_SHAPE.cube.width),
      depth: numberOr(habitat.depth, DEFAULTS_BY_SHAPE.cube.depth),
    };
  }
  return {
    width: numberOr(habitat.radius, DEFAULTS_BY_SHAPE.cylinder.radius) * 2,
    depth: numberOr(habitat.length, DEFAULTS_BY_SHAPE.cylinder.length),
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
  } catch (err) {
    console.error('Failed to save layout', err);
  }
}

function renderTable() {
  const tbody = document.querySelector('#moduleTable tbody');
  if (!tbody) {
    return;
  }

  tbody.innerHTML = '';

  if (!modules.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
    td.textContent = 'No modules yet';
    tr.appendChild(td);
    tbody.appendChild(tr);
    renderLibrary();
    return;
  }

  modules.forEach((m) => {
    const tr = document.createElement('tr');
    const visual = m.asset ? assetLabel(m.asset) : '—';
    const functionLabel = m.function || '—';
    const values = [
      m.id,
      m.type,
      functionLabel,
      m.shape,
      visual,
      `(${formatNumber(m.x)}, ${formatNumber(m.y)}, ${formatNumber(m.z)})`,
      `${formatNumber(m.w)}×${formatNumber(m.h)}×${formatNumber(m.d)}`,
      m.color,
    ];
    values.forEach((value) => {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    });

    const actionsTd = document.createElement('td');
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

    actionsTd.appendChild(actionWrap);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  renderLibrary();
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
  if (overlaps) {
    console.warn(`Module "${clamped.id}" overlaps existing geometry; adjust its placement manually.`);
  }
}

function renderLibrary() {
  const container = document.getElementById('moduleLibrary');
  if (!container) {
    return;
  }

  container.innerHTML = '';

  moduleLibrary.forEach((item) => {
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

async function optimizeLayout() {
  if (!modules.length) {
    window.alert('Add modules before optimizing the layout.');
    return;
  }

  const footprint = getHabitatFootprint();
  if (!Number.isFinite(footprint.width) || !Number.isFinite(footprint.depth)) {
    window.alert('Cannot determine habitat footprint.');
    return;
  }

  const sorted = modules.map((mod) => ({ ...mod }));
  sorted.sort((a, b) => {
    const aDims = moduleDimensions(a);
    const bDims = moduleDimensions(b);
    return (bDims.width * bDims.depth) - (aDims.width * aDims.depth);
  });

  const step = computePlacementStep(sorted);
  const minX = -footprint.width / 2;
  const maxX = footprint.width / 2;
  const minY = -footprint.depth / 2;
  const maxY = footprint.depth / 2;

  const placed = [];
  const updatedMap = new Map();
  const unplaced = [];

  sorted.forEach((mod) => {
    const dims = moduleDimensions(mod);
    const halfW = dims.width / 2;
    const halfD = dims.depth / 2;
    let candidate = null;

    for (let y = minY + halfD; y <= maxY - halfD + 1e-6; y += step) {
      let found = false;
      for (let x = minX + halfW; x <= maxX - halfW + 1e-6; x += step) {
        if (!fitsWithinFootprint(mod, x, y, footprint)) {
          continue;
        }
        const overlaps = placed.some((other) => modulesOverlapRect({ ...mod, x, y }, other));
        if (!overlaps) {
          candidate = { ...mod, x, y };
          placed.push({ ...candidate });
          updatedMap.set(mod.id, candidate);
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }

    if (!candidate) {
      unplaced.push(mod.id);
      placed.push({ ...mod });
    }
  });

  modules = modules.map((original) => updatedMap.get(original.id) || original);
  modules = modules.map((mod) => clampModuleToHabitat(mod));
  await saveLayout();
  renderTable();
  renderMap();

  const overlaps = findOverlaps(modules);

  if (unplaced.length || overlaps.length) {
    const messages = [];
    if (unplaced.length) {
      messages.push(`Unable to reposition without overlap: ${unplaced.join(', ')}`);
    }
    if (overlaps.length) {
      const pairs = overlaps.map(([a, b]) => `${a} ↔ ${b}`);
      messages.push(`Overlapping modules detected: ${pairs.join(', ')}`);
    }
    window.alert(`${messages.join('\n')}\nPlease adjust the listed modules manually.`);
  } else {
    window.alert('Layout optimized. All modules placed without overlap.');
  }
}

async function simulate(skipSave = false) {
  if (!skipSave) {
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
  } catch (err) {
    console.error('Simulation failed', err);
  }
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
  });
}

if (missionPromptInput) {
  missionPromptInput.addEventListener('input', (event) => {
    missionPromptText = event.target.value;
    if (saveLayoutTimer) {
      clearTimeout(saveLayoutTimer);
    }
    saveLayoutTimer = setTimeout(() => {
      saveLayout();
    }, 400);
  });
}

async function enforceRequirements() {
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
      }),
    });
    if (!res.ok) {
      throw new Error(`Enforce failed (${res.status})`);
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
    }
    updateRenderStyleControl();
    updateCrewControls();
    renderTable();
    renderMap();
    renderLibrary();
    updateMetricsView(currentMetrics, data.requirements);
    await saveLayout();
    currentRequirements = data.requirements || currentRequirements;
  } catch (err) {
    console.error('Failed to enforce requirements', err);
  } finally {
    if (enforceRequirementsBtn) {
      enforceRequirementsBtn.disabled = false;
    }
  }
}

if (enforceRequirementsBtn) {
  enforceRequirementsBtn.addEventListener('click', () => {
    enforceRequirements();
  });
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

const assetPresetSelect = document.getElementById('assetPreset');
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
    await simulate();
  });
}

const optimizeButton = document.getElementById('optimizeLayoutBtn');
if (optimizeButton) {
  optimizeButton.addEventListener('click', () => {
    optimizeLayout();
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

    if (editingModuleId) {
      const targetIndex = modules.findIndex((mod) => mod.id === editingModuleId);
      if (targetIndex !== -1) {
        const finalId = normalized.id === editingModuleId
          ? normalized.id
          : ensureUniqueModuleId(normalized.id, editingModuleId);
        const updated = { ...normalized, id: finalId };
        const clamped = clampModuleToHabitat(updated);
        modules[targetIndex] = clamped;
      } else {
        const finalId = ensureUniqueModuleId(normalized.id, null);
        const clamped = clampModuleToHabitat({ ...normalized, id: finalId });
        modules.push(clamped);
      }
    } else {
      const finalId = modules.some((mod) => mod.id === normalized.id)
        ? ensureUniqueModuleId(normalized.id, null)
        : normalized.id;
      const clamped = clampModuleToHabitat({ ...normalized, id: finalId });
      modules.push(clamped);
    }

    await saveLayout();
    renderTable();
    renderMap();
    moduleForm.reset();
    if (assetPresetSelect) {
      assetPresetSelect.value = '';
    }
    resetModuleFormState();
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
    } catch (err) {
      console.error('Failed to generate modules', err);
    }
  });
}

loadLayout();

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
