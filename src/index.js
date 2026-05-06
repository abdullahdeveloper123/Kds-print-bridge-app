/**
 * KDS Print Bridge — entry point
 * Can be run standalone: node src/index.js
 * Or required by Electron main process: require('./src/index.js').start() / .stop()
 */

'use strict';

const { io }                          = require('socket.io-client');
const { buildReceipt, sendToPrinter } = require('./printer.js');
const { PrintQueue }                  = require('./queue.js');
const { loadConfig }                  = require('./config-server.js');

// ── Active socket reference (so we can stop cleanly) ─────────────────────────
let _activeSocket    = null;
let _reconnectTimer  = null;
let _stopped         = false;

// ── Config ────────────────────────────────────────────────────────────────────

function getConfig() {
  const saved = loadConfig();
  return {
    BACKEND_URL:     saved.backendUrl      || process.env.BACKEND_URL      || '',
    WS_API_KEY:      saved.wsApiKey        || process.env.WS_API_KEY        || '',
    BRANCH_ID:       saved.branchId        || process.env.BRANCH_ID         || '',
    PRINTER_IP:      saved.printerIp       || process.env.PRINTER_IP        || '192.168.100.100',
    PRINTER_PORT:    parseInt(saved.printerPort  || process.env.PRINTER_PORT  || '9100', 10),
    RESTAURANT_NAME: saved.tenantName      || saved.restaurantName          ||
                     process.env.RESTAURANT_NAME                            || 'RESTAURANT',
    RECEIPT_WIDTH:   parseInt(saved.receiptWidth || process.env.RECEIPT_WIDTH || '48', 10),
    PRINT_TYPES:     (saved.printOrderTypes || process.env.PRINT_ORDER_TYPES || '')
                       .split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
  };
}

// ── Stop (called before reconfigure) ─────────────────────────────────────────

function stop() {
  _stopped = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_activeSocket)   { _activeSocket.removeAllListeners(); _activeSocket.disconnect(); _activeSocket = null; }
  console.log('[Bridge] Stopped.');
}

// ── WebSocket + print loop ────────────────────────────────────────────────────

function startBridge(cfg, onStatus) {
  _stopped = false;

  const queue = new PrintQueue(async ({ order, receipt }) => {
    console.log(`[Print] Printing order ${order.orderNumber ?? order.id} ...`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await sendToPrinter(receipt, cfg.PRINTER_IP, cfg.PRINTER_PORT);
        console.log(`[Print] ✓ Order ${order.orderNumber ?? order.id} printed`);
        return;
      } catch (err) {
        console.error(`[Print] ✗ Attempt ${attempt}/3 failed: ${err.message}`);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }
    console.error(`[Print] ✗ Giving up on order ${order.orderNumber ?? order.id}`);
  });

  let reconnectDelay = 3000;

  function connect() {
    if (_stopped) return;
    console.log(`[WS] Connecting to ${cfg.BACKEND_URL} ...`);

    const socket = io(cfg.BACKEND_URL, {
      auth:         { apiKey: cfg.WS_API_KEY, branchId: cfg.BRANCH_ID },
      query:        { branchId: cfg.BRANCH_ID },
      transports:   ['websocket'],
      reconnection: false,
      timeout:      10000,
    });

    _activeSocket = socket;

    socket.on('connect', () => {
      reconnectDelay = 3000;
      console.log(`[WS] ✓ Connected (socket: ${socket.id})`);
      if (onStatus) onStatus('running');
    });

    socket.on('disconnect', (reason) => {
      if (_stopped) return;
      console.warn(`[WS] Disconnected: ${reason}. Reconnecting in ${reconnectDelay / 1000}s ...`);
      if (onStatus) onStatus('disconnected');
      _reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        connect();
      }, reconnectDelay);
    });

    socket.on('connect_error', (err) => {
      if (_stopped) return;
      console.error(`[WS] Connection error: ${err.message}. Retrying in ${reconnectDelay / 1000}s ...`);
      if (onStatus) onStatus('disconnected');
      _reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        connect();
      }, reconnectDelay);
    });

    socket.on('order_created', (payload) => {
      try {
        const order = payload?.order ?? payload;
        if (!order) { console.warn('[WS] Empty payload — skipping'); return; }

        const orderType = (order.orderType ?? '').toLowerCase();
        if (cfg.PRINT_TYPES.length > 0 && !cfg.PRINT_TYPES.includes(orderType)) {
          console.log(`[WS] Skipping order ${order.orderNumber ?? order.id} (type: ${order.orderType})`);
          return;
        }

        console.log(`[WS] New order: ${order.orderNumber ?? order.id} (${order.orderType})`);

        const receipt = buildReceipt(order, {
          restaurantName: order.tenantName || cfg.RESTAURANT_NAME,
          branchName:     order.branchName || '',
          width:          cfg.RECEIPT_WIDTH,
        });

        queue.enqueue({ order, receipt });
      } catch (err) {
        console.error('[WS] Error handling order_created:', err.message);
      }
    });

    socket.on('error', (err) => {
      console.error('[WS] Server error:', err?.message ?? err);
    });
  }

  console.log('─────────────────────────────────────────');
  console.log('  KDS Print Bridge');
  console.log(`  Printer : ${cfg.PRINTER_IP}:${cfg.PRINTER_PORT}`);
  console.log(`  Backend : ${cfg.BACKEND_URL}`);
  console.log(`  Branch  : ${cfg.BRANCH_ID}`);
  console.log(`  Filter  : ${cfg.PRINT_TYPES.length ? cfg.PRINT_TYPES.join(', ') : 'ALL'}`);
  console.log('─────────────────────────────────────────');

  connect();
}

// ── Exported API (used by Electron main.js) ───────────────────────────────────

function start(onStatus) {
  const cfg = getConfig();

  if (!cfg.BACKEND_URL || !cfg.WS_API_KEY || !cfg.BRANCH_ID) {
    console.warn('[Bridge] Not configured — skipping WebSocket connection');
    if (onStatus) onStatus('not_configured');
    return;
  }

  startBridge(cfg, onStatus);
}

module.exports = { start, stop };

// ── Standalone mode (node src/index.js) ───────────────────────────────────────

if (require.main === module) {
  require('dotenv/config');
  const { startConfigServer } = require('./config-server.js');

  startConfigServer(() => {
    console.log('[Config] Settings updated — restart to apply.');
  });

  start((status) => {
    if (status === 'not_configured') {
      console.log('\n  ⚠️  Not configured. Open http://localhost:3001\n');
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
