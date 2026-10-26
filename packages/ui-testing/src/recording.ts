import { randomUUID } from 'node:crypto';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Type, type Static } from 'typebox';
import { Ajv } from 'ajv';
import { ArtifactStore } from './store.js';
import { assertPortablePath, sha256, verifyReferences, workspacePath, WorkflowError } from './validation.js';
import { fileRefSchema, type Artifact, type FileRef } from './contracts.js';
import { authState, validateEnvironment } from './environment.js';

const id = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' });
export const recordingStartSchema = Type.Object({
  id, scope_ref: fileRefSchema, inventory_ref: fileRefSchema, initial_state_ref: fileRefSchema,
  data_rules_ref: fileRefSchema, seed_ref: fileRefSchema, output_file: Type.String({ minLength: 1 }),
  backend: Type.String({ pattern: '^mcp__[a-zA-Z0-9_]+__$' }), project: Type.String({ minLength: 1 }),
  max_steps: Type.Integer({ minimum: 1, maximum: 100 }), max_duration_ms: Type.Integer({ minimum: 100, maximum: 600000 }),
  max_no_progress: Type.Integer({ minimum: 2, maximum: 10 }),
  // 仅声明可公开的合成测试输入；认证由 seed/私有 storageState 完成，不在录制动作中输入秘密。
  test_data: Type.Array(Type.String({ minLength: 1 })),
  // 只冻结公开引用；宿主读取后准备私有副本，不能把认证内容写入会话。
  private_recording: Type.Optional(Type.Object({ environment_ref: fileRefSchema,
    input_refs: Type.Array(fileRefSchema, { minItems: 1, maxItems: 128 }) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type RecordingStart = Static<typeof recordingStartSchema>;
type Session = RecordingStart & { created_at: string; token: string };
type Outcome = { content: unknown[]; isError?: boolean; [key: string]: unknown };
type Request = { operation_id: string; created_at: string; tool: string; input: Record<string, unknown>; intent: string };
type Event = { request: Request; request_ref: FileRef; response?: Outcome; response_ref?: FileRef };
export type RecordingCall = { operation_id: string; tool: string; input: Record<string, unknown>; intent: string };
export type RecordingExecutor = (tool: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<Outcome>;
const ajv = new Ajv({ strict: true });
const validStart = ajv.compile(recordingStartSchema);
const emit = (input: unknown) => JSON.stringify(input, null, 2) + '\n';
const text = (outcome: Outcome) => outcome.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
export const recordingTools = ['generator_setup_page', 'generator_read_log', 'generator_write_test', 'browser_snapshot', 'browser_click',
  'browser_generate_locator', 'browser_type', 'browser_press_key', 'browser_select_option', 'browser_navigate', 'browser_verify_text_visible', 'browser_close'];

/** 仅做业务交接与限额；每次 execute 恰好调用一个现有 Pi/MCP 工具，不另建 Agent 循环。 */
export class RecordingService {
  readonly store: ArtifactStore;
  constructor(readonly projectRoot: string) { this.store = new ArtifactStore(projectRoot); }
  private base(id: string) { return `qa/ui/recordings/${id}`; }
  private async jsonRef(path: string): Promise<{ value: any; ref: FileRef }> {
    const bytes = await readFile(await workspacePath(this.projectRoot, path));
    return { value: JSON.parse(bytes.toString()), ref: { path, sha256: sha256(bytes) } };
  }
  private async session(ref: FileRef): Promise<Session> {
    await verifyReferences(this.projectRoot, ref);
    const session = (await this.jsonRef(ref.path)).value as Session;
    const { created_at, token, ...input } = session;
    if (!validStart(input) || !created_at || !token || ref.path !== `${this.base(session.id)}/session.json`) {
      throw new WorkflowError('invalid-input', '录制会话格式或位置无效');
    }
    await verifyReferences(this.projectRoot, input);
    return session;
  }
  private async privateInput(input: RecordingStart) {
    const binding = input.private_recording;
    if (!binding) return undefined;
    const scope = await this.store.load(input.scope_ref) as Artifact<'scope'>;
    const environment = validateEnvironment((await this.jsonRef(binding.environment_ref.path)).value);
    if (environment.environment_id !== scope.data.environment_id || environment.role !== scope.data.role ||
        new URL(environment.base_url).href !== new URL(scope.data.base_url!).href || environment.isolation !== 'context' ||
        environment.auth.kind !== 'storage-state-env' || !environment.auth.reference?.startsWith('PI_UI_DATA_SPACE_') ||
        new Set(binding.input_refs.map(ref => ref.path)).size !== binding.input_refs.length ||
        !binding.input_refs.some(ref => isDeepStrictEqual(ref, input.seed_ref))) {
      throw new WorkflowError('precondition', '私密录制须绑定同一范围、受管隔离身份及含 seed 的唯一输入集合');
    }
    await authState(environment, this.projectRoot);
    return { environment, environmentRef: binding.environment_ref, inputRefs: binding.input_refs };
  }
  /** 宿主只从已核验原生会话取得引用，不从聊天或 MCP 参数猜测私有作用域。 */
  async privateContext(ref: FileRef) {
    return this.privateInput(await this.session(ref));
  }
  async start(input: RecordingStart): Promise<FileRef> {
    if (!validStart(input)) throw new WorkflowError('invalid-input', ajv.errorsText(validStart.errors));
    assertPortablePath(input.output_file);
    if (!/\.(spec|test)\.[cm]?[jt]s$/.test(input.output_file)) throw new WorkflowError('invalid-input', '草稿须使用项目内测试文件路径');
    const scope = await this.store.load(input.scope_ref), inventory = await this.store.load(input.inventory_ref);
    if (scope.kind !== 'scope' || inventory.kind !== 'inventory' ||
        !isDeepStrictEqual((inventory as Artifact<'inventory'>).data.scope_ref, input.scope_ref)) {
      throw new WorkflowError('precondition', '功能清单与范围不匹配');
    }
    if (input.max_steps > (scope as Artifact<'scope'>).data.budget.max_tool_calls) throw new WorkflowError('precondition', '录制步数超过范围预算');
    if (!(scope as Artifact<'scope'>).data.base_url) throw new WorkflowError('precondition', '仅源码输入不能声称启动浏览器录制');
    await verifyReferences(this.projectRoot, input);
    await this.privateInput(input);
    try { await access(join(this.projectRoot, input.output_file)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.store.putFile(`${this.base(input.id)}/session.json`, emit({ ...input, created_at: new Date().toISOString(), token: randomUUID() }));
    }
    throw new WorkflowError('precondition', '草稿目标已经存在，请使用新的录制 ID/文件，不覆盖项目测试');
  }
  private async events(session: Session): Promise<Event[]> {
    let entries: string[];
    const dir = `${this.base(session.id)}/events`;
    try { entries = await readdir(await workspacePath(this.projectRoot, dir)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const events: Event[] = [];
    for (const entry of entries) {
      const request = await this.jsonRef(`${dir}/${entry}/request.json`);
      const event: Event = { request: request.value, request_ref: request.ref };
      try { const response = await this.jsonRef(`${dir}/${entry}/response.json`); event.response = response.value; event.response_ref = response.ref; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      events.push(event);
    }
    return events.sort((a, b) => a.request.created_at.localeCompare(b.request.created_at) || a.request.operation_id.localeCompare(b.request.operation_id));
  }
  private async data(session: Session): Promise<{ values: string[]; refs: FileRef[]; cleanupIncomplete: boolean }> {
    const values = [...session.test_data], refs: FileRef[] = [], cleanup = new Map<string, string>();
    const walk = async (path: string): Promise<void> => {
      let entries;
      try { entries = await readdir(await workspacePath(this.projectRoot, path), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const child = `${path}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new WorkflowError('precondition', '数据归属目录不能使用符号链接');
        if (entry.isDirectory()) await walk(child);
        else if (entry.name.endsWith('.json')) {
          const record = await this.jsonRef(child);
          if (record.value.owner_kind !== 'recording' || record.value.owner_id !== session.id) {
            throw new WorkflowError('precondition', '录制数据归属不匹配');
          }
          refs.push(record.ref);
          if (!cleanup.has(record.value.data_id) || entry.name === 'cleanup-result.json') {
            cleanup.set(record.value.data_id, record.value.cleanup_state);
          }
          if (entry.name === 'ready.json' && typeof record.value.business_key === 'string') values.push(record.value.business_key);
        }
      }
    };
    await walk(`${this.base(session.id)}/data`);
    return { values: [...new Set(values)], refs,
      cleanupIncomplete: [...cleanup.values()].some(state => !['cleaned', 'retained'].includes(state)) };
  }
  private stopped(session: Session, events: Event[]): string | undefined {
    if (events.some(e => !e.response)) return 'unknown-operation-needs-reconciliation';
    if (events.some(e => e.response?.isError)) return 'tool-error-or-cancelled';
    if (Date.now() - Date.parse(session.created_at) >= session.max_duration_ms) return 'time-budget';
    if (events.filter(e => e.request.tool !== 'browser_close').length >= session.max_steps) return 'step-budget';
    const snapshots = events.filter(e => e.request.tool === 'browser_snapshot' && e.response);
    const recent = snapshots.slice(-session.max_no_progress);
    if (recent.length === session.max_no_progress && new Set(recent.map(e =>
      sha256(text(e.response!).replace(/\[ref=[^\]]+\]/g, '[ref]')))).size === 1) return 'no-progress';
    return undefined;
  }
  async status(ref: FileRef) {
    const session = await this.session(ref), events = await this.events(session);
    return { id: session.id, events, stopped: this.stopped(session, events),
      context: { role_scope: 'current-role-and-visible-states-only', formal_execution: false } };
  }
  async call(ref: FileRef, call: RecordingCall, execute: RecordingExecutor, signal?: AbortSignal): Promise<Outcome & { observation_ref: FileRef }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(call.operation_id) || !call.intent.trim()) throw new WorkflowError('invalid-input', '操作 ID 或意图无效');
    const session = await this.session(ref);
    const release = await this.store.acquireResource(`recording:${session.id}`);
    try {
      const events = await this.events(session), previous = events.find(e => e.request.operation_id === call.operation_id);
      if (previous) {
        if (!isDeepStrictEqual(previous.request.input, call.input) || previous.request.tool !== call.tool || previous.request.intent !== call.intent) {
          throw new WorkflowError('precondition', '同一操作 ID 不能更换输入');
        }
        if (!previous.response || !previous.response_ref) throw new WorkflowError('precondition', '操作结果不明，需核对，不自动重放');
        return { ...previous.response, observation_ref: previous.response_ref };
      }
      try { await access(join(this.projectRoot, this.base(session.id), 'manifest.json')); throw new WorkflowError('precondition', '录制已登记结束，不能追加浏览器动作'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!recordingTools.includes(call.tool)) throw new WorkflowError('invalid-input', '录制 tool 须为不含 MCP 前缀的名称，例如 generator_setup_page；不会回退到其他浏览器后端');
      const stopped = this.stopped(session, events);
      if (stopped && call.tool !== 'browser_close') throw new WorkflowError('precondition', `录制已停止：${stopped}`);
      if (call.tool === 'generator_setup_page' &&
          (call.input.seedFile !== session.seed_ref.path || call.input.project !== session.project || events.length)) {
        throw new WorkflowError('precondition', '只能首先执行已声明 seed/project，不重复初始化');
      }
      if (call.tool !== 'generator_setup_page' && !events.some(e => e.request.tool === 'generator_setup_page' && !e.response?.isError)) {
        throw new WorkflowError('precondition', '必须先完成真实页面初始化');
      }
      if (call.tool === 'browser_type' && !(await this.data(session)).values.includes(String(call.input.text))) {
        throw new WorkflowError('precondition', '只允许预先声明的公开合成输入，认证使用私有状态引用');
      }
      if (call.tool === 'browser_navigate') {
        const scope = await this.store.load(session.scope_ref) as Artifact<'scope'>;
        if (new URL(String(call.input.url)).origin !== new URL(scope.data.base_url!).origin) throw new WorkflowError('precondition', '不能导航到范围外站点');
      }
      if (call.tool === 'generator_write_test') {
        if (call.input.fileName !== session.output_file) throw new WorkflowError('precondition', '只能写入本次声明的草稿文件');
        try { await access(join(this.projectRoot, session.output_file)); throw new WorkflowError('precondition', '草稿文件已经存在，不能覆盖'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const request = { ...call, created_at: new Date().toISOString() };
      // 过期/撤销后仍允许查询、结束和自有 context 清理，不再分派业务动作。
      if (call.tool !== 'browser_close') await this.privateInput(session);
      const path = `${this.base(session.id)}/events/${call.operation_id}`;
      await this.store.putFile(`${path}/request.json`, emit(request));
      const remaining = call.tool === 'browser_close' ? 45000 : Math.max(1, session.max_duration_ms - (Date.now() - Date.parse(session.created_at)));
      const timeout = AbortSignal.timeout(remaining), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Outcome;
      try { response = await execute(`${session.backend}${call.tool}`, call.input, combined); }
      catch { response = { isError: true, unknown: true, content: [{ type: 'text', text: '工具异常或取消，副作用需核对' }] }; }
      if (combined.aborted) response = { ...response, isError: true, unknown: true };
      const observationRef = await this.store.putFile(`${path}/response.json`, emit(response));
      return { ...response, observation_ref: observationRef };
    } finally { await release(); }
  }
  async finish(ref: FileRef, input: { inventory_ref: FileRef; initial_state: string;
    completion: Artifact<'recording'>['data']['completion']; gaps: string[]; goal_reached: boolean }): Promise<FileRef> {
    const session = await this.session(ref), release = await this.store.acquireResource(`recording:${session.id}`);
    try {
      const events = await this.events(session), inventory = await this.store.load(input.inventory_ref) as Artifact<'inventory'>;
      if (inventory.kind !== 'inventory' || !isDeepStrictEqual(inventory.data.scope_ref, session.scope_ref)) throw new WorkflowError('precondition', '完成清单须属于相同范围');
      const gaps = [...input.gaps], scripts: FileRef[] = [], data = await this.data(session);
      const successful = (tool: string) => events.some(e => e.request.tool === tool && e.response && !e.response.isError);
      if (successful('generator_write_test')) {
        const bytes = await readFile(await workspacePath(this.projectRoot, session.output_file));
        const code = bytes.toString();
        const written = events.find(e => e.request.tool === 'generator_write_test' && !e.response?.isError);
        if (written?.request.input.code !== code) gaps.push('script-changed-after-recording');
        // 这里只做录制交接检查；语义、静态编译及断言评估在 UI-06。
        if (/aria-ref=|\[ref=|\/Users\/|\/home\/|[A-Z]:\\/.test(code)) gaps.push('script-has-temporary-ref-or-personal-path');
        if (data.values.some(value => code.includes(JSON.stringify(value)) || code.includes("'" + value + "'"))) gaps.push('script-has-fixed-recorded-data');
        scripts.push(await this.store.putFile(`${this.base(session.id)}/draft.spec.ts`, bytes));
      } else gaps.push('missing-generated-script');
      if (!successful('generator_read_log')) gaps.push('missing-native-recording-log');
      if (!successful('browser_close')) gaps.push('browser-cleanup-not-confirmed');
      if (data.cleanupIncomplete) gaps.push('recording-data-cleanup-incomplete');
      if (!input.goal_reached) gaps.push('goal-not-reached');
      if (Object.values(input.completion).some(v => !v)) gaps.push('completion-checks-incomplete');
      const stopped = this.stopped(session, events);
      // 达到预算仍保留真实已完成动作；超过预算且未达成目标则明确不完整。
      if (stopped && !(input.goal_reached && ['step-budget', 'time-budget'].includes(stopped))) gaps.push(stopped);
      const logRef = await this.store.putFile(`${this.base(session.id)}/raw-log.json`, emit({ session_ref: ref, events }));
      const artifact: Artifact<'recording'> = { schema_version: '1.0', id: session.id, kind: 'recording', created_at: session.created_at,
        data: { scope_ref: session.scope_ref, inventory_ref: input.inventory_ref, initial_state: input.initial_state,
          initial_state_ref: session.initial_state_ref, data_rules_ref: session.data_rules_ref,
          status: gaps.length ? 'partial' : 'complete', log_ref: logRef, script_refs: scripts,
          steps: events.filter((e): e is Event & { response_ref: FileRef } => !!e.response_ref).map(e => ({
            step_id: e.request.operation_id, intent: e.request.intent, tool: `${session.backend}${e.request.tool}`, observation_ref: e.response_ref })),
          data_refs: [session.data_rules_ref, ...data.refs], completion: input.completion, gaps: [...new Set(gaps)] } };
      return this.store.put(artifact);
    } finally { await release(); }
  }
}
