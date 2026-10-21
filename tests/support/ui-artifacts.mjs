export const digest = 'a'.repeat(64);
export const ref = (path = 'requirements.md') => ({ path, sha256: digest });
export const artifact = (kind, data, id = `${kind}-1`) => ({
  schema_version: '1.0', id, kind, created_at: '2026-10-21T00:00:00.000Z', data,
});
export const scope = () => artifact('scope', {
  project_id: 'project-1', environment_id: 'test', role: 'tester', goal: 'Save Name and verify persistence',
  allowed_actions: ['create-owned-name'], sources: [{ source_id: 'R1', oracle_type: 'requirement',
    ref: ref(), statement: 'Saved Name persists after reload.' }],
  budget: { max_review_rounds: 3, max_tool_calls: 20 },
});
export const cases = () => artifact('cases', {
  scope_ref: ref('scope.json'), sources: scope().data.sources, data_rules_ref: ref('data-rules.json'), gaps: [],
  cases: [{ case_id: 'C1', module_id: 'names', feature_id: 'save', scenario_id: 'valid-name',
    title: 'Name persists', priority: 'P0', preconditions: ['Independent browser context'],
    steps: [{ step_id: 'S1', action: 'Save Name, then reload', assertion_ids: ['A1'] }],
    assertions: [{ assertion_id: 'A1', step_id: 'S1', source_id: 'R1', oracle_type: 'requirement',
      target: 'Saved names list', comparison: 'toHaveText', expected: ['owned-name'],
      observation: 'after save and reload', evidence_required: true }],
    cleanup: 'Close isolated context', data_row_id: 'default', browser_project: 'chromium' }],
});
export const designReview = () => artifact('design-review', {
  subject_ref: ref('asset.json'), subject_sha256: digest, round: 1, decision: 'approved', rules_version: '1.0',
  reviewer: { context_id: 'review-context-1', model_provider: 'fixture', model_id: 'protocol', isolation: 'separate-agent' },
  checked_rules: Array.from({ length: 10 }, (_, i) => `D${i + 1}`), issues: [], raw_ref: ref('review-raw.json'),
});
