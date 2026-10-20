import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { join, basename } from 'node:path';
import { mkdir, readFile, stat } from 'node:fs/promises';
import {
  ProjectTrustStore,
  hasTrustRequiringProjectResources,
} from '@earendil-works/pi-coding-agent';
import { PluginManager } from '../plugins/manager.js';
import { AgentHost } from '../agent/agent-host.js';
import { saveModelConfig } from '../models/model-config.js';
import { isWorkspacePermission } from '../workspace/permissions.js';
import type {
  IpcResult,
  ImageAttachment,
  FileAttachment,
  ModelConfigInput,
  ThinkingLevel,
} from '../../shared/types.js';

/** 所有能力只经声明通道开放；来源、参数和所选路径在主进程统一检查。 */
export function registerAgentIpc(
  host: AgentHost,
  getWindow: () => BrowserWindow | undefined,
  page: string,
  isExiting: () => boolean,
  onDraft: (present: boolean) => void,
): void {
  const allowedProjects = new Set<string>();
  const selectedFiles = new Map<string, FileAttachment>();
  function senderAllowed(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
    return Boolean(
      getWindow() &&
        !getWindow()!.isDestroyed() &&
        event.sender === getWindow()!.webContents &&
        event.senderFrame === getWindow()!.webContents.mainFrame &&
        event.senderFrame?.url === page,
    );
  }
  function handle<T extends unknown[], R>(
    channel: string,
    fn: (...args: T) => Promise<R> | R,
  ): void {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<R>> => {
      if (!senderAllowed(event) || isExiting())
        return { ok: false, error: '客户端尚未就绪或正在退出' };
      try {
        return { ok: true, value: await fn(...(args as T)) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '操作失败' };
      }
    });
  }
  function string(value: unknown, label: string, max = 10000): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      throw new Error(`${label}无效`);
  }
  async function trust(cwd: string): Promise<boolean> {
    const store = new ProjectTrustStore(host.agentDir);
    const known = store.get(cwd);
    if (known !== null) return known;
    if (!hasTrustRequiringProjectResources(cwd)) return true;
    const { response } = await dialog.showMessageBox(getWindow()!, {
      type: 'question',
      title: '项目信任',
      message: `信任此项目的扩展和配置？`,
      detail: `${cwd}\n\n此目录含有可执行的项目资源。信任仅沿用 Pi 的资源加载规则，不代表工作区沙箱。`,
      buttons: ['不信任', '信任此项目'],
      defaultId: 0,
      cancelId: 0,
    });
    store.set(cwd, response === 1);
    return response === 1;
  }
  handle('agent:initialize', async () => {
    // 专用目录使普通对话无需先授权整个用户目录或选择项目。
    const defaultCwd = join(app.getPath('userData'), 'workspace');
    await mkdir(defaultCwd, { recursive: true });
    allowedProjects.add(defaultCwd);
    const sessions = await host.list();
    try {
      return { sessions, models: await host.models(), configDirectory: host.agentDir, defaultCwd };
    } catch (error) {
      return {
        sessions,
        defaultCwd,
        models: [],
        configDirectory: host.agentDir,
        modelError: error instanceof Error ? error.message : '模型配置加载失败',
      };
    }
  });
  const plugins = () => new PluginManager(host.agentDir, join(app.getPath('userData'), 'workspace'));
  let installingPlugin = false;
  handle('agent:plugins', () => plugins().list());
  handle('agent:plugin-enabled', async (path: unknown, kind: unknown, enabled: unknown) => {
    string(path, '资源路径', 4000);
    if ((kind !== 'extension' && kind !== 'skill') || typeof enabled !== 'boolean') throw new Error('开关参数无效');
    if (host.active || installingPlugin) throw new Error('请等待当前任务或配置更新结束');
    installingPlugin = true;
    try { return await plugins().setEnabled(path as string, kind, enabled); }
    finally { installingPlugin = false; }
  });
  handle('agent:install-plugin', async (source: unknown, kind: unknown) => {
    string(source, '安装来源', 2000);
    if (kind !== 'package' && kind !== 'skill') throw new Error('安装类型无效');
    if (host.active || installingPlugin) throw new Error('请等待当前任务或安装结束');
    installingPlugin = true;
    try { return await plugins().install(source, kind); }
    finally { installingPlugin = false; }
  });
  handle('agent:plugin-source', async (kind: unknown) => {
    if (kind !== 'package' && kind !== 'skill') throw new Error('安装类型无效');
    const result = await dialog.showOpenDialog(getWindow()!, {
      title: kind === 'skill' ? '选择包含 SKILL.md 的目录' : '选择 Pi 插件或资源包目录',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('agent:select-project', async () => {
    const result = await dialog.showOpenDialog(getWindow()!, {
      title: '选择 Agent 的工作目录',
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    const cwd = result.filePaths[0];
    allowedProjects.add(cwd);
    return cwd;
  });
  handle('agent:create', async (cwd: unknown) => {
    if (installingPlugin) throw new Error('请等待插件安装结束');
    string(cwd, '项目目录');
    if (!allowedProjects.has(cwd)) throw new Error('请通过目录选择器选择项目');
    return host.create(cwd, await trust(cwd));
  });
  handle('agent:open', async (id: unknown) => {
    string(id, '会话 ID', 256);
    if (installingPlugin) throw new Error('请等待插件安装结束');
    const view = await host.open(id, trust);
    // 历史目录已由主进程解析并完成信任检查；重启续接后也应允许在同一项目新建会话。
    allowedProjects.add(view.cwd);
    return view;
  });
  // 管理操作仅接收会话 ID；实际路径由主进程从 Pi 历史目录解析，界面不能指定删除路径。
  handle('agent:rename', async (id: unknown, name: unknown) => {
    string(id, '会话 ID', 256);
    string(name, '会话名称', 120);
    await host.rename(id, name);
  });
  handle('agent:delete', async (id: unknown) => {
    string(id, '会话 ID', 256);
    await host.delete(id);
  });
  handle('agent:fork', async (id: unknown) => {
    string(id, '会话 ID', 256);
    return host.fork(id);
  });
  handle('agent:complete', async (id: unknown, prefix: unknown) => {
    string(id, '会话 ID', 256);
    string(prefix, '命令前缀', 2000);
    if (!/^\/[^\r\n]*$/.test(prefix)) throw new Error('命令前缀无效');
    return host.complete(id, prefix);
  });
  handle('agent:send', async (id: unknown, text: unknown, images: unknown, files: unknown) => {
    string(id, '会话 ID', 256);
    if (
      typeof text !== 'string' ||
      text.length > 2_000_000 ||
      !Array.isArray(images) ||
      images.length > 10 ||
      !Array.isArray(files) ||
      files.length > 20
    )
      throw new Error('任务或附件格式无效');
    for (const image of images as ImageAttachment[])
      if (
        !image ||
        typeof image.data !== 'string' ||
        image.data.length > 14_000_000 ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)
      )
        throw new Error('图片格式或大小无效');
    for (const file of files as FileAttachment[])
      if (!file || !selectedFiles.has(file.path)) throw new Error('附件必须通过文件选择器添加');
    if (installingPlugin) throw new Error('请等待插件安装结束');
    await host.send(id, text, images as ImageAttachment[], files as FileAttachment[]);
  });
  handle('agent:stop', async (id: unknown) => {
    string(id, '会话 ID', 256);
    await host.stop(id);
  });
  handle('agent:shortcut', async (id: unknown, key: unknown) => {
    string(id, '会话 ID', 256);
    string(key, '快捷键', 100);
    await host.shortcut(id, key);
  });
  handle('agent:model', async (id: unknown, provider: unknown, model: unknown) => {
    string(id, '会话 ID', 256);
    string(provider, '提供商', 256);
    string(model, '模型', 256);
    return host.setModel(id, provider, model);
  });
  handle('agent:permission', async (id: unknown, value: unknown) => {
    string(id, '会话 ID', 256);
    if (!isWorkspacePermission(value)) throw new Error('无效的工作区权限');
    return host.setPermission(id, value);
  });
  handle('agent:thinking', (id: unknown, value: unknown) => {
    string(id, '会话 ID', 256);
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value as string))
      throw new Error('无效的思考级别');
    return host.setThinking(id, value as ThinkingLevel);
  });
  handle('agent:models', () => host.models(true));
  handle('agent:save-model', async (config: ModelConfigInput) => {
    if (host.active) throw new Error('请等待任务结束后保存模型配置');
    await saveModelConfig(host.agentDir, config);
    return host.models(true);
  });
  handle('agent:attachments', async () => {
    const result = await dialog.showOpenDialog(getWindow()!, {
      title: '添加文件或图片',
      properties: ['openFile', 'multiSelections'],
    });
    const images: ImageAttachment[] = [],
      files: FileAttachment[] = [];
    if (result.canceled) return { images, files };
    if (result.filePaths.length > 20) throw new Error('一次最多添加 20 个附件');
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
    };
    for (const file of result.filePaths) {
      const name = basename(file),
        mimeType = mimeTypes[name.split('.').pop()!.toLowerCase()];
      if (mimeType) {
        if ((await stat(file)).size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB');
        images.push({ name, mimeType, data: (await readFile(file)).toString('base64') });
      } else {
        const item = { path: file, name };
        selectedFiles.set(file, item);
        files.push(item);
      }
    }
    return { images, files };
  });
  ipcMain.on('agent:draft', (event, present) => {
    if (senderAllowed(event)) onDraft(present === true);
  });
}
