# KDS Print Bridge

Runs on the laptop connected to your LAN thermal printer. Listens for new orders from the backend via WebSocket and silently prints receipts — no browser, no popup, no manual steps.

## Architecture

```
Any Device → Backend (Render) → WebSocket → Print Bridge (this) → TCP:9100 → Printer
```

## Setup

### 1. Install Node.js
Download from https://nodejs.org (v18 or later).

### 2. Install dependencies
```bash
npm install
```

### 3. Configure
Copy `.env.example` to `.env` and fill in your values:

```bash
copy .env.example .env
```

```env
BACKEND_URL=https://your-backend.onrender.com
WS_API_KEY=<api_key_from_printer_settings>
BRANCH_ID=<your_branch_id>
PRINTER_IP=192.168.100.100
PRINTER_PORT=9100
RESTAURANT_NAME=MY RESTAURANT
PRINT_ORDER_TYPES=          # leave empty to print all, or e.g. KDS,DineIn
RECEIPT_WIDTH=32            # 32 for 58mm paper, 48 for 80mm paper
```

### 4. Get an API Key
Go to **Settings → Printer Settings** in the ERP frontend.
Click **Generate API Key**, copy the key, and paste it into `.env` as `WS_API_KEY`.

> The key is shown only once. If you lose it, regenerate from the same settings page.

### 5. Run
```bash
npm start
```

You should see:
```
─────────────────────────────────────────
  KDS Print Bridge
  Printer : 192.168.100.100:9100
  Backend : https://your-backend.onrender.com
  Branch  : <branch_id>
  Filter  : ALL
─────────────────────────────────────────
[WS] Connecting to https://your-backend.onrender.com ...
[WS] ✓ Connected (socket: abc123)
```

### 6. Test receipt (no printer needed)
```bash
node test-receipt.js
```

## Running as a background service (Windows)

Install [PM2](https://pm2.keymetrics.io/) to keep the bridge running after reboot:

```bash
npm install -g pm2
pm2 start src/index.js --name kds-print-bridge
pm2 save
pm2 startup
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `WS_AUTH_TOKEN is required` | Add token to `.env` |
| `Printer connection timed out` | Check printer IP/port, ensure printer is on same LAN |
| `Authentication error` from WS | Token expired or invalid — generate a new one |
| Orders not printing | Check `PRINT_ORDER_TYPES` filter — leave empty to print all |
| Receipt text garbled | Try `RECEIPT_WIDTH=48` for 80mm paper |

## Receipt width guide

| Paper width | `RECEIPT_WIDTH` |
|---|---|
| 58 mm | 32 |
| 80 mm | 48 |
