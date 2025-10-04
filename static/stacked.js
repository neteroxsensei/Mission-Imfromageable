const DEFAULTS_BY_SHAPE = {
  cylinder: { radius: 4, length: 14 },
  sphere: { radius: 6 },
  cube: { width: 10, depth: 10, height: 10 },
};

const levelsContainer = document.getElementById('levels');
const summaryEls = {
  shape: document.getElementById('hab-shape'),
  height: document.getElementById('hab-height'),
  footprint: document.getElementById('hab-footprint'),
  modules: document.getElementById('hab-modules'),
};

function numberOr(value, fallback) {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
}

function formatMeters(value, decimals = 1) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const fixed = value.toFixed(decimals);
  return `${fixed.replace(/\.0+$/, '').replace(/(\.[1-9]*)0+$/, '$1')} m`;
}

function ensureHabitatDefaults(raw = {}) {
  const type = String(raw.type || 'cylinder').toLowerCase();
  const defaults = DEFAULTS_BY_SHAPE[type] || DEFAULTS_BY_SHAPE.cylinder;
  const sanitized = { type };
  Object.keys(defaults).forEach((key) => {
    sanitized[key] = numberOr(raw[key], defaults[key]);
  });
  return sanitized;
}

function normalizeModule(mod = {}) {
  const width = Math.abs(numberOr(mod.w ?? mod.size, 1));
  const depth = Math.abs(numberOr(mod.d ?? mod.size, 1));
  const height = Math.abs(numberOr(mod.h ?? mod.size, 1));
  return {
    id: String(mod.id || '').trim() || `module-${Date.now()}`,
    type: String(mod.type || 'generic'),
    shape: String(mod.shape || 'box'),
    x: numberOr(mod.x, 0),
    y: numberOr(mod.y, 0),
    z: numberOr(mod.z, 0),
    w: width,
    d: depth,
    h: height,
    color: mod.color || '#ffffff',
  };
}

function describeHabitat(habitat) {
  const type = habitat.type;
  if (type === 'sphere') {
    const radius = numberOr(habitat.radius, DEFAULTS_BY_SHAPE.sphere.radius);
    const diameter = radius * 2;
    return {
      label: `Sphere · radius ${formatMeters(radius)}`,
      width: diameter,
      depth: diameter,
      height: diameter,
    };
  }
  if (type === 'cube') {
    const width = numberOr(habitat.width, DEFAULTS_BY_SHAPE.cube.width);
    const depth = numberOr(habitat.depth, DEFAULTS_BY_SHAPE.cube.depth);
    const height = numberOr(habitat.height, DEFAULTS_BY_SHAPE.cube.height);
    return {
      label: `Cube · ${formatMeters(width)} × ${formatMeters(depth)} × ${formatMeters(height)}`,
      width,
      depth,
      height,
    };
  }
  const radius = numberOr(habitat.radius, DEFAULTS_BY_SHAPE.cylinder.radius);
  const length = numberOr(habitat.length, DEFAULTS_BY_SHAPE.cylinder.length);
  const diameter = radius * 2;
  return {
    label: `Cylinder · radius ${formatMeters(radius)}, length ${formatMeters(length)}`,
    width: diameter,
    depth: length,
    height: diameter,
  };
}

function groupModulesByLevel(modules) {
  if (!modules.length) {
    return [];
  }
  const enriched = modules
    .map((module) => {
      const halfHeight = module.h * 0.5;
      const top = module.z + halfHeight;
      const bottom = module.z - halfHeight;
      return {
        ...module,
        top,
        bottom,
        center: module.z,
      };
    })
    .sort((a, b) => b.top - a.top);

  const gap = 0.6;
  const levels = [];

  enriched.forEach((module) => {
    let target = null;
    for (const level of levels) {
      const separated = module.bottom > level.top + gap || module.top < level.bottom - gap;
      if (!separated) {
        target = level;
        break;
      }
    }

    if (!target) {
      target = {
        modules: [],
        top: module.top,
        bottom: module.bottom,
      };
      levels.push(target);
    }

    target.modules.push(module);
    target.top = Math.max(target.top, module.top);
    target.bottom = Math.min(target.bottom, module.bottom);
  });

  levels.forEach((level) => {
    level.height = Math.max(level.top - level.bottom, 0);
    level.center = (level.top + level.bottom) / 2;
    level.modules.sort((a, b) => a.x - b.x);
  });

  return levels;
}

