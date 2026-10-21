import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import lockfile from 'proper-lockfile';
import { Ajv } from 'ajv';
import { Type, type Static } from 'typebox';
import { ArtifactStore } from './store.js';
import { analysisInputs, composeReport } from './analysis.js';
import { fileRefSchema, resultCheckSchema, schemas, type Artifact, type FileRef } from './contracts.js';
import { fileRefs, sha256, verifyReferences, workspacePath, WorkflowError } from './validation.js';

const anchorSchema = Type.Object({ anchor_id: Type.String({ pattern: '^E[0-9]+L[0-9]+$' }) }, { additionalProperties: false });
export const resultDecisionSchema = Type.Object({ decision: Type.Enum(['approved', 'revise', 'blocked']),
  checked_rules: Type.Array(Type.String({ pattern: '^R[1-6]$' }), { minItems: 6, maxItems: 6, uniqueItems: true }),
  checks: Type.Array(Type.Object({ ...resultCheckSchema.properties,
    evidence: Type.Array(Type.Union([anchorSchema, resultCheckSchema.properties.evidence.items]), { minItems: 1 }) }, { additionalProperties: false }), { minItems: 6, maxItems: 6 }),
  issues: Type.Array(Type.Object({ ...schemas['result-review'].properties.data.properties.issues.items.properties,
    evidence_refs: Type.Array(Type.Union([anchorSchema, fileRefSchema]), { minItems: 1 }) }, { additionalProperties: false })),
  improvement: Type.Enum(['first', 'improved', 'none']),
}, { additionalProperties: false });
type Decision = Static<typeof resultDecisionSchema>;
type Evidence = { ref: FileRef; content: string; anchors: { anchor_id: string; quote: string }[] };
type StaticCheck = { issues: { rule: string; reason: string; evidence_refs: FileRef[]; blocking: boolean }[] };
type ReviewInput = { system_prompt: string; context_id: string; response_schema: typeof resultDecisionSchema;
  evidence: Evidence[]; static_check: StaticCheck; previous?: Artifact<'result-review'> };
