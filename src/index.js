/**
 * KDS Print Bridge — entry point
 * Can be run standalone: node src/index.js
 * Or required by Electron main process: require('./src/index.js').start() / .stop()
 *
 * Architecture:
 *  - Realtime: WebSocket `order_created` event → instant print (unchanged)
 *  - Recovery: On reconnect + every 10s, fetch pending jobs from backend and print missed ones
 *  - ACK: After successful print, POST /print-jobs/:id/ack so backend marks job as printed
 *  - Heartbeat: POST /print-jobs/heartbeat every 20s so backend knows printer is online
 *  - Duplicate guard: claim job via POST /print-jobs/:id/claim before printing
 */

'use strict';

const { io }                          = require('socket.io-client');
const { buildReceipt, sendToPrinter } = require('./printer.js');
const { PrintQueue }                  = require('./queue.js');
const { loadConfig }                  = require('./config-server.js');

// ── Active socket reference (so we can stop cleanly) ─────────────────────────
let _activeSocket    = null;
let _reconnectTimer  = null;
let _pollTimer       = null;
let _heartbeatTimer  = null;
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
  if (_reconnectTimer) { clearTimeout(_reconnectTimer);   _reconnectTimer  = null; }
  if (_pollTimer)      { clearInterval(_pollTimer);        _pollTimer       = null; }
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer);   _heartbeatTimer  = null; }
  if (_activeSocket)   { _activeSocket.removeAllListeners(); _activeSocket.disconnect(); _activeSocket = null; }
  console.log('[Bridge] Stopped.');
}

// ── HTTP helpers (for ACK, claim, pending sync, heartbeat) ───────────────────

async function apiPost(cfg, path) {
  const url = `${cfg.BACKEND_URL.replace(/\/$/, '')}/api${path}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'x-api-key': cfg.WS_API_KEY, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiGet(cfg, path) {
  const url = `${cfg.BACKEND_URL.replace(/\/$/, '')}/api${path}`;
  const res = await fetch(url, {
    headers: { 'x-api-key': cfg.WS_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── WebSocket + print loop ────────────────────────────────────────────────────

function startBridge(cfg, onStatus) {
  _stopped = false;

  // Track job IDs currently in the local queue or being printed.
  // Prevents the 10s poll from re-enqueueing a job that's already in-flight.
  const _inFlight = new Set();

  const queue = new PrintQueue(async ({ order, receipt, printJobId }) => {
    console.log(`[Print] Printing order ${order.orderNumber ?? order.id} ...`);

    // Claim the job to prevent duplicate prints from concurrent sync calls
    if (printJobId) {
      try {
        const claimRes = await apiPost(cfg, `/print-jobs/${printJobId}/claim`);
        if (!claimRes.success) {
          console.log(`[Print] Job ${printJobId} already claimed — skipping duplicate`);
          _inFlight.delete(printJobId);
          return;
        }
        console.log(`[Print] Claimed job ${printJobId}`);
      } catch (claimErr) {
        // 409 = already claimed by another process
        if (claimErr.message.includes('409')) {
          console.log(`[Print] Job ${printJobId} already claimed (409) — skipping`);
          _inFlight.delete(printJobId);
          return;
        }
        console.warn(`[Print] Could not claim job ${printJobId}: ${claimErr.message} — proceeding anyway`);
      }
    }

    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await sendToPrinter(receipt, cfg.PRINTER_IP, cfg.PRINTER_PORT);
        console.log(`[Print] ✓ Order ${order.orderNumber ?? order.id} printed`);

        // ACK only after confirmed printer write success
        if (printJobId) {
          try {
            await apiPost(cfg, `/print-jobs/${printJobId}/ack`);
            console.log(`[Print] ✓ ACK sent for job ${printJobId}`);
          } catch (ackErr) {
            console.error(`[Print] ACK failed for job ${printJobId}: ${ackErr.message}`);
          }
        }
        _inFlight.delete(printJobId);
        return;
      } catch (err) {
        lastError = err.message;
        console.error(`[Print] ✗ Attempt ${attempt}/3 failed: ${err.message}`);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }

    console.error(`[Print] ✗ Giving up on order ${order.orderNumber ?? order.id}`);

    // Reset job back to "pending" so the next sync poll will retry it.
    if (printJobId) {
      try {
        await apiPost(cfg, `/print-jobs/${printJobId}/reset`);
        console.log(`[Print] Job ${printJobId} reset to pending for future retry`);
      } catch (resetErr) {
        console.error(`[Print] Could not reset job ${printJobId}: ${resetErr.message}`);
      }
      _inFlight.delete(printJobId);
    }
  });

  // ── Pending job sync (recovery) ───────────────────────────────────────────

  async function syncPendingJobs() {
    if (_stopped) return;
    try {
      console.log('[Sync] Fetching pending print jobs ...');
      const data = await apiGet(cfg, `/print-jobs/pending?branchId=${cfg.BRANCH_ID}`);
      const jobs = data.jobs || [];

      if (jobs.length === 0) {
        console.log('[Sync] No pending jobs.');
        return;
      }

      console.log(`[Sync] Found ${jobs.length} pending job(s) — queuing for print`);

      for (const job of jobs) {
        const order = job.payloadJson;
        if (!order) continue;

        // Skip if this job is already queued or being printed locally
        if (_inFlight.has(job._id)) {
          console.log(`[Sync] Job ${job._id} already in-flight — skipping`);
          continue;
        }

        const orderType = (order.orderType ?? '').toLowerCase();
        if (cfg.PRINT_TYPES.length > 0 && !cfg.PRINT_TYPES.includes(orderType)) {
          console.log(`[Sync] Skipping job ${job._id} (type: ${order.orderType})`);
          continue;
        }

        const receipt = buildReceipt(order, {
          restaurantName: order.tenantName || cfg.RESTAURANT_NAME,
          branchName:     order.branchName || '',
          width:          cfg.RECEIPT_WIDTH,
        });

        _inFlight.add(job._id);
        queue.enqueue({ order, receipt, printJobId: job._id });
      }
    } catch (err) {
      console.error('[Sync] Failed to fetch pending jobs:', err.message);
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  async function sendHeartbeat() {
    if (_stopped) return;
    try {
      await apiPost(cfg, '/print-jobs/heartbeat');
      console.log('[Heartbeat] ✓ Sent');
    } catch (err) {
      console.error('[Heartbeat] Failed:', err.message);
    }
  }

  // ── WebSocket connection ──────────────────────────────────────────────────

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

    socket.on('connect', async () => {
      reconnectDelay = 3000;
      console.log(`[WS] ✓ Connected (socket: ${socket.id})`);
      if (onStatus) onStatus('running');

      // Immediately sync any jobs missed during disconnection
      await syncPendingJobs();
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

        // printJobId is attached by the backend so we can ACK after print
        const printJobId = payload?.printJobId || null;

        // Register in-flight so the sync poll doesn't re-enqueue this job
        if (printJobId) _inFlight.add(printJobId);

        queue.enqueue({ order, receipt, printJobId });
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

  // Periodic backup polling — catches any jobs missed even if reconnect event fails
  _pollTimer = setInterval(syncPendingJobs, 10_000); // every 10 seconds

  // Heartbeat — lets backend know the printer is online
  _heartbeatTimer = setInterval(sendHeartbeat, 20_000); // every 20 seconds
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
