import { Type, type Static } from 'typebox';

const id = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$' });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const strings = Type.Array(Type.String());
const enumOf = <T extends string>(values: T[]) => Type.Enum(values);
const object = <T extends Record<string, import('typebox').TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const fileRefSchema = object({ path: Type.String({ minLength: 1 }), sha256: digest });
export type FileRef = Static<typeof fileRefSchema>;
const refs = Type.Array(fileRefSchema);
const oracle = enumOf(['requirement', 'declaration', 'baseline']);
const source = object({ source_id: id, oracle_type: oracle, ref: fileRefSchema, statement: Type.String({ minLength: 1 }) });
const issue = object({ id, rule: Type.String({ pattern: '^(D(?:10|[1-9])|R[1-6])$' }),
  case_id: Type.Optional(id), assertion_id: Type.Optional(id), reason: Type.String({ minLength: 1 }),
  evidence_refs: refs, fix_condition: Type.String({ minLength: 1 }), blocking: Type.Boolean() });
const reviewer = object({ context_id: id, model_provider: Type.String(), model_id: Type.String(),
  isolation: enumOf(['separate-agent', 'separate-session']) });
const assessment = {
  subject_ref: fileRefSchema, subject_sha256: digest, round: Type.Integer({ minimum: 1, maximum: 3 }),
  decision: enumOf(['approved', 'revise', 'blocked']), rules_version: Type.String({ minLength: 1 }),
  reviewer, checked_rules: Type.Array(Type.String({ pattern: '^(D(?:10|[1-9])|R[1-6])$' })), issues: Type.Array(issue), raw_ref: fileRefSchema,
};
const assertion = object({ assertion_id: id, step_id: id, source_id: id, oracle_type: oracle,
  target: Type.String({ minLength: 1 }), comparison: Type.String({ minLength: 1 }), expected: Type.Unknown(),
  observation: Type.String({ minLength: 1 }), evidence_required: Type.Boolean() });
const testcase = object({ case_id: id, module_id: id, feature_id: id, scenario_id: id,
  title: Type.String({ minLength: 1 }), priority: enumOf(['P0', 'P1', 'P2']), preconditions: strings,
  steps: Type.Array(object({ step_id: id, action: Type.String({ minLength: 1 }), assertion_ids: Type.Array(id) }), { minItems: 1 }),
  assertions: Type.Array(assertion, { minItems: 1 }), cleanup: Type.String({ minLength: 1 }),
  data_row_id: id, browser_project: id });
const instance = object({ instance_id: id, case_id: id, revision: id, data_row_id: id, browser_project: id });
export const finalStates = ['passed', 'failed', 'blocked', 'skipped', 'cancelled', 'not-run', 'flaky', 'unknown'] as const;
export const stages = ['discover-record', 'case-design', 'design-review', 'execute', 'analyze', 'result-review'] as const;
const bodies = {
  scope: object({ project_id: id, environment_id: id, role: Type.String({ minLength: 1 }), goal: Type.String({ minLength: 1 }),
    base_url: Type.Optional(Type.String()), allowed_actions: strings, sources: Type.Array(source),
    budget: object({ max_review_rounds: Type.Integer({ minimum: 1, maximum: 3 }), max_tool_calls: Type.Integer({ minimum: 1 }) }) }),
  inventory: object({ scope_ref: fileRefSchema, features: Type.Array(object({ module_id: id, feature_id: id,
    name: Type.String(), entry: Type.String(), role: Type.String({ minLength: 1 }), actions: strings,
    scenarios: Type.Array(object({ scenario_id: id, title: Type.String({ minLength: 1 }) })),
    coverage: enumOf(['discovered', 'explored', 'blocked']), source_refs: refs,
    source_locations: Type.Array(object({ ref: fileRefSchema, symbol: Type.String(), line: Type.Integer({ minimum: 1 }) })),
    discovery: enumOf(['source', 'browser', 'both', 'unconfirmed']),
    priority: enumOf(['P0', 'P1', 'P2']), states: strings, gaps: strings })), unexplored: strings,
    draft_refs: Type.Optional(refs) }),
  recording: object({ scope_ref: fileRefSchema, inventory_ref: fileRefSchema, initial_state: Type.String({ minLength: 1 }),
    status: enumOf(['complete', 'partial']), initial_state_ref: fileRefSchema, data_rules_ref: fileRefSchema,
    log_ref: fileRefSchema, script_refs: refs, steps: Type.Array(object({ step_id: id, intent: Type.String(),
      tool: Type.String(), observation_ref: fileRefSchema })), data_refs: refs,
    completion: object({ initial_state_rebuildable: Type.Boolean(), replaceable_data: Type.Boolean(),
      stable_locators: Type.Boolean(), assertion_sources: Type.Boolean(), cleanup_owned: Type.Boolean() }), gaps: strings }),
  cases: object({ scope_ref: fileRefSchema, sources: Type.Array(source), cases: Type.Array(testcase, { minItems: 1 }),
    data_rules_ref: fileRefSchema, gaps: strings }),
  asset: object({ revision: id, module_ids: Type.Array(id, { minItems: 1 }), scope_ref: fileRefSchema,
    cases_ref: fileRefSchema, recording_refs: refs, files: Type.Array(fileRefSchema, { minItems: 1 }),
    dependencies: Type.Array(object({ name: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }) })),
    readiness: enumOf(['design-only', 'runtime-verified']), content_sha256: digest, gaps: strings }),
  'design-review': object(assessment),
  task: object({ intent: enumOf(['record', 'execute', 'analyze', 'view', 'resume', 'rerun-failed', 'rerun-all']),
    scope_ref: fileRefSchema, state: enumOf(['pending', 'running', 'blocked', 'completed', 'cancelled']),
    stage: enumOf([...stages]), completed_stages: Type.Array(enumOf([...stages])), input_sha256: digest,
    asset_refs: refs, run_ids: Type.Array(id), output_refs: refs, blockers: strings }),
  run: object({ task_id: id, request_id: id, parent_run_id: Type.Optional(id), asset_ref: fileRefSchema,
    environment_id: id, deployment_version: Type.String(), role: Type.String(),
    plan: Type.Array(instance, { minItems: 1 }), state: enumOf(['pending', 'running', 'finished', 'interrupted', 'unknown']),
    command: strings, process_token: id, pid: Type.Optional(Type.Integer({ minimum: 1 })),
    exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])), output_refs: refs }),
  results: object({ run_ref: fileRefSchema, raw_ref: fileRefSchema, planned_count: Type.Integer({ minimum: 0 }),
    instances: Type.Array(object({ instance_id: id, status: enumOf([...finalStates]),
      evidence_state: enumOf(['complete', 'missing']), attempts: Type.Array(object({ attempt: Type.Integer({ minimum: 0 }),
        native_status: Type.String(), evidence_refs: refs, errors: strings })) })),
    counts: object(Object.fromEntries(finalStates.map(s => [s, Type.Integer({ minimum: 0 })]))) }),
  analysis: object({ run_ref: fileRefSchema, results_ref: fileRefSchema, findings: Type.Array(object({ instance_id: id,
    classification: enumOf(['product', 'script', 'data', 'environment', 'flaky', 'insufficient-evidence']),
    certainty: enumOf(['confirmed', 'supported', 'unknown']), facts: strings, hypotheses: strings,
    supporting_refs: refs, alternatives: strings, next_action: Type.String() })) }),
  'result-review': object(assessment),
  report: object({ run_ref: fileRefSchema, results_ref: fileRefSchema, analysis_ref: fileRefSchema,
    content_ref: fileRefSchema, completeness: enumOf(['complete', 'partial']), limitations: strings }),
};

