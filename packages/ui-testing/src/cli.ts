import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ArtifactStore, artifactSchema, capabilities, capabilityResultSchema, validateArtifact, verifyReferences, WorkflowError, type ArtifactKind } from './index.js';
import { diagnosticSpecSchema } from './diagnostics.js';
import { runRequestSchema } from './runner.js';

try {
  const [command, input, root = process.cwd()] = process.argv.slice(2);
  if (command === 'capabilities') console.log(JSON.stringify(capabilities, null, 2));
  else if (command === 'schema' && input) {
    console.log(JSON.stringify(input === 'capability-result' ? capabilityResultSchema : input === 'diagnostic-spec' ? diagnosticSpecSchema
      : input === 'run-request' ? runRequestSchema : artifactSchema(input as ArtifactKind), null, 2));
  } else if (command === 'store-index' && input) {
    console.log(JSON.stringify(await new ArtifactStore(resolve(input)).reindex(), null, 2));
  } else if (command === 'store-put' && input) {
    const artifact = validateArtifact(JSON.parse(await readFile(resolve(input), 'utf8')));
    console.log(JSON.stringify(await new ArtifactStore(resolve(root)).put(artifact), null, 2));
  } else if (command === 'store-load' && input) {
    const ref = JSON.parse(await readFile(resolve(input), 'utf8'));
    console.log(JSON.stringify(await new ArtifactStore(resolve(root)).load(ref), null, 2));
  } else if (command === 'validate' && input) {
    const artifact = validateArtifact(JSON.parse(await readFile(resolve(input), 'utf8')));
    await verifyReferences(root, artifact);
    console.log(JSON.stringify({ schema_version: '1.0', capability_id: 'ui-validate-artifact', capability_version: '0.1.0',
      status: 'completed', artifact_refs: [], errors: [], id: artifact.id, kind: artifact.kind }));
  } else throw new WorkflowError('invalid-input', '用法：capabilities | schema <kind> | validate/store-put <artifact.json> [project-root] | store-load <ref.json> [project-root] | store-index <project-root>');
} catch (error) {
  console.log(JSON.stringify({ schema_version: '1.0', capability_id: 'ui-validate-artifact', capability_version: '0.1.0',
    status: 'blocked', artifact_refs: [], errors: [{ category: error instanceof WorkflowError ? error.category : 'invalid-input',
      message: error instanceof Error ? error.message : String(error), recoverable: false }] }));
  process.exitCode = 1;
}
