import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AgentHost } from './agent/agent-host.js';
import { registerAgentIpc } from './ipc/register.js';

const here = dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(join(here, '../renderer/index.html')).href;
if (process.env.PI_AGENT_TEST_USER_DATA)
  app.setPath('userData', resolve(process.env.PI_AGENT_TEST_USER_DATA));
app.setName('Pi Agent');
let window: BrowserWindow | undefined;
let drafts = false,
  quitting = false,
  exiting = false;
const host = new AgentHost(
  (view) => {
    window?.webContents.send('agent:session', view);
  },
  (sessions) => window?.webContents.send('agent:sessions', sessions),
);
registerAgentIpc(
  host,
  () => window,
  page,
  () => exiting,
  (present) => {
    drafts = present;
  },
);
async function requestQuit(): Promise<void> {
  if (exiting) return;
  exiting = true;
  if (drafts || host.active) {
    const { response } = await dialog.showMessageBox(window!, {
      type: 'question',
      message: '退出 Pi Agent？',
      detail: '有未发送的草稿或运行中的任务。退出会停止当前任务。',
      buttons: ['取消', '停止任务并退出'],
      cancelId: 0,
      defaultId: 0,
    });
    if (response !== 1) {
      exiting = false;
      return;
    }
  }
  let timedOut = false;
  const disposal = host.dispose();
  let timer: ReturnType<typeof setTimeout>;
  await Promise.race([
    disposal,
    new Promise<void>((done) => {
      timer = setTimeout(() => {
        timedOut = true;
        done();
      }, 12000);
    }),
  ]);
  clearTimeout(timer!);
  if (timedOut) {
    const { response } = await dialog.showMessageBox(window!, {
      type: 'warning',
      message: '任务清理尚未结束',
      detail: '第三方扩展或工具仍可能在退出中。',
      buttons: ['继续等待', '强制退出'],
      defaultId: 0,
    });
    if (response === 0) await disposal;
  }
  quitting = true;
  app.quit();
}
function createWindow(): void {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 840,
    minHeight: 620,
    title: 'Pi Agent',
    backgroundColor: '#f8f6f1',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== page) {
      event.preventDefault();
      openExternal(url);
    }
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      void requestQuit().catch(showFailure);
    }
  });
  void window.loadFile(fileURLToPath(page));
}
function openExternal(raw: string): void {
  try {
    const url = new URL(raw);
    if (['https:', 'http:'].includes(url.protocol)) void shell.openExternal(url.href);
  } catch {
    /* unknown protocol rejected */
  }
}
function showFailure(error: unknown): void {
  exiting = false;
  dialog.showErrorBox('Pi Agent', error instanceof Error ? error.message : '客户端发生错误');
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(() => {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Pi Agent',
            submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
      );
      createWindow();
    })
    .catch(showFailure);
  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault();
      void requestQuit().catch(showFailure);
    }
  });
  app.on('window-all-closed', () => {
    if (!quitting) void requestQuit().catch(showFailure);
  });
}
