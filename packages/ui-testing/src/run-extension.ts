import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { UiRunService, runRequestSchema } from './runner.js';
import { workspacePath, WorkflowError } from './validation.js';

export function registerRunTools(pi: ExtensionAPI) {
  const id = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' });
  pi.registerTool({
    name: 'ui_test_run', label: 'UI 正式执行与批次查询',
    description: '对可信获批且完成诊断的资产启动新 Playwright 批次，保存计划/原生报告/attempt/截图/trace。相同请求不重放，status 只读旧批次。执行完成不代表测试通过。',
    parameters: Type.Object({ request: Type.Union([
      Type.Object({ operation: Type.Literal('start'), input: runRequestSchema }),
      Type.Object({ operation: Type.Literal('status'), task_id: id, request_id: id }),
    ]) }),
    async execute(_id, { request }, signal, _update, ctx) {
      try {
        const service = new UiRunService(ctx.cwd, join(ctx.sessionManager.getSessionDir(), 'ui-review-authority'));
        const output = request.operation === 'status' ? await service.status(request.task_id, request.request_id)
          : await service.start(request.input, signal);
        const summaryRef = output.run.data.output_refs.find(r => r.path.endsWith('/execution-summary.json'));
        const summary = summaryRef ? JSON.parse(await readFile(await workspacePath(ctx.cwd, summaryRef.path), 'utf8')) : undefined;
        const status = request.operation === 'status' ? 'completed' : summary?.status === 'cancelled' ? 'cancelled'
          : summary?.status === 'completed' ? 'completed' : 'blocked';
        const result = { schema_version: '1.0', capability_id: 'ui-test-run', capability_version: '0.1.0', status,
          artifact_refs: [output.run_ref, ...output.run.data.output_refs],
          errors: status === 'completed' ? [] : [{ category: status === 'cancelled' ? 'cancelled' : 'precondition',
            message: '执行未完整结束或前置条件受阻；查询原批次与证据，不自动重放', recoverable: false }] };
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, output }) }], details: result };
      } catch (error) {
        const result = { schema_version: '1.0', capability_id: 'ui-test-run', capability_version: '0.1.0',
          status: error instanceof WorkflowError && error.category === 'cancelled' ? 'cancelled' : 'blocked',
          artifact_refs: error instanceof WorkflowError ? error.artifact_refs : [],
          errors: [{ category: error instanceof WorkflowError ? error.category : 'runner-error',
            message: error instanceof WorkflowError ? error.message : '执行入口异常；核对原批次状态', recoverable: false }] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
      }
    },
  });
}
