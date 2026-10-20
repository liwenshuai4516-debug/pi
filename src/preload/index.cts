import { contextBridge, ipcRenderer } from 'electron';
import type { AgentClientApi, IpcResult, SessionSummary, SessionView } from '../shared/types.js';
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
const api: AgentClientApi = {
  initialize: () => invoke('agent:initialize'),
  listPlugins: () => invoke('agent:plugins'),
  setPluginEnabled: (path, kind, enabled) => invoke('agent:plugin-enabled', path, kind, enabled),
  installPlugin: (source, kind) => invoke('agent:install-plugin', source, kind),
  choosePluginSource: (kind) => invoke('agent:plugin-source', kind),
  selectProject: () => invoke('agent:select-project'),
  createSession: (cwd) => invoke('agent:create', cwd),
  openSession: (id) => invoke('agent:open', id),
  renameSession: (id, name) => invoke('agent:rename', id, name),
  deleteSession: (id) => invoke('agent:delete', id),
  forkSession: (id) => invoke('agent:fork', id),
  send: (id, text, images, files) => invoke('agent:send', id, text, images, files),
  stop: (id) => invoke('agent:stop', id),
  shortcut: (id, key) => invoke('agent:shortcut', id, key),
  complete: (id, prefix) => invoke('agent:complete', id, prefix),
  setModel: (id, provider, modelId) => invoke('agent:model', id, provider, modelId),
  setPermission: (id, permission) => invoke('agent:permission', id, permission),
  setThinking: (id, thinking) => invoke('agent:thinking', id, thinking),
  saveModel: (input) => invoke('agent:save-model', input),
  refreshModels: () => invoke('agent:models'),
  chooseAttachments: () => invoke('agent:attachments'),
  onSession: (callback) => subscribe<SessionView>('agent:session', callback),
  onSessionsChanged: (callback) => subscribe<SessionSummary[]>('agent:sessions', callback),
  reportDraft: (present) => ipcRenderer.send('agent:draft', present === true),
};
contextBridge.exposeInMainWorld('agentClient', Object.freeze(api));
