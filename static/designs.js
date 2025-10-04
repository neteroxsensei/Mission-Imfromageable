const designList = document.getElementById('designList');
const template = document.getElementById('designCardTemplate');
const refreshButton = document.getElementById('refreshDesigns');
const autoStatus = document.getElementById('autoDesignStatus');
const autoGenerateBtn = document.getElementById('autoGenerateBtn');
const autoOptimizeBtn = document.getElementById('autoOptimizeBtn');
const autoValidateBtn = document.getElementById('autoValidateBtn');
const autoScoreBtn = document.getElementById('autoScoreBtn');
const autoExportBtn = document.getElementById('autoExportBtn');
const autoLoadDesignerBtn = document.getElementById('autoLoadDesignerBtn');

let autoRawLayout = null;
let autoDesignerLayout = null;
let autoLastConfig = null;

function formatNumber(value, digits = 2) {
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) {
    return '—';
  }
  const fixed = num.toFixed(digits);
  return fixed.replace(/\.0+$/, '').replace(/(\.[1-9]*)0+$/, '$1');
}

function metricRow(label, value, suffix = '') {
  const row = document.createElement('div');
  row.className = 'metric-row';
  const strong = document.createElement('strong');
  strong.textContent = label;
  const span = document.createElement('span');
  span.textContent = suffix ? `${value}${suffix}` : value;
  row.append(strong, span);
  return row;
}

function buildMetrics(metrics = {}) {
  const box = document.createElement('div');
  box.className = 'design-metrics';

  if (!metrics || typeof metrics !== 'object') {
    box.append(metricRow('Status', 'Metrics unavailable'));
    return box;
  }

  const moduleFit = metrics.module_fit || {};
  const fitText = moduleFit.ok ? 'All modules contained' : `${moduleFit.issue_count || 0} issues`;

  box.append(
    metricRow('NHV / Vol', formatNumber(metrics.space_usage_ratio), ''),
    metricRow('Hab Vol', `${formatNumber(metrics.habitat_volume_m3)} m³`),
    metricRow('Crew Capacity', metrics.crew_capacity ?? '—'),
    metricRow('Power Usage', `${formatNumber(metrics.power_usage_kW)} kW`),
    metricRow('Module Fit', fitText),
  );

  return box;
}

async function applyLayout(layout, redirect = null, statusEl = null) {
  if (!layout) {
    if (statusEl) {
      statusEl.textContent = 'No layout data available for this design.';
      statusEl.className = 'card-status error';
    }
    return;
  }
  try {
    const res = await fetch('/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    });
    if (!res.ok) {
      throw new Error(`Apply failed (${res.status})`);
    }
    if (statusEl) {
      statusEl.textContent = 'Layout loaded into Designer.';
      statusEl.className = 'card-status success';
    }
    if (redirect) {
      window.location.href = redirect;
    }
  } catch (err) {
    console.error('Failed to apply design', err);
    if (statusEl) {
      statusEl.textContent = 'Failed to apply layout. Check console for details.';
      statusEl.className = 'card-status error';
    }
  }
}

function renderDesigns(designs = []) {
  designList.innerHTML = '';
  if (!designs.length) {
    const placeholder = document.createElement('div');
    placeholder.className = 'design-placeholder';
    placeholder.textContent = 'No reference designs available.';
    designList.append(placeholder);
    return;
  }

  designs.forEach((design) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const titleEl = node.querySelector('.design-title');
    const metaEl = node.querySelector('.design-meta');
    const summaryEl = node.querySelector('.design-summary');
    const focusEl = node.querySelector('.design-focus');
    const metricsEl = node.querySelector('.design-metrics');
    const statusEl = node.querySelector('.card-status');
    const applyBtn = node.querySelector('.btn-apply');
    const applyCrossBtn = node.querySelector('.btn-apply-cross');

    titleEl.textContent = design.name;
    metaEl.textContent = `${design.crew} crew · ${design.duration}`;
    summaryEl.textContent = design.summary;

    focusEl.innerHTML = '';
    (design.focus || []).forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      focusEl.append(li);
    });

    const metricsNode = buildMetrics(design.metrics);
    metricsEl.replaceWith(metricsNode);

    applyBtn.addEventListener('click', () => {
      applyLayout(design.layout, null, statusEl);
    });
    applyCrossBtn.addEventListener('click', () => {
      applyLayout(design.layout, '/stacked', statusEl);
    });

    designList.append(node);
  });
}

