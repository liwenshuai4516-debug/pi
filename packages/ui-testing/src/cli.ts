import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { artifactSchema, capabilities, capabilityResultSchema, validateArtifact, verifyReferences, WorkflowError, type ArtifactKind } from './index.js';

try {
  const [command, input, root = process.cwd()] = process.argv.slice(2);
  if (command === 'capabilities') console.log(JSON.stringify(capabilities, null, 2));
  else if (command === 'schema' && input) {
    console.log(JSON.stringify(input === 'capability-result' ? capabilityResultSchema : artifactSchema(input as ArtifactKind), null, 2));
  } else if (command === 'validate' && input) {
    const artifact = validateArtifact(JSON.parse(await readFile(resolve(input), 'utf8')));
    await verifyReferences(root, artifact);
    console.log(JSON.stringify({ schema_version: '1.0', capability_id: 'ui-validate-artifact', capability_version: '0.1.0',
      status: 'completed', artifact_refs: [], errors: [], id: artifact.id, kind: artifact.kind }));
  } else throw new WorkflowError('invalid-input', '用法：schema <kind> 或 validate <artifact.json> [project-root]');
} catch (error) {
  console.log(JSON.stringify({ schema_version: '1.0', capability_id: 'ui-validate-artifact', capability_version: '0.1.0',
    status: 'blocked', artifact_refs: [], errors: [{ category: error instanceof WorkflowError ? error.category : 'invalid-input',
      message: error instanceof Error ? error.message : String(error), recoverable: false }] }));
  process.exitCode = 1;
}
