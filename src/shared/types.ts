export type WorkspacePermission = 'read-only' | 'workspace' | 'full-access';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ModelChoice {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}
export interface ContentBlock {
  type: 'text' | 'thinking' | 'toolCall' | 'image';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}
export interface ChatMessage {
  role: string;
  content: string | ContentBlock[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  errorMessage?: string;
  stopReason?: string;
}
export interface SessionSummary {
  id: string;
  cwd: string;
  name: string;
  modified: string;
  running: boolean;
}
export interface ToolProgress {
  id: string;
  name: string;
  args: unknown;
  output: string;
  status: 'running' | 'done' | 'error';
}
export interface SessionView {
  id: string;
  cwd: string;
  name: string;
  messages: ChatMessage[];
  tools: ToolProgress[];
  model: ModelChoice | null;
  thinking: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  permission: WorkspacePermission;
  running: boolean;
  error: string | null;
  warning: string | null;
  templates: { name: string; description: string }[];
}
export interface ImageAttachment {
  name: string;
  mimeType: string;
  data: string;
}
export interface FileAttachment {
  name: string;
  path: string;
}
export interface ModelConfigInput {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  reasoning?: boolean;
}
export interface InitialState {
  sessions: SessionSummary[];
  models: ModelChoice[];
  configDirectory: string;
  modelError?: string;
}
export interface AgentClientApi {
  initialize(): Promise<InitialState>;
  selectProject(): Promise<string | null>;
  createSession(cwd: string): Promise<SessionView>;
  openSession(id: string): Promise<SessionView>;
  renameSession(id: string, name: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  forkSession(id: string): Promise<string>;
  send(id: string, text: string, images: ImageAttachment[], files: FileAttachment[]): Promise<void>;
  stop(id: string): Promise<void>;
  setModel(id: string, provider: string, modelId: string): Promise<SessionView>;
  setPermission(id: string, permission: WorkspacePermission): Promise<SessionView>;
  setThinking(id: string, thinking: ThinkingLevel): Promise<SessionView>;
  saveModel(config: ModelConfigInput): Promise<ModelChoice[]>;
  refreshModels(): Promise<ModelChoice[]>;
  chooseAttachments(): Promise<{ images: ImageAttachment[]; files: FileAttachment[] }>;
  onSession(callback: (view: SessionView) => void): () => void;
  onSessionsChanged(callback: (sessions: SessionSummary[]) => void): () => void;
  reportDraft(present: boolean): void;
}
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };
declare global {
  interface Window {
    agentClient: AgentClientApi;
  }
}
