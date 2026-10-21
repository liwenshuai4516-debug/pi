import { join } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { UiWorkflowService, workflowStartSchema } from './workflow.js';
import { fileRefSchema, stages } from './contracts.js';
import { WorkflowError } from './validation.js';

export function registerWorkflowTools(pi: ExtensionAPI) {
  pi.registerTool({ name: 'ui_test_workflow', label: 'UI 测试任务与按需交接',
    description: '查询资产/能力，登记新建、仅录制、执行已有资产、分析旧 run 或查看任务，并保存已核验阶段。只选择与交接，不启动浏览器或模型评估；已有工具执行各阶段。',
    parameters: Type.Object({ request: Type.Union([
      Type.Object({ operation: Type.Literal('catalog') }),
      Type.Object({ operation: Type.Literal('start'), input: workflowStartSchema }),
      Type.Object({ operation: Type.Literal('status'), task_id: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' }) }),
      Type.Object({ operation: Type.Literal('checkpoint'), task_ref: fileRefSchema, stage: Type.Enum([...stages]), output_refs: Type.Array(fileRefSchema, { minItems: 1 }) }),
      Type.Object({ operation: Type.Literal('block'), task_ref: fileRefSchema, reasons: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }),
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
          : request.operation === 'checkpoint' ? await service.checkpoint(request.task_ref, request.stage, request.output_refs)
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
