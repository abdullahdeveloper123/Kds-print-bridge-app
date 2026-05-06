/**
 * electron/main.js
 * First launch → shows native setup wizard.
 * Configured → runs silently as a system tray app.
 */

'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

let tray        = null;
let setupWindow = null;
let bridge      = null; // reference to { start, stop }

// ── Single instance ───────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (setupWindow) setupWindow.focus();
  else openSetupWindow();
});

// ── Config helpers ────────────────────────────────────────────────────────────
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function configExists() {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
    return !!(cfg.backendUrl && cfg.wsApiKey && cfg.branchId && cfg.printerIp);
  } catch {
    return false;
  }
}

// ── IPC ───────────────────────────────────────────────────────────────────────

// Renderer saves config → main writes to disk
ipcMain.handle('save-config', (_e, config) => {
  try {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Renderer signals setup is complete → close window, (re)start bridge
ipcMain.handle('close-setup', () => {
  if (setupWindow) { setupWindow.close(); setupWindow = null; }
  restartBridge();
});

// Renderer requests current config (for pre-filling on reconfigure)
ipcMain.handle('get-config', () => {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
  } catch {
    return {};
  }
});

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.setAppUserModelId('com.yumfood.kds-print-bridge');

  // Hide from macOS dock — tray-only app
  if (app.dock) app.dock.hide();

  // Enable auto-launch on Windows startup — only when running as a packaged app,
  // not during dev (dev would register the wrong electron.exe path)
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  }

  createTray();

  if (configExists()) {
    startBridgeService();
  } else {
    setTrayStatus('not_configured');
    openSetupWindow();
  }
});

// Keep alive in tray after all windows close
app.on('window-all-closed', () => { /* intentionally empty — tray keeps app alive */ });

app.on('before-quit', () => {
  if (bridge) bridge.stop();
});

// ── Setup window ──────────────────────────────────────────────────────────────
function openSetupWindow() {
  if (setupWindow) { setupWindow.focus(); return; }

  setupWindow = new BrowserWindow({
    width:       520,
    height:      620,
    resizable:   false,
    maximizable: false,
    title:       'KDS Print Bridge — Setup',
    icon:        path.join(__dirname, 'tray-icon.png'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'tray-icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('KDS Print Bridge');
  setTrayStatus('starting');

  // Double-click tray icon → open setup
  tray.on('double-click', () => openSetupWindow());
}

function setTrayStatus(status) {
  if (!tray) return;

  const label = {
    starting:       '⏳ Starting…',
    running:        '🟢 Connected — printing',
    disconnected:   '🔴 Disconnected — retrying…',
    not_configured: '⚙️  Not configured',
  }[status] || '⏳ Starting…';

  const menu = Menu.buildFromTemplate([
    { label: 'KDS Print Bridge',  enabled: false },
    { label,                      enabled: false },
    { type: 'separator' },
    { label: '⚙️  Reconfigure',   click: () => openSetupWindow() },
    { type: 'separator' },
    { label: '❌ Quit',           click: () => app.exit(0) },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`KDS Print Bridge — ${label}`);
}

// ── Bridge lifecycle ──────────────────────────────────────────────────────────

function startBridgeService() {
  setTrayStatus('starting');

  // Point config-server.js at the Electron userData directory
  process.env.CONFIG_DIR = app.getPath('userData');

  try {
    bridge = require('../src/index.js');
    bridge.start((status) => {
      setTrayStatus(status);
    });
  } catch (err) {
    console.error('[Main] Bridge failed to start:', err);
    setTrayStatus('disconnected');
    dialog.showErrorBox(
      'KDS Print Bridge',
      'Bridge failed to start:\n\n' + err.message +
      '\n\nCheck your configuration and try again.'
    );
  }
}

function restartBridge() {
  // Stop any running connection first
  if (bridge) {
    try { bridge.stop(); } catch (_) {}
  }
  // Small delay to let the socket close cleanly
  setTimeout(startBridgeService, 500);
}
