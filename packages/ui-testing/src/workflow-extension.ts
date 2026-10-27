import { join } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { UiWorkflowService, workflowStartSchema } from './workflow.js';
import { fileRefSchema, stages } from './contracts.js';
import { WorkflowError } from './validation.js';
import { changeImpact, inspectImport, exportAsset, importAsset, auditEvidence } from './maintenance.js';

export function registerWorkflowTools(pi: ExtensionAPI) {
  pi.registerTool({ name: 'ui_asset_maintain', label: 'UI 资产导入、影响与证据维护',
    description: '基于登记依赖/Git 分析变更，发现已有测试映射，按显式引用迁移资产并审计证据。不会启动浏览器、授予批准或自动删除证据。',
    parameters: Type.Object({ request: Type.Union([
      Type.Object({ operation: Type.Literal('impact'), changed_paths: Type.Optional(Type.Array(Type.String())), git_ref: Type.Optional(Type.String()) }),
      Type.Object({ operation: Type.Literal('inspect-import'), script_path: Type.String() }),
      Type.Object({ operation: Type.Literal('export'), asset_ref: fileRefSchema, bundle_id: Type.String() }),
      Type.Object({ operation: Type.Literal('import'), bundle_ref: fileRefSchema }),
      Type.Object({ operation: Type.Literal('audit-evidence'), retention_days: Type.Integer({ minimum: 1 }), audit_id: Type.String() }),
    ]) }),
    async execute(_id, { request }, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new WorkflowError('cancelled', '资产维护已取消');
        const output = request.operation === 'impact' ? await changeImpact(ctx.cwd, request.changed_paths, request.git_ref)
          : request.operation === 'inspect-import' ? await inspectImport(ctx.cwd, request.script_path)
          : request.operation === 'export' ? await exportAsset(ctx.cwd, request.asset_ref, request.bundle_id)
          : request.operation === 'import' ? await importAsset(ctx.cwd, request.bundle_ref)
          : await auditEvidence(ctx.cwd, request.retention_days, request.audit_id);
        return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], details: output };
      } catch (error) {
        const output = { status: 'blocked', errors: [{ category: error instanceof WorkflowError ? error.category : 'precondition',
          message: error instanceof Error ? error.message : '资产维护未完成，核对原有对象' }] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], details: output };
      }
    },
  });
  pi.registerTool({ name: 'ui_test_workflow', label: 'UI 测试任务与按需交接',
    description: 'Route UI tasks, expose current stage references and checkpoint verified outputs by task ID. Continue an explicitly authorized new task into a separate execution task; never launch browsers or model reviews here.',
    parameters: Type.Object({ request: Type.Union([
      Type.Object({ operation: Type.Literal('catalog') }),
      Type.Object({ operation: Type.Literal('start'), input: workflowStartSchema }),
      Type.Object({ operation: Type.Literal('status'), task_id: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' }) }),
      Type.Object({ operation: Type.Literal('handoff'), task_id: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' }),
        stage: Type.Enum([...stages]), output_refs: Type.Array(fileRefSchema, { minItems: 1 }) }),
      Type.Object({ operation: Type.Literal('continue-execute'), task_id: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' }), authorized_asset_ref: fileRefSchema }),
      Type.Object({ operation: Type.Literal('checkpoint'), task_ref: fileRefSchema, stage: Type.Enum([...stages]), output_refs: Type.Array(fileRefSchema, { minItems: 1 }) }),
      Type.Object({ operation: Type.Literal('block'), task_ref: fileRefSchema, reasons: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }),
      Type.Object({ operation: Type.Literal('resume-task'), task_ref: fileRefSchema }),
    ]) }),
    async execute(_id, { request }, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new WorkflowError('cancelled', '工作流交接已取消');
        // 只读取 SDK 1.2.0 生成的技能目录；Skill 正文仍由 Pi read 按需加载。
        const prompt = ctx.getSystemPrompt();
        const available = [...prompt.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)].flatMap(block =>
          [...block[1].matchAll(/<name>([a-z0-9-]+)<\/name>/g)].map(match => match[1]));
        const service = new UiWorkflowService(ctx.cwd, join(ctx.sessionManager.getSessionDir(), 'ui-review-authority'),
          { tools: ctx.tools.map(t => t.name), skills: available });
        const output = request.operation === 'catalog' ? await service.catalog()
          : request.operation === 'start' ? await service.start(request.input)
          : request.operation === 'status' ? await service.find(request.task_id)
          : request.operation === 'handoff' ? await service.handoff(request, signal)
          : request.operation === 'continue-execute' ? await service.continueExecute(request.task_id, request.authorized_asset_ref, signal)
          : request.operation === 'checkpoint' ? await service.checkpoint(request.task_ref, request.stage, request.output_refs, signal)
          : request.operation === 'resume-task' ? await service.resumeTask(request.task_ref)
          : await service.block(request.task_ref, request.reasons);
        const blockers = 'blockers' in output ? output.blockers : [];
        const savedBlockers = 'task' in output ? output.task.data.blockers : [];
        const errors = blockers.length ? blockers.map(b => ({ ...b, recoverable: false }))
          : savedBlockers.map(message => ({ category: 'precondition', message, recoverable: false }));
        const refs = 'task_ref' in output ? [output.task_ref] : [];
        const value = { schema_version: '1.0', capability_id: 'ui-test-workflow', capability_version: '0.1.0',
          status: errors.length ? 'blocked' : 'completed', artifact_refs: refs, errors };
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...value, output }) }], details: value };
      } catch (error) {
        const value = { schema_version: '1.0', capability_id: 'ui-test-workflow', capability_version: '0.1.0',
          status: error instanceof WorkflowError && error.category === 'cancelled' ? 'cancelled' : 'blocked',
          artifact_refs: error instanceof WorkflowError ? error.artifact_refs : [],
          errors: [{ category: error instanceof WorkflowError ? error.category : 'runner-error',
            message: error instanceof WorkflowError ? error.message : '工作流交接失败，核对已有产物，不重放业务动作', recoverable: false }] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
      }
    },
  });
}