async function loadDesigns() {
  if (designList) {
    designList.innerHTML = '<div class="design-placeholder">Loading design catalog…</div>';
  }
  try {
    const res = await fetch('/designs');
    if (!res.ok) {
      throw new Error(`Request failed (${res.status})`);
    }
    const data = await res.json();
    const designs = Array.isArray(data.designs) ? data.designs : [];
    renderDesigns(designs);
  } catch (err) {
    console.error('Failed to load designs', err);
    if (designList) {
      designList.innerHTML = '<div class="design-placeholder">Failed to load designs. Please retry.</div>';
    }
  }
}

if (refreshButton) {
  refreshButton.addEventListener('click', () => {
    loadDesigns();
  });
}

function readAutoConfig() {
  const crew = Number.parseInt(document.getElementById('autoCrew')?.value ?? '4', 10);
  const duration = Number.parseInt(document.getElementById('autoDuration')?.value ?? '90', 10);
  const habitatType = document.getElementById('autoHabType')?.value ?? 'Inflatable';
  const volume = Number.parseFloat(document.getElementById('autoVolume')?.value ?? '160');
  const isru = Number.parseFloat(document.getElementById('autoIsru')?.value ?? '0.6');
  const ports = Number.parseInt(document.getElementById('autoPorts')?.value ?? '2', 10);
  const seed = Number.parseInt(document.getElementById('autoSeed')?.value ?? '42', 10);
  const prompt = document.getElementById('autoPrompt')?.value ?? '';
  return {
    crew,
    duration_days: duration,
    habitat_type: habitatType,
    pressurized_volume_m3: volume,
    target_isru_ratio: isru,
    docking_ports: ports,
    seed,
    mission_prompt: prompt,
  };
}

function setAutoStatus(message, tone = 'info') {
  if (!autoStatus) {
    return;
  }
  autoStatus.textContent = message;
  autoStatus.className = 'auto-status';
  if (tone === 'success') {
    autoStatus.classList.add('success');
  } else if (tone === 'error') {
    autoStatus.classList.add('error');
  }
}

async function autoGenerate() {
  setAutoStatus('Generating layout…');
  try {
    const payload = readAutoConfig();
    autoLastConfig = payload;
    const res = await fetch('/api/layout/auto_generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Generate failed (${res.status})`);
    }
    const data = await res.json();
    autoRawLayout = data.raw_layout;
    autoDesignerLayout = data.layout;
    const metrics = data.metrics || {};
    const nhv = metrics.nhv_m3 ? formatNumber(metrics.nhv_m3) : '—';
    const eff = metrics.nhv_efficiency ? formatNumber(metrics.nhv_efficiency) : '—';
    const requirements = data.requirements || {};
    setAutoStatus(
      `Generated layout. Critical coverage ${formatNumber(requirements.score || 0)} / 100 (${requirements.covered || 0}/${requirements.required || 0}). `
      + `NHV ${nhv} m³, efficiency ${eff}. Validation messages: ${(data.validation || []).join('; ')}`,
      'success',
    );
  } catch (err) {
    console.error('Auto generate failed', err);
    setAutoStatus('Auto-generation failed. Check console for details.', 'error');
  }
}

async function autoOptimize() {
  if (!autoRawLayout) {
    setAutoStatus('Generate a layout before optimizing.', 'error');
    return;
  }
  setAutoStatus('Optimizing layout…');
  try {
    const res = await fetch('/api/layout/auto_optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layout: autoRawLayout,
        iterations: 2000,
        crew: autoLastConfig?.crew,
        mission_prompt: autoLastConfig?.mission_prompt,
      }),
    });
    if (!res.ok) {
      throw new Error(`Optimize failed (${res.status})`);
    }
    const data = await res.json();
    autoRawLayout = data.raw_layout;
    autoDesignerLayout = data.layout;
    const requirements = data.requirements || {};
    setAutoStatus(
      `Optimization complete. Critical coverage ${formatNumber(requirements.score || 0)} / 100 (${requirements.covered || 0}/${requirements.required || 0}).`,
      'success',
    );
  } catch (err) {
    console.error('Auto optimize failed', err);
    setAutoStatus('Optimization failed. Check console for details.', 'error');
  }
}

