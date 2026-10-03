const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, ipcMain, shell, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const dataFolder = path.join(process.env.USERPROFILE || os.homedir(), '.agent-phone');
const runtimeFile = path.join(dataFolder, 'hub-runtime.json');
const settingsFile = path.join(dataFolder, 'desktop-settings.json');
let window, tray, hubChild, hubInfo, owned = false, quitting = false, ready = false;
let awakeId = null, desktopSettings = { keepAwake: true };
try { desktopSettings = { ...desktopSettings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch {}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();

function request(info, route, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, info.url), {
      method, headers: { 'x-agent-phone-token': info.token }, timeout: 2500,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode >= 400) throw new Error(body.error || `HTTP ${res.statusCode}`);
          resolve(body);
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('后台服务连接超时')));
    req.on('error', reject);
    req.end();
  });
}

async function existingHub() {
  try {
    const info = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url) || typeof info.token !== 'string') return null;
    const state = await request(info, '/api/state');
    return { ...info, state };
  } catch { return null; }
}

async function startHub() {
  const runtimeRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.join(__dirname, '..', '.cache', 'package-runtime');
  const node = path.join(runtimeRoot, 'node.exe');
  const server = app.isPackaged ? path.join(runtimeRoot, 'hub', 'server.mjs') : path.join(__dirname, '..', 'hub', 'server.mjs');
  if (!fs.existsSync(node)) throw new Error('缺少内置运行环境。源码开发请先运行 npm run desktop:prepare。');
  const {getSourceId} = require(path.join(path.dirname(server),'source-id.cjs'));
  const serverHash = getSourceId(path.dirname(server));
  hubInfo = await existingHub();
  if (hubInfo?.serverHash === serverHash) return;
  if (hubInfo) {
    const active = (hubInfo.state.sessions || []).some(session => ['running','waiting'].includes(session.status) && (session.managedRunning || session.source === 'hub'));
    const waiting = (hubInfo.state.requests || []).some(item => ['pending','responding'].includes(item.status));
    if (active || waiting) throw new Error('已有旧版后台服务正在执行任务或等待回复。请先完成或停止这些任务，再打开新版程序。');
    await request(hubInfo,'/api/shutdown','POST');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && await existingHub()) await new Promise(resolve => setTimeout(resolve,150));
    if (await existingHub()) throw new Error('旧版后台服务没有正常退出。请先从旧工作台退出，再打开新版。');
    hubInfo = null;
  }
  fs.mkdirSync(dataFolder, { recursive: true });
  const stdout = fs.openSync(path.join(dataFolder, 'hub.stdout.log'), 'a');
  const stderr = fs.openSync(path.join(dataFolder, 'hub.stderr.log'), 'a');
  try {
    hubChild = spawn(node, [server], {
      cwd: path.dirname(server), windowsHide: true,
      env: { ...process.env, AGENT_PHONE_DESKTOP: '1' }, stdio: ['ignore', stdout, stderr],
    });
    owned = true;
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  let failure;
  hubChild.on('error', error => { failure = error; });
  hubChild.on('exit', code => {
    failure ||= new Error(`后台服务已退出（${code}）。请查看数据目录中的 hub.stderr.log。`);
    if (ready && !quitting) {
      tray?.setToolTip('Agent Phone · 后台服务已停止');
      dialog.showErrorBox('Agent Phone 后台服务停止', failure.message);
    }
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const info = await existingHub();
    if (info && info.pid === hubChild.pid) { hubInfo = info; return; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('后台服务启动超时。请查看数据目录中的 hub.stderr.log。');
}

function openWindow() {
  if (!hubInfo) return;
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    title: 'Agent Phone', width: 1320, height: 880, minWidth: 960, minHeight: 650,
    backgroundColor: '#f4f6fa', icon: path.join(__dirname, 'assets', 'icon.png'), show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, devTools: !app.isPackaged,
    },
  });
  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => { window.show(); });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(hubInfo.url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(hubInfo.url + '/')) event.preventDefault();
  });
  void window.loadURL(hubInfo.url + '/');
}

function settings() {
  return {
    autostart: app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin,
    keepAwake: desktopSettings.keepAwake !== false,
    packaged: app.isPackaged, version: app.getVersion(), dataFolder,
  };
}

