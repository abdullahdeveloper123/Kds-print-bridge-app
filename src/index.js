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

  // Build the printers list.
  // Priority: saved.printers[] array → legacy single printerIp → env vars
  let printers = [];

  if (Array.isArray(saved.printers) && saved.printers.length > 0) {
    // Multi-printer config (new format)
    printers = saved.printers
      .filter((p) => p && p.ip && p.enabled !== false)
      .map((p) => ({
        label:                 p.label || 'Printer',
        ip:                    p.ip,
        port:                  parseInt(p.port, 10) || 9100,
        paperWidth:            p.paperWidth === '58mm' ? 32 : 48,
        // Station filter — array of subcategory ID strings; empty = print all items
        stationSubcategoryIds: Array.isArray(p.stationSubcategoryIds)
          ? p.stationSubcategoryIds.map(String).filter(Boolean)
          : [],
        stationName:           p.stationName || null,
      }));
  }

  // Always fall back to the legacy single-printer fields so existing installs keep working
  const legacyIp   = saved.printerIp   || process.env.PRINTER_IP   || '';
  const legacyPort = parseInt(saved.printerPort || process.env.PRINTER_PORT || '9100', 10);
  const legacyWidth = parseInt(saved.receiptWidth || process.env.RECEIPT_WIDTH || '48', 10);

  if (printers.length === 0 && legacyIp) {
    printers = [{ label: 'Printer', ip: legacyIp, port: legacyPort, paperWidth: legacyWidth, stationSubcategoryIds: [], stationName: null }];
  }

  return {
    BACKEND_URL:     saved.backendUrl      || process.env.BACKEND_URL      || '',
    WS_API_KEY:      saved.wsApiKey        || process.env.WS_API_KEY        || '',
    BRANCH_ID:       saved.branchId        || process.env.BRANCH_ID         || '',
    STATION_ID:      saved.stationId       || process.env.STATION_ID        || '',
    // Legacy single-printer (kept for logging / backward compat)
    PRINTER_IP:      legacyIp,
    PRINTER_PORT:    legacyPort,
    RESTAURANT_NAME: saved.tenantName      || saved.restaurantName          ||
                     process.env.RESTAURANT_NAME                            || 'RESTAURANT',
    RECEIPT_WIDTH:   legacyWidth,
    PRINT_TYPES:     (saved.printOrderTypes || process.env.PRINT_ORDER_TYPES || '')
                       .split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
    // Multi-printer list (always populated — at least one entry)
    PRINTERS:        printers,
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

    // ── Multi-bridge mode: No claim check ─────────────────────────────────
    // Multiple bridge instances can print the same job independently.
    // Each bridge ACKs after successful print. The backend tracks all ACKs.
    // Trade-off: If multiple bridges succeed, the order prints multiple times
    // (which is acceptable for redundancy in a multi-printer setup).

    // ── Fan-out: send to every enabled printer in parallel ────────────────
    const printers = cfg.PRINTERS;
    const results  = await Promise.allSettled(
      printers.map(async (printer) => {
        // ── Station filtering ─────────────────────────────────────────────
        // If this printer is assigned to a KDS station, only print the items
        // that belong to that station's subcategories.
        // If no station is assigned, print the full order (all items).
        let printOrder = order;
        if (printer.stationSubcategoryIds && printer.stationSubcategoryIds.length > 0) {
          const stationItems = (order.items || []).filter((item) => {
            const subCatId = item.subCategoryId ? String(item.subCategoryId) : null;
            return subCatId && printer.stationSubcategoryIds.includes(subCatId);
          });

          if (stationItems.length === 0) {
            // No items for this station in this order — skip printer silently
            console.log(`[Print] ⏭ ${printer.label} — no items for station "${printer.stationName || 'assigned'}", skipping`);
            return;
          }

          // Build a filtered order copy with only this station's items
          printOrder = { ...order, items: stationItems };
          console.log(`[Print] ${printer.label} — printing ${stationItems.length}/${(order.items || []).length} item(s) for station "${printer.stationName || 'assigned'}"`);
        }

        // Build a receipt sized for this specific printer
        const printerReceipt = buildReceipt(printOrder, {
          restaurantName: order.tenantName || cfg.RESTAURANT_NAME,
          branchName:     order.branchName || '',
          width:          printer.paperWidth,
        });

        let lastErr = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await sendToPrinter(printerReceipt, printer.ip, printer.port);
            console.log(`[Print] ✓ ${printer.label} (${printer.ip}) — order ${order.orderNumber ?? order.id}`);
            return; // success for this printer
          } catch (err) {
            lastErr = err.message;
            console.error(`[Print] ✗ ${printer.label} attempt ${attempt}/3: ${err.message}`);
            if (attempt < 3) await sleep(2000 * attempt);
          }
        }
        throw new Error(`${printer.label} (${printer.ip}): ${lastErr}`);
      })
    );

    // A skipped printer (no matching items) resolves with undefined — not a failure.
    const actualAttempts = results.filter((r) => !(r.status === 'fulfilled' && r.value === undefined));
    const allFailed = actualAttempts.length > 0 && actualAttempts.every((r) => r.status === 'rejected');
    const errors    = results
      .filter((r) => r.status === 'rejected')
      .map((r) => r.reason?.message || 'unknown error');

    if (errors.length > 0) {
      console.error(`[Print] ✗ ${errors.length}/${printers.length} printer(s) failed: ${errors.join(' | ')}`);
    }

    if (!allFailed) {
      // At least one printer succeeded — ACK the job
      if (printJobId) {
        try {
          await apiPost(cfg, `/print-jobs/${printJobId}/ack`);
          console.log(`[Print] ✓ ACK sent for job ${printJobId}`);
        } catch (ackErr) {
          console.error(`[Print] ACK failed for job ${printJobId}: ${ackErr.message}`);
        }
      }
    } else {
      // Every printer failed — reset so the next poll retries
      console.error(`[Print] ✗ All printers failed for order ${order.orderNumber ?? order.id}`);
      if (printJobId) {
        try {
          await apiPost(cfg, `/print-jobs/${printJobId}/reset`);
          console.log(`[Print] Job ${printJobId} reset to pending for future retry`);
        } catch (resetErr) {
          console.error(`[Print] Could not reset job ${printJobId}: ${resetErr.message}`);
        }
      }
    }

    _inFlight.delete(printJobId);
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

        // Receipt is built per-printer inside the queue processor
        _inFlight.add(job._id);
        queue.enqueue({ order, receipt: null, printJobId: job._id });
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
      auth:         { apiKey: cfg.WS_API_KEY, branchId: cfg.BRANCH_ID, stationId: cfg.STATION_ID },
      query:        { branchId: cfg.BRANCH_ID, stationId: cfg.STATION_ID },
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

        // printJobId is attached by the backend so we can ACK after print
        const printJobId = payload?.printJobId || null;

        // Register in-flight so the sync poll doesn't re-enqueue this job
        if (printJobId) _inFlight.add(printJobId);

        // Receipt is built per-printer inside the queue processor
        queue.enqueue({ order, receipt: null, printJobId });
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
  cfg.PRINTERS.forEach((p, i) =>
    console.log(`  Printer ${i + 1} : ${p.label} — ${p.ip}:${p.port} (${p.paperWidth === 32 ? '58mm' : '80mm'})`)
  );
  console.log(`  Backend : ${cfg.BACKEND_URL}`);
  console.log(`  Branch  : ${cfg.BRANCH_ID}`);
  console.log(`  Station : ${cfg.STATION_ID || 'ALL'}`);
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
