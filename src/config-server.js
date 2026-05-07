/**
 * config-server.js
 * Local web UI at http://localhost:3001 — user-friendly printer setup.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// When running as an installed Electron app, CONFIG_DIR points to userData
const CONFIG_PATH = process.env.CONFIG_DIR
  ? path.join(process.env.CONFIG_DIR, 'config.json')
  : path.join(__dirname, '..', 'config.json');
const PORT = process.env.CONFIG_PORT ?? 3001;

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {}
  return {};
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function mergeWithEnv(saved) {
  return {
    backendUrl:      saved.backendUrl      ?? process.env.BACKEND_URL      ?? '',
    wsApiKey:        saved.wsApiKey        ?? process.env.WS_API_KEY        ?? '',
    branchId:        saved.branchId        ?? process.env.BRANCH_ID         ?? '',
    branchName:      saved.branchName      ?? '',
    tenantName:      saved.tenantName      ?? '',
    stationId:       saved.stationId       ?? process.env.STATION_ID        ?? '',
    stationName:     saved.stationName     ?? '',
    // Legacy single-printer (kept for backward compat)
    printerIp:       saved.printerIp       ?? process.env.PRINTER_IP        ?? '192.168.100.100',
    printerPort:     saved.printerPort     ?? process.env.PRINTER_PORT      ?? '9100',
    receiptWidth:    saved.receiptWidth    ?? process.env.RECEIPT_WIDTH     ?? '48',
    printOrderTypes: saved.printOrderTypes ?? process.env.PRINT_ORDER_TYPES ?? '',
    // Multi-printer list
    printers:        Array.isArray(saved.printers) ? saved.printers : [],
  };
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function renderPage(config, saved = false, error = '') {
  const v = k => config[k] ?? '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>KDS Print Bridge — Setup</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px}
    .card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);width:100%;max-width:560px;overflow:hidden}
    .card-header{background:linear-gradient(135deg,#1a1a2e,#16213e);padding:28px 32px;color:#fff}
    .card-header h1{font-size:20px;font-weight:700;margin-bottom:4px}
    .card-header p{font-size:13px;opacity:.65}
    .badge{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.12);border-radius:20px;padding:4px 12px;font-size:11px;font-weight:600;margin-top:12px}
    .dot{width:7px;height:7px;border-radius:50%;background:#4ade80;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .card-body{padding:28px 32px}
    .section{margin-bottom:24px}
    .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #f3f4f6}
    .field{margin-bottom:16px}
    .field label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px}
    .field .hint{font-size:11px;color:#9ca3af;margin-top:4px}
    input[type=text],input[type=number],input[type=password],select{width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;color:#111827;outline:none;transition:border-color .15s;font-family:inherit;background:#fff}
    input:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.1)}
    select:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.1)}
    select:disabled{background:#f3f4f6;color:#9ca3af}
    input.mono{font-family:'Courier New',monospace;font-size:13px}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .key-wrap{display:flex;align-items:center;gap:8px;border:1.5px solid #e5e7eb;border-radius:10px;padding:0 10px;transition:border-color .15s}
    .key-wrap:focus-within{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.1)}
    .key-wrap input{border:none!important;box-shadow:none!important;flex:1;padding:10px 4px}
    .eye-btn{background:none;border:none;cursor:pointer;color:#9ca3af;font-size:16px;padding:2px;line-height:1;flex-shrink:0}
    .eye-btn:hover{color:#374151}
    .branch-status{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;font-size:13px;margin-top:8px;min-height:42px}
    .branch-status.idle{background:#f9fafb;border:1.5px solid #e5e7eb;color:#9ca3af}
    .branch-status.loading{background:#eff6ff;border:1.5px solid #bfdbfe;color:#1d4ed8}
    .branch-status.ok{background:#f0fdf4;border:1.5px solid #bbf7d0;color:#166534}
    .branch-status.err{background:#fef2f2;border:1.5px solid #fecaca;color:#991b1b}
    .spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
    @keyframes spin{to{transform:rotate(360deg)}}
    .branch-icon{font-size:16px;flex-shrink:0}
    .chip-group{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
    .chip{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;border:1.5px solid #e5e7eb;cursor:pointer;transition:all .15s;background:#fff;color:#6b7280;user-select:none}
    .chip.active{background:#6366f1;border-color:#6366f1;color:#fff}
    .chip:hover:not(.active){border-color:#6366f1;color:#6366f1}
    .alert{padding:12px 16px;border-radius:10px;font-size:13px;margin-bottom:20px;display:flex;align-items:center;gap:10px}
    .alert.success{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}
    .alert.error{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}
    .btn{width:100%;padding:13px;background:#6366f1;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;transition:background .15s;margin-top:4px}
    .btn:hover{background:#4f46e5}
    .btn:disabled{background:#a5b4fc;cursor:not-allowed}
    .footer-note{text-align:center;font-size:11px;color:#9ca3af;margin-top:20px}
    code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-family:monospace}
    .add-btn{width:100%;padding:9px;background:transparent;color:#6366f1;border:1.5px dashed #6366f1;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;margin-top:4px}
    .add-btn:hover{background:#eff0ff}
    .printer-row{display:grid;grid-template-columns:1fr 80px 90px auto;gap:8px;align-items:end;margin-bottom:10px;padding:12px;border:1.5px solid #e5e7eb;border-radius:10px;background:#fafafa}
    .printer-row .field{margin-bottom:0}
    .remove-btn{background:none;border:1.5px solid #fecaca;color:#ef4444;border-radius:8px;padding:8px 10px;cursor:pointer;font-size:14px;transition:all .15s;height:40px}
    .remove-btn:hover{background:#fef2f2}
  </style>
</head>
<body>
<div class="card">
  <div class="card-header">
    <h1>🖨️ KDS Print Bridge</h1>
    <p>Configure your printer — no technical knowledge needed</p>
    <div class="badge"><span class="dot"></span> Local Setup Tool · http://localhost:${PORT}</div>
  </div>

  <div class="card-body">
    ${saved ? `<div class="alert success">✅ Settings saved! Restart the bridge for changes to take effect.</div>` : ''}
    ${error ? `<div class="alert error">❌ ${error}</div>` : ''}

    <form method="POST" action="/save" id="form">
      <div class="section">
        <div class="section-title">Step 1 — Connect to your restaurant system</div>
        <div class="field">
          <label>Backend URL</label>
          <input type="text" name="backendUrl" id="backendUrl"
            value="${v('backendUrl')}" placeholder="https://your-backend.onrender.com"/>
          <div class="hint">Your cloud backend address</div>
        </div>
        <div class="field">
          <label>API Key</label>
          <div class="key-wrap">
            <input class="mono" type="password" name="wsApiKey" id="apiKeyInput"
              value="${v('wsApiKey')}" placeholder="pk_xxxxxxxxxxxxxxxx"
              autocomplete="off" oninput="onKeyInput()" onblur="validateKey()"/>
            <button type="button" class="eye-btn" onclick="toggleKey()" title="Show/hide">👁</button>
          </div>
          <div class="hint">Generate from ERP → Settings → Printer Settings</div>
          <div class="branch-status idle" id="branchStatus">
            <span class="branch-icon">🏪</span>
            <span id="branchStatusText">Paste your API key above to verify</span>
          </div>
          <input type="hidden" name="branchId"   id="branchId"   value="${v('branchId')}"/>
          <input type="hidden" name="branchName" id="branchName" value="${v('branchName')}"/>
          <input type="hidden" name="tenantName" id="tenantName" value="${v('tenantName')}"/>
        </div>
        <div class="field">
          <label>Kitchen Station</label>
          <select name="stationId" id="stationIdSelect" data-selected="${v('stationId')}" onchange="updateStationName()">
            <option value="">All stations (full order)</option>
          </select>
          <div class="hint">Select a station to print only its items</div>
          <input type="hidden" name="stationName" id="stationName" value="${v('stationName')}"/>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Step 2 — Printers</div>
        <div id="printerList"></div>
        <button type="button" class="add-btn" onclick="addPrinter()">+ Add Printer</button>
        <input type="hidden" name="printersJson" id="printersJson" value=""/>
      </div>

      <div class="section">
        <div class="section-title">Step 3 — Receipt preferences</div>
        <div class="field">
          <label>Paper Width</label>
          <div class="chip-group" id="widthChips">
            <div class="chip ${v('receiptWidth') === '32' ? 'active' : ''}"
              onclick="selectWidth('32',this)">58mm paper</div>
            <div class="chip ${v('receiptWidth') !== '32' ? 'active' : ''}"
              onclick="selectWidth('48',this)">80mm paper</div>
          </div>
          <input type="hidden" name="receiptWidth" id="receiptWidth"
            value="${v('receiptWidth') || '48'}"/>
        </div>
        <div class="field">
          <label>Which orders should print?</label>
          <div class="chip-group" id="typeChips">
            ${['DineIn','TakeAway','Delivery'].map(t => {
              const active = (v('printOrderTypes')||'').split(',').map(s=>s.trim()).includes(t);
              return `<div class="chip ${active?'active':''}" onclick="toggleType('${t}',this)">${t}</div>`;
            }).join('')}
          </div>
          <input type="hidden" name="printOrderTypes" id="printOrderTypes"
            value="${v('printOrderTypes')}"/>
          <div class="hint">Leave all unselected to print every order type</div>
        </div>
      </div>

      <button type="submit" class="btn" id="saveBtn">💾 Save Settings</button>
    </form>

    <div class="footer-note">
      After saving, restart the bridge from the tray icon
    </div>
  </div>
</div>

<script>
  function toggleKey() {
    const inp = document.getElementById('apiKeyInput');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  }

  function selectWidth(val, el) {
    document.querySelectorAll('#widthChips .chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('receiptWidth').value = val;
  }

  function toggleType(val, el) {
    el.classList.toggle('active');
    const active = [...document.querySelectorAll('#typeChips .chip.active')].map(c => c.textContent.trim());
    document.getElementById('printOrderTypes').value = active.join(',');
  }

  let validateTimer = null;

  function onKeyInput() {
    clearTimeout(validateTimer);
    setStatus('idle', '🏪', 'Paste your API key above to verify');
    document.getElementById('branchId').value   = '';
    document.getElementById('branchName').value = '';
    document.getElementById('tenantName').value = '';
    setStations([]);
    updateStationName();
    validateTimer = setTimeout(validateKey, 800);
  }

  async function validateKey() {
    const key     = document.getElementById('apiKeyInput').value.trim();
    const backend = document.getElementById('backendUrl').value.trim();

    if (!key || key.length < 10) return;
    if (!backend) { setStatus('err', '❌', 'Enter the Backend URL first'); return; }

    setStatus('loading', '<span class="spin"></span>', 'Verifying API key…');

    try {
      const res  = await fetch(backend.replace(/\\/$/, '') + '/api/settings/printer/validate-key', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ apiKey: key }),
      });
      const data = await res.json();

      if (data.success) {
        document.getElementById('branchId').value   = data.branchId   || '';
        document.getElementById('branchName').value = data.branchName || '';
        document.getElementById('tenantName').value = data.tenantName || '';
        setStations(Array.isArray(data.stations) ? data.stations : []);
        setStatus('ok', '✅', '<strong>' + escHtml(data.tenantName) + '</strong> · ' + escHtml(data.branchName));
      } else {
        setStatus('err', '❌', data.message || 'Invalid API key');
      }
    } catch (e) {
      setStatus('err', '⚠️', 'Could not reach backend — check the URL');
    }
  }

  function setStatus(cls, icon, text) {
    const el = document.getElementById('branchStatus');
    el.className = 'branch-status ' + cls;
    el.innerHTML = '<span class="branch-icon">' + icon + '</span><span>' + text + '</span>';
  }

  function setStations(stations) {
    const select = document.getElementById('stationIdSelect');
    if (!select) return;

    const selected = select.getAttribute('data-selected') || select.value || '';
    const opts = ['<option value="">All stations (full order)</option>'];
    (stations || []).forEach(st => {
      const id = st.id || st._id || '';
      const name = st.name || 'Station';
      if (!id) return;
      opts.push('<option value="' + escAttr(id) + '">' + escHtml(name) + '</option>');
    });
    select.innerHTML = opts.join('');
    if (selected) select.value = selected;
    select.disabled = opts.length <= 1;
    updateStationName();
  }

  function updateStationName() {
    const select = document.getElementById('stationIdSelect');
    const nameInput = document.getElementById('stationName');
    if (!select || !nameInput) return;
    const option = select.options[select.selectedIndex];
    const name = option ? option.textContent.trim() : '';
    nameInput.value = select.value && name !== 'All stations (full order)' ? name : '';
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function escAttr(s) {
    return escHtml(s).replace(/"/g,'&quot;');
  }

  window.addEventListener('DOMContentLoaded', () => {
    const key     = document.getElementById('apiKeyInput').value.trim();
    const backend = document.getElementById('backendUrl').value.trim();

    if (key && backend) validateKey();

    // Initialise printer list from saved config
    const saved = ${JSON.stringify(config.printers || [])};
    if (saved.length > 0) {
      saved.forEach(p => addPrinter(p));
    } else {
      // Seed from legacy single-printer fields
      addPrinter({ label: 'Printer 1', ip: '${v('printerIp')}', port: '${v('printerPort')}', paperWidth: '${v('receiptWidth') === '32' ? '58mm' : '80mm'}' });
    }
    syncPrintersJson();
  });

  let printerCount = 0;

  function addPrinter(p = {}) {
    printerCount++;
    const idx = printerCount;
    const list = document.getElementById('printerList');
    const row  = document.createElement('div');
    row.className = 'printer-row';
    row.id = 'printer-row-' + idx;
    row.innerHTML = \`
      <div class="field">
        <label>Label</label>
        <input type="text" class="p-label" placeholder="Printer \${idx}" value="\${escAttr(p.label||'Printer '+idx)}" oninput="syncPrintersJson()"/>
      </div>
      <div class="field">
        <label>IP Address</label>
        <input type="text" class="mono p-ip" placeholder="192.168.x.x" value="\${escAttr(p.ip||'')}" oninput="syncPrintersJson()"/>
      </div>
      <div class="field">
        <label>Port</label>
        <input type="number" class="mono p-port" placeholder="9100" value="\${escAttr(p.port||'9100')}" oninput="syncPrintersJson()"/>
      </div>
      <div class="field">
        <label>Width</label>
        <select class="p-width" onchange="syncPrintersJson()">
          <option value="80mm" \${(p.paperWidth||'80mm')==='80mm'?'selected':''}>80mm</option>
          <option value="58mm" \${p.paperWidth==='58mm'?'selected':''}>58mm</option>
        </select>
      </div>
      <button type="button" class="remove-btn" onclick="removePrinter(\${idx})" title="Remove">✕</button>
    \`;
    list.appendChild(row);
    syncPrintersJson();
  }

  function removePrinter(idx) {
    const row = document.getElementById('printer-row-' + idx);
    if (row) row.remove();
    syncPrintersJson();
  }

  function syncPrintersJson() {
    const rows = document.querySelectorAll('.printer-row');
    const printers = [];
    rows.forEach(row => {
      const ip = row.querySelector('.p-ip')?.value?.trim();
      if (!ip) return;
      printers.push({
        label:      row.querySelector('.p-label')?.value?.trim() || 'Printer',
        ip,
        port:       parseInt(row.querySelector('.p-port')?.value || '9100', 10) || 9100,
        paperWidth: row.querySelector('.p-width')?.value || '80mm',
        enabled:    true,
      });
    });
    document.getElementById('printersJson').value = JSON.stringify(printers);
  }
</script>
</body>
</html>`;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function startConfigServer(onConfigSaved) {
  const server = http.createServer((req, res) => {

    if (req.method === 'GET' && req.url === '/') {
      const config = mergeWithEnv(loadConfig());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderPage(config));
      return;
    }

    if (req.method === 'POST' && req.url === '/save') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const p = new URLSearchParams(body);
          let printers = [];
          try {
            const raw = p.get('printersJson');
            if (raw) printers = JSON.parse(raw);
          } catch (_) {}

          // Build legacy single-printer fields from the first printer entry (backward compat)
          const firstPrinter = printers[0] || {};
          const data = {
            backendUrl:      p.get('backendUrl')?.trim()      || '',
            wsApiKey:        p.get('wsApiKey')?.trim()        || '',
            branchId:        p.get('branchId')?.trim()        || '',
            branchName:      p.get('branchName')?.trim()      || '',
            tenantName:      p.get('tenantName')?.trim()      || '',
            stationId:       p.get('stationId')?.trim()       || '',
            stationName:     p.get('stationName')?.trim()     || '',
            // Legacy fields — mirror first printer so old bridge versions still work
            printerIp:       firstPrinter.ip    || '192.168.100.100',
            printerPort:     firstPrinter.port  || '9100',
            receiptWidth:    firstPrinter.paperWidth === '58mm' ? '32' : '48',
            printOrderTypes: p.get('printOrderTypes')?.trim() || '',
            // Multi-printer list
            printers,
          };

          if (!data.backendUrl) throw new Error('Backend URL is required');
          if (!data.wsApiKey)   throw new Error('API Key is required');
          if (data.printers.length === 0) throw new Error('Add at least one printer');

          saveConfig(data);
          if (onConfigSaved) onConfigSaved(data);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderPage(mergeWithEnv(data), true));
        } catch (err) {
          const config = mergeWithEnv(loadConfig());
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderPage(config, false, err.message));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ┌──────────────────────────────────────────────┐`);
    console.log(`  │  🖨️  Print Bridge Setup UI                    │`);
    console.log(`  │  Open in browser → http://localhost:${PORT}       │`);
    console.log(`  └──────────────────────────────────────────────┘\n`);
  });

  return server;
}

module.exports = { startConfigServer, loadConfig };
