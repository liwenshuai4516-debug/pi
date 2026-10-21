import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { RecordingService, recordingStartSchema, recordingTools } from './recording.js';
import { fileRefSchema, schemas, type Artifact, type CapabilityResult } from './contracts.js';
import { validateArtifact, WorkflowError } from './validation.js';
import { registerDesignTools } from './design-extension.js';
import { registerRunTools } from './run-extension.js';
import { registerResultTools } from './result-extension.js';
import { registerWorkflowTools } from './workflow-extension.js';

export default function (pi: ExtensionAPI) {
  registerDesignTools(pi);
  registerRunTools(pi);
  registerResultTools(pi);
  registerWorkflowTools(pi);
  let activeBackend: string | undefined;
  let activeSession: import('./contracts.js').FileRef | undefined;
  pi.on('tool_call', event => {
    if (activeBackend && event.toolName.startsWith('mcp__') && !event.parentToolCallId) {
      return { block: true, reason: '录制期间通过 ui_discover_record action 调用浏览器，以保存真实证据并执行预算检查' };
    }
  });
  pi.registerTool({
    name: 'ui_validate_artifact', label: '校验 UI 测试产物',
    description: '校验 UI 测试产物 schema 1.0、来源/步骤引用和状态一致性；不批准语义、不读写文件、不执行测试。',
    parameters: Type.Object({ artifact: Type.Unknown() }),
    async execute(_id, args) {
      let result: CapabilityResult;
      try {
        const artifact = validateArtifact(args.artifact);
        result = { schema_version: '1.0', capability_id: 'ui-validate-artifact', capability_version: '0.1.0',
          status: 'completed', artifact_refs: [], errors: [] };
        return { content: [{ type: 'text', text: JSON.stringify({ ...result, kind: artifact.kind, id: artifact.id }) }], details: result };
      } catch (error) {
        result = { schema_version: '1.0', capability_id: 'ui-validate-artifact', capability_version: '0.1.0',
          status: 'blocked', artifact_refs: [], errors: [{ category: error instanceof WorkflowError ? error.category : 'invalid-input',
            message: error instanceof Error ? error.message : String(error), recoverable: false }] };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      }
    },
  });
  pi.registerTool({
    name: 'ui_discover_record', label: 'UI 发现与自动录制交接',
    description: '保存有来源的模块功能清单，按预算调用已安装 Playwright MCP 并持久化真实请求/观察，登记完整或局部录制草稿；不批准设计、不正式执行测试。',
    parameters: Type.Object({ request: Type.Union([
      Type.Object({ operation: Type.Literal('inventory'), inventory: schemas.inventory,
        drafts: Type.Optional(Type.Array(Type.Object({ name: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*\\.(?:ts|js|md)$' }),
          content: Type.String({ minLength: 1 }) }))) }),
      Type.Object({ operation: Type.Literal('start'), configuration: recordingStartSchema }),
      Type.Object({ operation: Type.Literal('status'), session_ref: fileRefSchema }),
      Type.Object({ operation: Type.Literal('action'), session_ref: fileRefSchema,
        operation_id: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' }),
        tool: Type.Enum(recordingTools, { description: '不含 MCP 前缀的工具名；后端前缀由录制会话添加。' }),
        input: Type.Record(Type.String(), Type.Unknown()), intent: Type.String({ minLength: 1 }) }),
      Type.Object({ operation: Type.Literal('finish'), session_ref: fileRefSchema, inventory_ref: fileRefSchema,
        initial_state: Type.String({ minLength: 1 }), completion: schemas.recording.properties.data.properties.completion,
        gaps: Type.Array(Type.String()), goal_reached: Type.Boolean() }),
    ]) }),
    async execute(_id, { request: args }, signal, _update, ctx) {
      const service = new RecordingService(ctx.cwd);
      let refs: import('./contracts.js').FileRef[] = [], output: unknown;
      try {
        if (args.operation === 'inventory') {
          const inventory = validateArtifact(args.inventory) as Artifact<'inventory'>;
          const scope = await service.store.load(inventory.data.scope_ref) as Artifact<'scope'>;
          if (scope.kind !== 'scope' || inventory.data.features.some(f => f.role !== scope.data.role)) {
            throw new WorkflowError('precondition', '清单角色须与已登记范围一致');
          }
          if (args.drafts?.length) {
            const draftRefs = [];
            for (const draft of args.drafts) draftRefs.push(await service.store.putFile(
              `qa/ui/inventories/${inventory.id}/drafts/${draft.name}`, draft.content));
            inventory.data.draft_refs = [...(inventory.data.draft_refs ?? []), ...draftRefs];
          }
          refs = [await service.store.put(inventory)]; output = { browser_recorded: false };
        } else if (args.operation === 'start') {
          if (activeSession) throw new WorkflowError('precondition', '当前录制尚未结束，先保存局部产物和清理状态');
          refs = [await service.start(args.configuration)]; activeBackend = args.configuration.backend; activeSession = refs[0];
        } else if (args.operation === 'action') {
          if (!activeSession || activeSession.path !== args.session_ref.path || activeSession.sha256 !== args.session_ref.sha256) {
            throw new WorkflowError('precondition', '当前 Agent 未启动此录制；重启后只读旧记录，不从点击中间续跑');
          }
          const result = await service.call(args.session_ref, args, async (tool, input, callSignal) => {
            const outcome = await ctx.executeTool(tool, input, { signal: callSignal });
            return { ...outcome.result, isError: outcome.isError, duration_ms: outcome.durationMs };
          }, signal);
          refs = [result.observation_ref]; output = result;
          if (result.isError) throw new WorkflowError('precondition', '原生录制工具返回错误，证据已保留；停止分支并核对副作用');
        } else if (args.operation === 'status') output = await service.status(args.session_ref);
        else { refs = [await service.finish(args.session_ref, args)]; activeBackend = undefined; activeSession = undefined; }
        const result = { schema_version: '1.0', capability_id: 'ui-discover-record', capability_version: '0.1.0',
          status: 'completed', artifact_refs: refs, errors: [] };
        return { content: [{ type: 'text', text: JSON.stringify({ ...result, output }) }], details: result };
      } catch (error) {
        const result = { schema_version: '1.0', capability_id: 'ui-discover-record', capability_version: '0.1.0',
          status: 'blocked', artifact_refs: refs, errors: [{ category: error instanceof WorkflowError ? error.category : 'invalid-input',
            message: error instanceof Error ? error.message : String(error), recoverable: false }] };
        return { content: [{ type: 'text', text: JSON.stringify({ ...result, output }) }], details: result };
      }
    },
  });
}
