import { initializeContentPackages } from './content-package-store';
import { initializeResourceDirectory } from './resource-directory-config';
import { readInstallerBaseSelection, installSelectedBasePackage, clearInstallerBaseSelection } from './installer-base';
import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, dialog, nativeImage, screen } from 'electron';
import { is, optimizer } from '@electron-toolkit/utils';
import { registerIpc } from './ipc';
import { openProgressDb, closeProgressDb } from './progress-db';
import { openContentDb, closeContentDb } from './content-db';

const iconDir = app.isPackaged
  ? path.join(process.resourcesPath, 'icons')
  : path.join(app.getAppPath(), 'resources');
const icon = path.join(iconDir, 'icon.png');
const windowsIcon = path.join(iconDir, 'icon.ico');

const appId = 'com.genshinwords.app';
function createWindow(openContentManager = false) {
  const iconPath = process.platform === 'win32' ? windowsIcon : icon;
  const windowIcon = nativeImage.createFromPath(iconPath);
  const available = screen.getPrimaryDisplay().workAreaSize;
  const mainWindow = new BrowserWindow({
    width: Math.min(1024, available.width),
    height: Math.min(760, available.height),
    minWidth: Math.min(720, available.width),
    minHeight: Math.min(520, available.height),
    show: false,
    autoHideMenuBar: true,
    title: 'GenshinWords',
    backgroundColor: '#101c2b',
    icon: windowIcon,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: false,
    },
  });
  if (process.platform === 'win32') {
    const portableLauncher = process.env.PORTABLE_EXECUTABLE_FILE;
    const portablePath =
      portableLauncher && fs.existsSync(portableLauncher) ? portableLauncher : undefined;
    const launcher = portablePath || process.execPath;
    const relaunchCommand =
      !app.isPackaged && !portablePath
        ? `"${launcher}" "${app.getAppPath()}"`
        : `"${launcher}"`;
    mainWindow.setAppDetails({
      appId,
      appIconPath: portablePath || iconPath,
      appIconIndex: 0,
      relaunchCommand,
      relaunchDisplayName: 'GenshinWords',
    });
    mainWindow.setIcon(windowIcon);
  }
  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (!is.dev) {
    mainWindow.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), openContentManager ? { hash: 'content' } : undefined);
  }
}

function createResourceSetupWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 540, height: 240, resizable: false, autoHideMenuBar: true,
    title: 'GenshinWords · 准备基础素材', backgroundColor: '#101c2b',
    icon: nativeImage.createFromPath(process.platform === 'win32' ? windowsIcon : icon),
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>' +
    'body{background:#101c2b;color:#e8d6ad;font-family:system-ui,"Microsoft YaHei",sans-serif;' +
    'margin:30px;line-height:1.7}h1{font-size:23px;margin:0 0 13px}p{color:#f3f0e9;font-size:15px}' +
    '</style><h1>正在准备基础素材</h1><p>软件正在检查安装时选择的资源包，并载入本机。首次载入可能需要几分钟。</p>' +
    '<p>完成后会自动打开学习界面。</p></html>';
  window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  return window;
}

async function finishInstallerResourceSelection(window: BrowserWindow, selected: string): Promise<'loaded' | 'manual' | 'quit'> {
  let file = selected;
  for (;;) {
    try { await installSelectedBasePackage(file); return 'loaded'; }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const choice = dialog.showMessageBoxSync(window, {
        type: 'warning', title: '基础素材载入失败', message: '所选基础素材包无法使用',
        detail: detail + '\n可以重新选择完整的基础素材包，或进入内容管理修复。',
        buttons: ['重新选择', '进入内容管理', '退出软件'], defaultId: 0, cancelId: 1,
      });
      if (choice === 2) { app.quit(); return 'quit'; }
      if (choice === 1) { clearInstallerBaseSelection(); return 'manual'; }
      const files = dialog.showOpenDialogSync(window, {
        title: '选择完整基础素材包', properties: ['openFile'],
        filters: [{ name: '基础素材包', extensions: ['gwcontent'] }],
      });
      if (files?.[0]) file = files[0];
    }
  }
}
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId(appId);
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });
  let installerSelection: string | null = null;
  let selectionError: unknown = null;
  try { installerSelection = readInstallerBaseSelection(); }
  catch (error) { selectionError = error; }
  const setupWindow = installerSelection || selectionError ? createResourceSetupWindow() : null;
  try { await initializeResourceDirectory(); } catch (error) { console.error('资源目录初始化失败，可在内容管理中重新指定：', error); }
  try { await initializeContentPackages(); } catch (error) { console.error('内容包初始化失败，可在内容管理中修复：', error); }
  let openContentManager = false;
  if (setupWindow && selectionError) {
    const detail = selectionError instanceof Error ? selectionError.message : String(selectionError);
    dialog.showMessageBoxSync(setupWindow, { type: 'warning', title: '基础素材选择记录异常',
      message: '无法读取安装时选择的基础素材包', detail: detail + '\n请到内容管理重新选择资源。', buttons: ['打开内容管理'] });
    try { clearInstallerBaseSelection(); }
    catch (error) { console.error('无法清除损坏的安装素材选择记录：', error); }
    openContentManager = true;
  } else if (setupWindow && installerSelection) {
    const result = await finishInstallerResourceSelection(setupWindow, installerSelection);
    if (result === 'quit') return;
    openContentManager = result === 'manual';
  }
  openProgressDb();
  try { openContentDb(); } catch (error) { console.error('基础资料暂不可用，请在内容管理中修复：', error); }
  registerIpc();
  createWindow(openContentManager);
  setupWindow?.close();
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
app.on('before-quit', () => {
  closeContentDb();
  closeProgressDb();
});