// schema 是交接契约，不定义浏览器 DSL；真实步骤仍由 Playwright Test 执行。
function envelope<K extends keyof typeof bodies>(kind: K) {
  return object({ schema_version: Type.Literal('1.0'), id, kind: Type.Literal(kind),
    created_at: Type.String({ minLength: 20 }), data: bodies[kind] });
}
export const schemas = {
  scope: envelope('scope'), inventory: envelope('inventory'), recording: envelope('recording'), cases: envelope('cases'),
  asset: envelope('asset'), 'design-review': envelope('design-review'), task: envelope('task'), run: envelope('run'),
  results: envelope('results'), analysis: envelope('analysis'), 'result-review': envelope('result-review'), report: envelope('report'),
};
export type ArtifactKind = keyof typeof schemas;
export type Artifact<K extends ArtifactKind = ArtifactKind> = Static<(typeof schemas)[K]>;
export const errorCategories = ['invalid-input', 'incompatible-version', 'missing-capability', 'precondition',
  'review-rejected', 'runner-error', 'insufficient-evidence', 'cancelled'] as const;
export type ErrorCategory = typeof errorCategories[number];
export const capabilityResultSchema = object({ schema_version: Type.Literal('1.0'),
  capability_id: Type.String({ minLength: 1 }), capability_version: Type.String({ minLength: 1 }),
  status: enumOf(['completed', 'blocked', 'failed', 'cancelled']), artifact_refs: refs,
  errors: Type.Array(object({ category: enumOf([...errorCategories]), message: Type.String({ minLength: 1 }),
    recoverable: Type.Boolean(), recovery_stage: Type.Optional(Type.String()) })) });
export type CapabilityResult = Static<typeof capabilityResultSchema>;
export const capabilities = [{ capability_id: 'ui-validate-artifact', capability_version: '0.1.0',
  input_schema_version: '1.0', output_schema_version: '1.0',
  tool: 'ui_validate_artifact', side_effects: 'none', safe_to_repeat: true,
  requires: { pi: '1.2.0', schema: '1.0' }, errors: ['invalid-input', 'incompatible-version', 'precondition'],
}, { capability_id: 'ui-discover-record', capability_version: '0.1.0',
  input_schema_version: '1.0', output_schema_version: '1.0', tool: 'ui_discover_record',
  side_effects: 'project-files-and-browser-actions', safe_to_repeat: false,
  requires: { pi: '1.2.0', schema: '1.0', playwright: '1.62.1' },
  errors: ['invalid-input', 'missing-capability', 'precondition', 'cancelled'],
}];