async function autoValidateLayout() {
  if (!autoRawLayout) {
    setAutoStatus('Generate or load a layout before validating.', 'error');
    return;
  }
  try {
    const res = await fetch('/api/layout/auto_validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layout: autoRawLayout,
        crew: autoLastConfig?.crew,
        mission_prompt: autoLastConfig?.mission_prompt,
      }),
    });
    if (!res.ok) {
      throw new Error(`Validate failed (${res.status})`);
    }
    const data = await res.json();
    const tone = data.passed ? 'success' : 'error';
    const requirements = data.requirements || {};
    const coverageText = requirements.required
      ? ` | Coverage ${formatNumber(requirements.score || 0)} / 100 (${requirements.covered || 0}/${requirements.required})`
      : '';
    setAutoStatus(`Validation ${data.passed ? 'passed' : 'failed'}: ${data.messages.join('; ')}${coverageText}`, tone);
  } catch (err) {
    console.error('Auto validate failed', err);
    setAutoStatus('Validation request failed.', 'error');
  }
}

async function autoScoreLayout() {
  if (!autoRawLayout) {
    setAutoStatus('Generate or load a layout before scoring.', 'error');
    return;
  }
  try {
    const res = await fetch('/api/layout/auto_score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layout: autoDesignerLayout ?? autoRawLayout,
        crew: autoLastConfig?.crew,
        mission_prompt: autoLastConfig?.mission_prompt,
      }),
    });
    if (!res.ok) {
      throw new Error(`Score failed (${res.status})`);
    }
    const data = await res.json();
    const requirements = data.requirements || {};
    setAutoStatus(
      `Coverage score ${formatNumber(data.score)} / 100 (${requirements.covered || 0}/${requirements.required || 0}).`,
      'success',
    );
  } catch (err) {
    console.error('Auto score failed', err);
    setAutoStatus('Score request failed.', 'error');
  }
}

async function autoExportLayout() {
  if (!autoRawLayout) {
    setAutoStatus('Generate or load a layout before exporting.', 'error');
    return;
  }
  try {
    const res = await fetch('/api/layout/auto_export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layout: autoRawLayout,
        crew: autoLastConfig?.crew,
        mission_prompt: autoLastConfig?.mission_prompt,
      }),
    });
    if (!res.ok) {
      throw new Error(`Export failed (${res.status})`);
    }
    const data = await res.json();
    const blob = new Blob([data.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lunar_layout_report.md';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    const requirements = data.requirements || {};
    setAutoStatus(`Exported Markdown report. Coverage ${formatNumber(requirements.score || 0)} / 100`, 'success');
  } catch (err) {
    console.error('Auto export failed', err);
    setAutoStatus('Export failed.', 'error');
  }
}

async function loadAutoIntoDesigner() {
  if (!autoDesignerLayout) {
    setAutoStatus('No designer layout available. Generate or optimize first.', 'error');
    return;
  }
  try {
    const res = await fetch('/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        habitat: autoDesignerLayout.habitat,
        modules: autoDesignerLayout.modules,
        render_style: autoDesignerLayout.render_style || 'realistic',
        crew: autoLastConfig?.crew,
        mission_prompt: autoLastConfig?.mission_prompt,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to load into designer (${res.status})`);
    }
    setAutoStatus('Layout loaded into Designer. Open the Designer tab to view.', 'success');
  } catch (err) {
    console.error('Load into designer failed', err);
    setAutoStatus('Failed to sync with Designer.', 'error');
  }
}

if (autoGenerateBtn) {
  autoGenerateBtn.addEventListener('click', autoGenerate);
}
if (autoOptimizeBtn) {
  autoOptimizeBtn.addEventListener('click', autoOptimize);
}
if (autoValidateBtn) {
  autoValidateBtn.addEventListener('click', autoValidateLayout);
}
if (autoScoreBtn) {
  autoScoreBtn.addEventListener('click', autoScoreLayout);
}
if (autoExportBtn) {
  autoExportBtn.addEventListener('click', autoExportLayout);
}
if (autoLoadDesignerBtn) {
  autoLoadDesignerBtn.addEventListener('click', loadAutoIntoDesigner);
}

window.addEventListener('DOMContentLoaded', () => {
  loadDesigns();
});
