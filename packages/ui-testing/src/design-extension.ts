import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fileRefSchema, schemas, type Artifact, type FileRef } from './contracts.js';
import { ArtifactStore, assetDigest } from './store.js';
import { assertPortablePath, WorkflowError } from './validation.js';

export function registerDesignTools(pi: ExtensionAPI) {
  const id = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' });
  const failure = (capability: string, error: unknown) => {
    const result = { schema_version: '1.0', capability_id: capability, capability_version: '0.1.0', status: 'blocked', artifact_refs: [],
      errors: [{ category: error instanceof WorkflowError ? error.category : 'runner-error',
        message: error instanceof Error ? error.message : String(error), recoverable: false }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
  };
  const success = (capability: string, refs: FileRef[], output?: unknown) => {
    const result = { schema_version: '1.0', capability_id: capability, capability_version: '0.1.0', status: 'completed', artifact_refs: refs, errors: [] };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, output }) }], details: result };
  };
  pi.registerTool({
    name: 'ui_case_design', label: 'UI 用例与断言候选',
    description: '登记有来源的 cases、不可变脚本/fixture 与候选修订，核对 TypeScript 和 case/assertion 映射；不批准、不执行测试。',
    parameters: Type.Object({ request: Type.Union([
      Type.Object({ operation: Type.Literal('save-cases'), cases: schemas.cases }),
      Type.Object({ operation: Type.Literal('save-file'), asset_id: id, revision: id, name: Type.String({ minLength: 1 }), content: Type.String() }),
      Type.Object({ operation: Type.Literal('candidate'), asset: schemas.asset }),
      Type.Object({ operation: Type.Literal('check'), asset_ref: fileRefSchema }),
    ]) }),
    async execute(_id, { request }, _signal, _update, ctx) {
      try {
        const store = new ArtifactStore(ctx.cwd);
        if (request.operation === 'save-cases') return success('ui-case-design', [await store.put(request.cases)]);
        if (request.operation === 'save-file') {
          assertPortablePath(request.name);
          return success('ui-case-design', [await store.putFile(`qa/ui/assets/${request.asset_id}/revisions/${request.revision}/${request.name}`, request.content)]);
        }
        const { checkDesign } = await import('./design.js');
        let ref: FileRef;
        if (request.operation === 'candidate') {
          const asset = request.asset as Artifact<'asset'>;
          asset.data.content_sha256 = assetDigest(asset); ref = await store.put(asset);
        } else ref = request.asset_ref;
        const check = await checkDesign(ctx.cwd, ref);
        return success('ui-case-design', [ref], { ...check, ready_for_review: !check.issues.some(i => i.blocking), design_approved: false });
      } catch (error) { return failure('ui-case-design', error); }
    },
  });
  pi.registerTool({
    name: 'ui_design_review', label: '独立 UI 设计评估',
    description: '使用当前模型、全新只读 Agent 和原始文件证据按 D1–D10 评估；只接受候选/任务引用，不接受生成者自报决定。最多三次、保留问题与版本。设计批准不等于运行就绪。',
    parameters: Type.Object({ task_ref: fileRefSchema, asset_ref: fileRefSchema, request_id: id }),
    async execute(_id, args, signal, _update, ctx) {
      try {
        if (!ctx.model) throw new WorkflowError('missing-capability', '未选择评估模型');
        if (signal?.aborted) throw new WorkflowError('cancelled', '评估已取消');
        const [{ DesignReviewService }, { Agent }, { convertToLlm }, { join }] = await Promise.all([
          import('./review.js'), import('@earendil-works/pi-agent-core'), import('@earendil-works/pi-coding-agent'),
          import('node:path'),
        ]);
        const model = ctx.model;
        const service = new DesignReviewService(ctx.cwd, join(ctx.sessionManager.getSessionDir(), 'ui-review-authority'));
        const result = await service.assess(args.task_ref, args.asset_ref, args.request_id, async input => {
          const { system_prompt: systemPrompt, ...facts } = input;
          const reviewer = new Agent({ initialState: { model, tools: [], messages: [], thinkingLevel: 'off',
            systemPrompt },
            convertToLlm, streamFn: (m, context, options) => ctx.modelRegistry.streamSimple(m, context, options) });
          const abort = () => reviewer.abort(), timer = setTimeout(abort, 60000);
          signal?.addEventListener('abort', abort, { once: true });
          try { await reviewer.prompt(JSON.stringify(facts)); }
          finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
          const message = [...reviewer.state.messages].reverse().find(m => m.role === 'assistant');
          const raw = message?.role === 'assistant' ? message.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
          return { raw, provider: model.provider, model: model.id, stop_reason: message?.role === 'assistant' ? message.stopReason : 'error' };
        });
        return success('ui-design-review', [result.review_ref], { ...result, runtime_ready: false });
      } catch (error) { return failure('ui-design-review', error); }
    },
  });
}
