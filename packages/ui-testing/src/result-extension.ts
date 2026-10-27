import { join } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { collectResults } from './results.js';
import { saveAnalysis, draftReport, analyzeTask } from './analysis.js';
import { UiWorkflowService } from './workflow.js';
import { ResultReviewService } from './result-review.js';
import { fileRefSchema, schemas, type Artifact, type FileRef } from './contracts.js';
import { WorkflowError } from './validation.js';
import { traceEvidence } from './trace-evidence.js';

const id = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' });
function result(capability: string, output: unknown, refs: FileRef[]) {
  const value = { schema_version: '1.0', capability_id: capability, capability_version: '0.1.0', status: 'completed', artifact_refs: refs, errors: [] };
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ...value, output }) }], details: value };
}
function failure(capability: string, error: unknown) {
  const value = { schema_version: '1.0', capability_id: capability, capability_version: '0.1.0',
    status: error instanceof WorkflowError && error.category === 'cancelled' ? 'cancelled' : 'blocked',
    artifact_refs: error instanceof WorkflowError ? error.artifact_refs : [],
    errors: [{ category: error instanceof WorkflowError ? error.category : 'runner-error',
      message: error instanceof WorkflowError ? error.message : '结果处理异常，保留旧产物并核对证据', recoverable: false }] };
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
}
export function registerResultTools(pi: ExtensionAPI) {
  pi.registerTool({ name: 'ui_result_analysis', label: 'UI 统计、分析与报告候选',
    description: 'Reconcile existing UI runs, group observed failures without inferring shared causes, and prepare report candidates by task ID. Preserve per-instance evidence and independent result review; never run a browser.',
    parameters: Type.Object({ request: Type.Union([
      Type.Object({ operation: Type.Literal('parse'), run_ref: fileRefSchema, result_id: id }),
      Type.Object({ operation: Type.Literal('analyze-task'), task_id: id, findings: Type.Optional(schemas.analysis.properties.data.properties.findings) }),
      Type.Object({ operation: Type.Literal('read-trace'), results_ref: fileRefSchema, trace_ref: fileRefSchema }),
      Type.Object({ operation: Type.Literal('save-analysis'), analysis: schemas.analysis }),
      Type.Object({ operation: Type.Literal('draft-report'), results_ref: fileRefSchema, analysis_ref: fileRefSchema, report_id: id }),
    ]) }),
    async execute(_id, { request }, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new WorkflowError('cancelled', '结果处理已取消');
        if (request.operation === 'analyze-task') {
          const prompt = ctx.getSystemPrompt();
          const skills = [...prompt.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)].flatMap(block =>
            [...block[1].matchAll(/<name>([a-z0-9-]+)<\/name>/g)].map(match => match[1]));
          const workflow = new UiWorkflowService(ctx.cwd, join(ctx.sessionManager.getSessionDir(), 'ui-review-authority'),
            { tools: ctx.tools.map(t => t.name), skills });
          const output = await analyzeTask(workflow, request.task_id, request.findings, signal);
          return result('ui-result-analysis', output, [output.results_ref, ...(output.report_ref ? [output.report_ref] : [])]);
        }
        if (request.operation === 'read-trace') return result('ui-result-analysis',
          await traceEvidence(ctx.cwd, request.results_ref, request.trace_ref), [request.trace_ref]);
        if (request.operation === 'parse') {
          const output = await collectResults(ctx.cwd, request.run_ref, request.result_id);
          return result('ui-result-analysis', output, [output.results_ref]);
        }
        if (request.operation === 'save-analysis') {
          const output = await saveAnalysis(ctx.cwd, request.analysis as Artifact<'analysis'>);
          return result('ui-result-analysis', output, [output.analysis_ref]);
        }
        const output = await draftReport(ctx.cwd, request.results_ref, request.analysis_ref, request.report_id);
        return result('ui-result-analysis', output, [output.report_ref]);
      } catch (error) { return failure('ui-result-analysis', error); }
    },
  });
  pi.registerTool({ name: 'ui_result_review', label: '独立 UI 结果评估与报告交付',
    description: '独立无工具 Agent 核验 R1–R6，最多三轮并保留原文；完整交付要求可信批准。证据不足仅交付明确标记的 partial 阶段报告。不执行测试。',
    parameters: Type.Object({ request: Type.Union([
      Type.Object({ operation: Type.Literal('review'), report_ref: fileRefSchema, request_id: id }),
      Type.Object({ operation: Type.Literal('deliver'), report_ref: fileRefSchema, review_ref: Type.Optional(fileRefSchema) }),
    ]) }),
    async execute(_id, { request }, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new WorkflowError('cancelled', '结果评估已取消');
        const service = new ResultReviewService(ctx.cwd, join(ctx.sessionManager.getSessionDir(), 'ui-review-authority'));
        if (request.operation === 'deliver') {
          const output = await service.deliver(request.report_ref, request.review_ref);
          return result('ui-result-review', output, [output.delivery_ref]);
        }
        if (!ctx.model) throw new WorkflowError('missing-capability', '未选择结果评估模型');
        const [{ Agent }, { convertToLlm }] = await Promise.all([import('@earendil-works/pi-agent-core'), import('@earendil-works/pi-coding-agent')]);
        const model = ctx.model;
        const output = await service.assess(request.report_ref, request.request_id, async input => {
          const { system_prompt: systemPrompt, ...facts } = input;
          const reviewer = new Agent({ initialState: { model, tools: [], messages: [], thinkingLevel: 'off', systemPrompt },
            convertToLlm, streamFn: (m, context, options) => ctx.modelRegistry.streamSimple(m, context, options) });
          const abort = () => reviewer.abort(), timer = setTimeout(abort, 120000);
          signal?.addEventListener('abort', abort, { once: true });
          try { await reviewer.prompt(JSON.stringify(facts)); }
          finally { clearTimeout(timer);signal?.removeEventListener('abort', abort); }
          const message = [...reviewer.state.messages].reverse().find(m => m.role === 'assistant');
          return { raw: message?.role === 'assistant' ? message.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '',
            provider: model.provider, model: model.id, stop_reason: message?.role === 'assistant' ? message.stopReason : 'error' };
        });
        return result('ui-result-review', output, [output.review_ref]);
      } catch (error) { return failure('ui-result-review', error); }
    },
  });
}