function updateSummary(habitat, modules) {
  const info = describeHabitat(habitat);
  if (summaryEls.shape) {
    summaryEls.shape.textContent = info.label;
  }
  if (summaryEls.height) {
    summaryEls.height.textContent = formatMeters(info.height);
  }
  if (summaryEls.footprint) {
    summaryEls.footprint.textContent = `${formatMeters(info.width)} × ${formatMeters(info.depth)}`;
  }
  if (summaryEls.modules) {
    summaryEls.modules.textContent = modules.length.toString();
  }
}

function createModuleCard(module, habitatWidth) {
  const card = document.createElement('article');
  card.className = 'module-card';

  const head = document.createElement('div');
  head.className = 'module-head';
  const idSpan = document.createElement('span');
  idSpan.className = 'module-id';
  idSpan.textContent = module.id;
  const typeSpan = document.createElement('span');
  typeSpan.className = 'module-type';
  typeSpan.textContent = module.type;
  head.append(idSpan, typeSpan);

  const bar = document.createElement('div');
  bar.className = 'module-bar';
  const barFill = document.createElement('span');
  const widthRatio = habitatWidth > 0 ? Math.max(0.1, Math.min(1, module.w / habitatWidth)) : 0.5;
  barFill.style.width = `${widthRatio * 100}%`;
  barFill.style.background = `linear-gradient(90deg, rgba(247, 199, 95, 0.95), rgba(199, 138, 28, 0.95))`;
  bar.append(barFill);

  const specs = document.createElement('div');
  specs.className = 'module-specs';

  const sizeRow = document.createElement('span');
  sizeRow.innerHTML = `<strong>Size</strong><span>${formatMeters(module.w)} × ${formatMeters(module.d)} × ${formatMeters(module.h)}</span>`;

  const centerRow = document.createElement('span');
  centerRow.innerHTML = `<strong>Center</strong><span>${formatMeters(module.x)}, ${formatMeters(module.y)}, ${formatMeters(module.z)}</span>`;

  const spanRow = document.createElement('span');
  spanRow.innerHTML = `<strong>Vertical</strong><span>${formatMeters(module.bottom)} → ${formatMeters(module.top)}</span>`;

  specs.append(sizeRow, centerRow, spanRow);

  card.append(head, bar, specs);
  return card;
}

function renderLevels(levels, habitat) {
  levelsContainer.innerHTML = '';
  if (!levels.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<h3>No Modules</h3><p>Add modules in the layout designer to populate this view.</p>';
    levelsContainer.append(empty);
    return;
  }

  const info = describeHabitat(habitat);

  levels.forEach((level, idx) => {
    const section = document.createElement('article');
    section.className = 'level';
    section.dataset.label = `LEVEL ${levels.length - idx}`;

    const header = document.createElement('div');
    header.className = 'level-header';

    const title = document.createElement('h3');
    title.className = 'level-title';
    title.textContent = `Level ${levels.length - idx}`;

    const meta = document.createElement('div');
    meta.className = 'level-meta';
    meta.textContent = `Span ${formatMeters(level.height)} · Elevation ${formatMeters(level.bottom)} to ${formatMeters(level.top)} · ${level.modules.length} modules`;

    header.append(title, meta);

    const grid = document.createElement('div');
    grid.className = 'module-grid';
    level.modules.forEach((module) => {
      grid.append(createModuleCard(module, info.width));
    });

    section.append(header, grid);
    levelsContainer.append(section);
  });
}

function renderLoading(message = 'Loading habitat layout…') {
  levelsContainer.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'placeholder';
  box.textContent = message;
  levelsContainer.append(box);
}

async function loadLayout() {
  renderLoading();
  try {
    const response = await fetch('/layout');
    if (!response.ok) {
      throw new Error(`Layout request failed (${response.status})`);
    }
    const data = await response.json();
    const habitat = ensureHabitatDefaults(data.habitat);
    const modules = Array.isArray(data.modules)
      ? data.modules.map(normalizeModule)
      : [];

    updateSummary(habitat, modules);
    const levels = groupModulesByLevel(modules);
    renderLevels(levels, habitat);
  } catch (err) {
    console.error('Failed to load stacked view', err);
    renderLoading('Failed to load layout. Check console for details.');
  }
}

const refreshBtn = document.getElementById('refreshBtn');
if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    loadLayout();
  });
}

window.addEventListener('DOMContentLoaded', () => {
  loadLayout();
});
