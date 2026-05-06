/**
 * printer.js — ESC/POS receipt formatter + TCP sender
 */

const net = require('net');

// ── ESC/POS commands ──────────────────────────────────────────────────────────
const ESC = '\x1B';
const GS  = '\x1D';

const CMD = {
  INIT:         ESC + '\x40',
  ALIGN_LEFT:   ESC + '\x61\x00',
  ALIGN_CENTER: ESC + '\x61\x01',
  ALIGN_RIGHT:  ESC + '\x61\x02',
  BOLD_ON:      ESC + '\x45\x01',
  BOLD_OFF:     ESC + '\x45\x00',
  DOUBLE_SIZE:  GS  + '\x21\x11',
  NORMAL_SIZE:  GS  + '\x21\x00',
  FEED:         ESC + '\x64\x04',
  CUT:          GS  + '\x56\x00',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const W = 48; // chars for 80mm paper (use 32 for 58mm)

function twoCol(left, right) {
  const l = String(left);
  const r = String(right);
  const gap = Math.max(1, W - l.length - r.length);
  return l + ' '.repeat(gap) + r;
}

function dashed() {
  return '-'.repeat(W);
}

function now() {
  const d = new Date();
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh   = String(d.getHours()).padStart(2, '0');
  const min  = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

// ── Receipt builder ───────────────────────────────────────────────────────────

function buildReceipt(order, config = {}) {
  const width       = parseInt(config.width ?? W, 10);
  const tenantName  = (config.restaurantName ?? 'RESTAURANT').toUpperCase();
  const branchName  = (config.branchName ?? '').toUpperCase();
  const timestamp   = now();

  const lines = [];
  const p = (...parts) => lines.push(...parts);

  // ── Header ────────────────────────────────────────────────────────────────
  p(
    CMD.INIT,
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON,
    CMD.DOUBLE_SIZE,
    tenantName + '\n',
    CMD.NORMAL_SIZE,
  );

  if (branchName) {
    p(CMD.BOLD_ON, branchName + '\n', CMD.BOLD_OFF);
  }

  p(
    '\n',
    CMD.BOLD_ON,
    '[ KITCHEN ORDER ]\n',
    CMD.BOLD_OFF,
    CMD.ALIGN_LEFT,
    dashed() + '\n',
  );

  // ── Order meta ────────────────────────────────────────────────────────────
  p(
    CMD.ALIGN_RIGHT,
    timestamp + '\n',
    CMD.ALIGN_LEFT,
  );

  p(twoCol('ORDER NO', order.orderNumber ?? `#${order.id}`) + '\n');

  if (order.tableNumber) {
    p(twoCol('TABLE NO', order.tableNumber) + '\n');
  }

  const orderTypeLabel = (order.orderType ?? '')
    .replace(/([A-Z])/g, ' $1').trim();
  p(CMD.BOLD_ON, twoCol('ORDER TYPE', orderTypeLabel) + '\n', CMD.BOLD_OFF);

  p(dashed() + '\n');

  // ── Items header ──────────────────────────────────────────────────────────
  const QTY_W    = 4;
  const STATUS_W = 8;
  const ITEM_W   = width - QTY_W - STATUS_W - 2;

  const colHeader =
    'ITEM'.padEnd(ITEM_W) +
    'QTY'.padStart(QTY_W) +
    'STATUS'.padStart(STATUS_W + 2);

  p(CMD.BOLD_ON, colHeader + '\n', CMD.BOLD_OFF);
  p('='.repeat(width) + '\n');

  // ── Items ─────────────────────────────────────────────────────────────────
  const items = order.items ?? [];

  for (const item of items) {
    const qty    = item.quantity ?? item.qty ?? 1;
    const status = ['ready', 'dispatched', 'served'].includes(item.itemStatus)
      ? 'Done' : 'Pending';

    const name = String(item.name ?? 'Item').slice(0, ITEM_W);
    const row  = name.padEnd(ITEM_W) +
                 String(qty).padStart(QTY_W) +
                 status.padStart(STATUS_W + 2);
    p(row + '\n');

    const variants = (item.variants ?? [])
      .flatMap(v => (v.selectedOptions ?? []).map(o => o.optionName))
      .filter(Boolean);
    if (variants.length) {
      p('  (' + variants.join(', ') + ')\n');
    }

    for (const group of (item.addons ?? [])) {
      const names = (group.selectedItems ?? []).map(a => a.addonItemName).filter(Boolean);
      if (names.length) {
        p(`  ${group.addonGroupName}: ${names.join(', ')}\n`);
      }
    }
  }

  // ── Deals ─────────────────────────────────────────────────────────────────
  if (order.deals?.length) {
    p(dashed() + '\n');
    p(CMD.BOLD_ON, 'DEALS:\n', CMD.BOLD_OFF);
    for (const deal of order.deals) {
      p(`- ${deal.name}\n`);
      for (const it of (deal.items ?? [])) {
        p(`  • ${it}\n`);
      }
    }
  }

  // ── Kitchen notes ─────────────────────────────────────────────────────────
  if (order.kitchenNotes) {
    p(dashed() + '\n');
    p(CMD.BOLD_ON, 'NOTE:\n', CMD.BOLD_OFF);
    p(order.kitchenNotes + '\n');
  }

  // ── Status footer ─────────────────────────────────────────────────────────
  p(dashed() + '\n');
  p(
    CMD.BOLD_ON,
    twoCol('STATUS', (order.orderStatus ?? order.status ?? 'PREPARING').toUpperCase()) + '\n',
    CMD.BOLD_OFF,
    dashed() + '\n',
  );

  // ── Kitchen copy footer ───────────────────────────────────────────────────
  p(
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON,
    'KITCHEN COPY\n',
    CMD.BOLD_OFF,
    `Printed: ${timestamp}\n`,
    dashed() + '\n',
    CMD.ALIGN_LEFT,
    CMD.FEED,
    CMD.CUT,
  );

  return lines.join('');
}

// ── TCP sender ────────────────────────────────────────────────────────────────

function sendToPrinter(data, printerIp, printerPort = 9100, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(new Error(`Printer timed out (${printerIp}:${printerPort})`)));
    socket.on('error', finish);
    socket.connect(printerPort, printerIp, () => {
      socket.write(Buffer.from(data, 'binary'), () => finish());
    });
  });
}

module.exports = { buildReceipt, sendToPrinter };