type Call = (input: ReviewInput) => Promise<{ raw: string; provider: string; model: string; stop_reason?: string }>;
type Attempt = { request_id: string; report_ref: FileRef; state: 'pending' | 'completed' | 'error';
  review_ref?: FileRef; input_ref?: FileRef; raw_ref?: FileRef; static_ref?: FileRef };
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const same = (a: FileRef, b: FileRef) => a.path === b.path && a.sha256 === b.sha256;
const validate = new Ajv({ strict: true, allErrors: true }).compile(resultDecisionSchema);
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(json(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
async function rules() {
  const prompt = await readFile(new URL('../skills/ui-result-review/references/rules.md', import.meta.url), 'utf8');
  return { prompt, version: `R1-R6/1.0:${sha256(json([prompt, resultDecisionSchema]))}` };
}

export async function checkReport(root: string, reportRef: FileRef) {
  const store = new ArtifactStore(root), report = await store.load(reportRef) as Artifact<'report'>;
  if (report.kind !== 'report') throw new WorkflowError('invalid-input', '结果评估需要报告候选');
  const built = await composeReport(root, report.data.results_ref, report.data.analysis_ref, report.id);
  const check: StaticCheck = { issues: built.input.details.issues.map(i => ({ rule: i.rule, reason: i.reason,
    evidence_refs: [reportRef, built.input.data.raw_ref], blocking: true })) };
  const content = await readFile(await workspacePath(root, report.data.content_ref.path), 'utf8');
  if (!report.data.follow_up_ref || report.data.follow_up_ref.sha256 !== sha256(json(built.followUp)) ||
      !same(report.data.run_ref, built.input.data.run_ref) || content !== built.content || report.data.completeness !== (built.input.details.complete ? 'complete' : 'partial') ||
      json(report.data.limitations) !== json(built.limitations)) {
    check.issues.push({ rule: 'R5', reason: '报告正文、范围、完整性或限制与确定性统计/分析不一致', evidence_refs: [reportRef, report.data.content_ref], blocking: true });
  }
  return { report, built, check };
}

/** 新的只读评估上下文审查 R1–R6；私有登记不能由项目中的 approved 字段替代。 */
export class ResultReviewService {
  readonly store: ArtifactStore;
  constructor(readonly root: string, readonly authorityRoot: string) { this.store = new ArtifactStore(root); }
  async assess(reportRef: FileRef, requestId: string, call: Call) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(requestId)) throw new WorkflowError('invalid-input', '结果评估请求 ID 无效');
    const report = await this.store.load(reportRef) as Artifact<'report'>;
    if (report.kind !== 'report') throw new WorkflowError('invalid-input', '需要报告候选');
    const budget = (await analysisInputs(this.root, report.data.results_ref)).scope.data.budget.max_review_rounds;
    const group = sha256(json(report.data.run_ref)), directory = join(this.authorityRoot, 'result-loops', group);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let release;
    try { release = await lockfile.lock(directory, { realpath: true, retries: 0 }); }
    catch { throw new WorkflowError('precondition', '该批次已有结果评估在执行'); }
    try {
      const names = (await readdir(directory)).filter(n => /^attempt-[1-3]\.json$/.test(n)).sort();
      const attempts: Attempt[] = await Promise.all(names.map(async n => JSON.parse(await readFile(join(directory, n), 'utf8'))));
      const duplicate = attempts.find(a => a.request_id === requestId);
      if (duplicate) {
        if (!same(duplicate.report_ref, reportRef)) throw new WorkflowError('precondition', '同一结果评估请求不能改变报告');
        if (duplicate.state !== 'completed' || !duplicate.review_ref) throw new WorkflowError('precondition', '旧评估未确认完成，不自动重放模型调用', false,
          [duplicate.input_ref, duplicate.raw_ref, duplicate.static_ref].filter((r): r is FileRef => !!r));
        const saved = await this.store.load(duplicate.review_ref) as Artifact<'result-review'>;
        return { review_ref: duplicate.review_ref, decision: saved.data.decision, round: saved.data.round };
      }
      if (attempts.some(a => a.state === 'pending')) throw new WorkflowError('precondition', '已有结果不明的评估，须先核对旧请求');
      if (attempts.length >= Math.min(3, budget)) throw new WorkflowError('review-rejected', '结果评估预算已耗尽，不自动批准');
      const previous = attempts.at(-1)?.review_ref ? await this.store.load(attempts.at(-1)!.review_ref!) as Artifact<'result-review'> : undefined;
      if (previous?.data.decision === 'blocked') throw new WorkflowError('review-rejected', '上一轮已阻塞，不能换 ID 绕过');
      const round = attempts.length + 1, contextId = randomUUID(), reviewId = `result-${contextId}`;
      const base = `${posix.dirname(reportRef.path)}/reviews/${reviewId}`, path = join(directory, `attempt-${round}.json`);
      const attempt: Attempt = { request_id: requestId, report_ref: reportRef, state: 'pending' };
      await atomic(path, attempt);
      try {
        const { built, check } = await checkReport(this.root, reportRef), rule = await rules();
        const refs = fileRefs([built.input.allowed, reportRef, report, built.input.saved]);
        const evidence: Evidence[] = [];
        for (const ref of [...new Map(refs.map(r => [r.path, r])).values()]) {
          if (/\.(png|jpe?g|zip|webm|mp4|pdf)$/i.test(ref.path)) continue;
          try {
            await verifyReferences(this.root, ref);
            const content = await readFile(await workspacePath(this.root, ref.path), 'utf8');
            const index = evidence.length + 1;
            evidence.push({ ref, content, anchors: content.split('\n').map((line, n) => ({ anchor_id: `E${index}L${n + 1}`, quote: line.trim().slice(0, 320) }))
              .filter(a => /[\p{L}\p{N}]/u.test(a.quote)).slice(0, 100) });
          } catch {
            check.issues.push({ rule: 'R3', reason: '评估原始来源或执行证据不可读取，不能完整批准', evidence_refs: [reportRef], blocking: true });
          }
        }
        const input: ReviewInput = { system_prompt: rule.prompt, context_id: contextId, response_schema: resultDecisionSchema,
          evidence, static_check: check, ...(previous ? { previous } : {}) };
        if (Buffer.byteLength(json(input)) > 1024 * 1024) throw new WorkflowError('insufficient-evidence', '原始评估输入超过预算，不截断后审批');
        attempt.input_ref = await this.store.putFile(`${base}/input.json`, json(input));
        attempt.static_ref = await this.store.putFile(`${base}/static.json`, json(check));await atomic(path, attempt);
        const response = await call(input);
        attempt.raw_ref = await this.store.putFile(`${base}/raw.json`, json(response));
        if (response.stop_reason && ['aborted', 'error', 'length'].includes(response.stop_reason)) throw new WorkflowError('review-rejected', '评估响应未正常完成，不批准');
        let decision: Decision;
        try { decision = JSON.parse(response.raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
        catch { throw new WorkflowError('review-rejected', '结果评估响应不是有效 JSON'); }
        if (!validate(decision) || new Set(decision.checks.map(c => c.rule)).size !== 6 ||
            decision.checks.some(c => c.verdict === 'not-applicable')) throw new WorkflowError('review-rejected', '结果评估缺少完整 R1–R6 或结构不合法');
        const anchor = (id: string) => {
          for (const file of evidence) { const found = file.anchors.find(a => a.anchor_id === id);if (found) return { ref: file.ref, quote: found.quote }; }
          throw new WorkflowError('review-rejected', '结果评估引用不存在的片段');
        };
        const checks = decision.checks.map(c => ({ ...c, evidence: c.evidence.map(e => 'anchor_id' in e ? anchor(e.anchor_id) : e) }));
        const issues = decision.issues.map(i => ({ ...i, evidence_refs: i.evidence_refs.map(r => 'anchor_id' in r ? anchor(r.anchor_id).ref : r) }));
        for (const check of checks) for (const citation of check.evidence) {
          if (!evidence.some(e => same(e.ref, citation.ref) && e.content.includes(citation.quote))) throw new WorkflowError('review-rejected', '结果评估引文不属于原始输入');
        }
        if (issues.some(i => !i.rule.startsWith('R') || i.evidence_refs.some(r => !evidence.some(e => same(e.ref, r))))) throw new WorkflowError('review-rejected', '结果评估问题引用无效');
        if ((!previous && decision.improvement !== 'first') || (previous && decision.improvement === 'first')) throw new WorkflowError('review-rejected', '结果评估改善状态与历史不一致');
        for (const [index, failure] of check.issues.entries()) {
          const checked = checks.find(c => c.rule === failure.rule)!;checked.verdict = 'fail';checked.reason = failure.reason;
          issues.push({ id: `static-${index}`, ...failure, fix_condition: '修正该问题后生成新的结果/报告修订并重新评估' });
        }
        if (check.issues.length && decision.decision === 'approved') decision.decision = 'revise';
        for (const checked of checks) if (checked.verdict === 'fail' && !issues.some(i => i.rule === checked.rule && i.blocking)) {
          if (decision.decision === 'approved') throw new WorkflowError('review-rejected', '失败规则不能同时批准');
          issues.push({ id: `check-${checked.rule}`, rule: checked.rule, reason: checked.reason,
            evidence_refs: checked.evidence.map(e => e.ref), fix_condition: '补充证据或修订报告后重新评估', blocking: true });
        }
        if (decision.decision === 'approved' && issues.some(i => i.blocking)) throw new WorkflowError('review-rejected', '阻断问题不能批准');
        if (previous && decision.decision !== 'approved' && (decision.improvement === 'none' || same(previous.data.subject_ref, reportRef))) decision.decision = 'blocked';
        const review: Artifact<'result-review'> = { schema_version: '1.0', kind: 'result-review', id: reviewId, created_at: new Date().toISOString(), data: {
          subject_ref: reportRef, subject_sha256: reportRef.sha256, round, decision: decision.decision, rules_version: rule.version,
          reviewer: { context_id: contextId, model_provider: response.provider, model_id: response.model, isolation: 'separate-agent' },
          checked_rules: decision.checked_rules, checks, issues, improvement: decision.improvement,
          raw_ref: attempt.raw_ref, input_ref: attempt.input_ref, static_ref: attempt.static_ref,
          ...(previous ? { previous_review_ref: attempts.at(-1)!.review_ref! } : {}) } };
        const reviewRef = await this.store.put(review);
        if (review.data.decision === 'approved') await atomic(join(this.authorityRoot, 'result-accepted', `${reviewRef.sha256}.json`), {
          report_ref: reportRef, review_ref: reviewRef, rules_version: rule.version, context_id: contextId });
        await atomic(path, { ...attempt, state: 'completed', review_ref: reviewRef });
        return { review_ref: reviewRef, decision: review.data.decision, round };
      } catch (error) {
        await atomic(path, { ...attempt, state: 'error' });
        throw new WorkflowError(error instanceof WorkflowError ? error.category : 'runner-error',
          error instanceof WorkflowError ? error.message : '结果评估调用失败，不批准', false,
          [attempt.input_ref, attempt.raw_ref, attempt.static_ref].filter((r): r is FileRef => !!r));
      }
    } finally { await release(); }
  }
  async gate(reportRef: FileRef, reviewRef: FileRef) {
    const { report, check } = await checkReport(this.root, reportRef);
    const review = await this.store.load(reviewRef) as Artifact<'result-review'>;
    if (review.kind !== 'result-review' || review.data.decision !== 'approved' || !same(review.data.subject_ref, reportRef)) throw new WorkflowError('review-rejected', '报告没有对应的完整批准');
    let trusted;
    try { trusted = JSON.parse(await readFile(join(this.authorityRoot, 'result-accepted', `${reviewRef.sha256}.json`), 'utf8')); }
    catch { throw new WorkflowError('review-rejected', '报告批准未经过独立评估路径登记'); }
    if (!same(trusted.report_ref, reportRef) || !same(trusted.review_ref, reviewRef) || trusted.context_id !== review.data.reviewer.context_id ||
        trusted.rules_version !== (await rules()).version || review.data.rules_version !== trusted.rules_version || check.issues.length || report.data.completeness !== 'complete') {
      throw new WorkflowError('review-rejected', '报告批准或证据已失效，不能交付为完整报告');
    }
    return { report, review };
  }
  async deliver(reportRef: FileRef, reviewRef?: FileRef) {
    const { report, built, check } = await checkReport(this.root, reportRef);
    // 阶段报告也必须保持正文与当前对账一致，不能以 partial 为由交付错误数字。
    if (sha256(built.content) !== report.data.content_ref.sha256 || check.issues.some(i => i.rule === 'R5')) throw new WorkflowError('review-rejected', '报告正文或元数据不是当前确定性结果');
    const accepted = reviewRef ? await this.gate(reportRef, reviewRef) : undefined;
    if (!reviewRef && report.data.completeness !== 'partial') throw new WorkflowError('review-rejected', '完整报告必须先通过独立结果评估');
    const prefix = reviewRef ? '状态：独立结果评估通过。产品是否通过请阅读各实例结果。'
      : '状态：阶段报告；完整性未通过，未获得完整报告批准。';
    const deliveryDir = `${posix.dirname(reportRef.path)}/delivery`;
    const rendered = await composeReport(this.root, report.data.results_ref, report.data.analysis_ref, report.id, deliveryDir);
    const approval = accepted && reviewRef ? `\n\n评估记录：[${accepted.review.id}](${posix.relative(deliveryDir, reviewRef.path)})；规则版本：${accepted.review.data.rules_version}；报告版本：${reportRef.sha256}。` : '';
    const ref = await this.store.putFile(`${deliveryDir}/${reviewRef?.sha256 ?? 'partial'}.md`, `${prefix}${approval}\n\n${rendered.content}`);
    return { delivery_ref: ref, completeness: report.data.completeness, independently_approved: !!reviewRef };
  }
}
