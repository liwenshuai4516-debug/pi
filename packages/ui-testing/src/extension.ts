import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { validateArtifact, WorkflowError, type CapabilityResult } from './index.js';

export default function (pi: ExtensionAPI) {
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
}