function setKeepAwake(enabled) {
  desktopSettings.keepAwake = enabled;
  fs.mkdirSync(dataFolder, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(desktopSettings, null, 2));
  if (awakeId !== null && powerSaveBlocker.isStarted(awakeId)) powerSaveBlocker.stop(awakeId);
  awakeId = enabled ? powerSaveBlocker.start('prevent-app-suspension') : null;
  rebuildTray(); return settings();
}

function registerIpc() {
  function trusted(event) {
    const url = event.senderFrame?.url;
    if (!hubInfo || !url?.startsWith(hubInfo.url + '/')) throw new Error('请求来源无效。');
  }
  ipcMain.handle('agent-phone:pick', async (event, kind) => {
    trusted(event);
    if (!['folder', 'files', 'executable'].includes(kind)) throw new Error('不支持的选择器。');
    const result = await dialog.showOpenDialog(window, {
      title: kind === 'folder' ? '选择项目文件夹' : kind === 'executable' ? '选择 Agent 程序或脚本' : '选择任务文件',
      properties: kind === 'folder' ? ['openDirectory'] : kind === 'executable' ? ['openFile'] : ['openFile', 'multiSelections'],
      ...(kind === 'executable' ? { filters: [{ name: '程序与脚本', extensions: ['exe', 'cmd', 'bat', 'ps1', 'js', 'py'] }, { name: '所有文件', extensions: ['*'] }] } : {}),
    });
    return { paths: result.canceled ? [] : result.filePaths };
  });
  ipcMain.handle('agent-phone:settings', event => { trusted(event); return settings(); });
  ipcMain.handle('agent-phone:autostart', (event, enabled) => {
    trusted(event);
    if (typeof enabled !== 'boolean') throw new Error('启动设置无效。');
    if (!app.isPackaged) throw new Error('请在安装后的程序中设置开机启动。');
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] });
    rebuildTray();
    return settings();
  });
  ipcMain.handle('agent-phone:data-folder', event => {
    trusted(event); fs.mkdirSync(dataFolder, { recursive: true }); return shell.openPath(dataFolder);
  });
  ipcMain.handle('agent-phone:keep-awake', (event, enabled) => {
    trusted(event); if (typeof enabled !== 'boolean') throw new Error('保持唤醒设置无效。');
    return setKeepAwake(enabled);
  });
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Agent Phone', click: openWindow },
    { label: '登录 Windows 后自动启动', type: 'checkbox', checked: settings().autostart, enabled: app.isPackaged,
      click: item => { app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: ['--hidden'] }); rebuildTray(); } },
    { label: '运行期间防止电脑自动休眠', type: 'checkbox', checked: settings().keepAwake, click: item => { setKeepAwake(item.checked); } },
    { label: '打开日志和数据目录', click: () => { void shell.openPath(dataFolder); } },
    { type: 'separator' },
    { label: owned ? '退出并停止后台任务' : '退出桌面程序（已有后台服务继续运行）', click: () => { app.quit(); } },
  ]));
}

app.on('second-instance', () => { openWindow(); });
app.on('activate', openWindow);
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  void (async () => {
    if (owned && hubInfo) {
      try { await request(hubInfo, '/api/shutdown', 'POST'); } catch {}
      const deadline = Date.now() + 5000;
      while (hubChild && hubChild.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (hubChild?.exitCode === null) {
        // This PID was created by this application. Stop its owned process
        // tree if a stuck Agent prevents the Hub's graceful shutdown.
        await new Promise(resolve => {
          const killer = spawn('taskkill.exe', ['/PID', String(hubChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { hubChild.kill(); resolve(); });
          killer.once('close', resolve);
        });
      }
    }
    if (awakeId !== null && powerSaveBlocker.isStarted(awakeId)) powerSaveBlocker.stop(awakeId);
    tray?.destroy(); app.quit();
  })();
});

if (lock) app.whenReady().then(async () => {
  try {
    await startHub();
    registerIpc();
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')));
    tray.setToolTip('Agent Phone · 关闭窗口后继续运行');
    tray.on('double-click', openWindow); setKeepAwake(desktopSettings.keepAwake !== false); ready = true;
    if (!process.argv.includes('--hidden')) openWindow();
  } catch (error) {
    dialog.showErrorBox('Agent Phone 无法启动', error.message);
    if (owned) hubChild?.kill(); quitting = true; app.quit();
  }
});
