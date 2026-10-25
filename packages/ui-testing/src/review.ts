import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import lockfile from 'proper-lockfile';
import { Ajv } from 'ajv';
import { Type, type Static } from 'typebox';
import { ArtifactStore } from './store.js';
import { checkDesign, designEvidence, type DesignCheck } from './design.js';
import { assessmentCheckSchema, fileRefSchema, schemas, type Artifact, type FileRef } from './contracts.js';
import { sha256, validateArtifact, verifyReferences, WorkflowError } from './validation.js';

const anchorRef = Type.Object({ anchor_id: Type.String({ pattern: '^E[0-9]+L[0-9]+$' }) }, { additionalProperties: false });
const issueSchema = schemas['design-review'].properties.data.properties.issues.items;
export const designDecisionSchema = Type.Object({ decision: Type.Enum(['approved', 'revise', 'blocked']),
  checked_rules: Type.Array(Type.String({ pattern: '^D(?:10|[1-9])$' }), { minItems: 10, maxItems: 10, uniqueItems: true }),
  issues: Type.Array(Type.Object({ ...issueSchema.properties,
    evidence_refs: Type.Array(Type.Union([anchorRef, fileRefSchema])) }, { additionalProperties: false })),
  checks: Type.Array(Type.Object({ ...assessmentCheckSchema.properties,
    evidence: Type.Array(Type.Union([anchorRef, assessmentCheckSchema.properties.evidence.items]), { minItems: 1 }) },
  { additionalProperties: false }), { minItems: 10, maxItems: 10 }),
  improvement: Type.Enum(['first', 'improved', 'none']),
}, { additionalProperties: false });
export type DesignDecision = Static<typeof designDecisionSchema>;
type ReviewEvidence = Awaited<ReturnType<typeof designEvidence>>[number] & { anchors: { anchor_id: string; quote: string }[] };
type ReviewCall = (input: { system_prompt: string; context_id: string; evidence: ReviewEvidence[]; static_check: DesignCheck;
  response_schema: typeof designDecisionSchema;
  previous?: Artifact<'design-review'> }) => Promise<{ raw: string; provider: string; model: string; stop_reason?: string }>;
type Attempt = { request_id: string; round: number; asset_ref: FileRef; state: 'pending' | 'completed' | 'error';
  review_ref?: FileRef; raw_ref?: FileRef; input_ref?: FileRef; static_ref?: FileRef; error?: string };
const validate = new Ajv({ strict: true, allErrors: true }).compile(designDecisionSchema);
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const same = (a: FileRef, b: FileRef) => a.path === b.path && a.sha256 === b.sha256;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export type ReviewBudgetAuthorization = { authorization_id: string; additional_rounds: number; reason: string };
export type ReviewBudgetGrant = ReviewBudgetAuthorization & { task_ref: FileRef; asset_ref: FileRef;
  used_rounds: number; previous_limit: number; total_limit: number; created_at: string };

/** 私有登记只保存信任凭据和调用预算；业务资产/评估内容仍以项目 manifest 为唯一权威。 */
export class DesignReviewService {
  readonly store: ArtifactStore;
  constructor(readonly root: string, readonly authorityRoot: string) { this.store = new ArtifactStore(root); }
  private async atomic(path: string, value: unknown): Promise<void> {
    const parent = dirname(path); await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(json(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  }
  private async attempts(dir: string): Promise<Attempt[]> {
    const names = (await readdir(dir)).filter(n => /^attempt-\d+\.json$/.test(n));
    return Promise.all(names.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])).map(async n => JSON.parse(await readFile(join(dir, n), 'utf8'))));
  }
  private async grants(dir: string): Promise<ReviewBudgetGrant[]> {
    const names = (await readdir(dir)).filter(n => /^grant-[a-f0-9]{64}\.json$/.test(n));
    return Promise.all(names.map(async name => JSON.parse(await readFile(join(dir, name), 'utf8'))));
  }
  /** 仅供受信任宿主：先取得用户明确授权，再追加私有预算。不得登记为模型可调用工具。
   * 保留原 scope、循环和尝试；额度变更不产生批准，也不重放未知请求。费用由宿主另行限制。 */
  async renewBudget(taskRef: FileRef, assetRef: FileRef, authorization: ReviewBudgetAuthorization,
    authorize: (request: ReviewBudgetAuthorization & { task_ref: FileRef; asset_ref: FileRef; used_rounds: number; current_limit: number }) => Promise<boolean>): Promise<ReviewBudgetGrant> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(authorization.authorization_id) ||
      !Number.isInteger(authorization.additional_rounds) || authorization.additional_rounds < 1 || authorization.additional_rounds > 3 ||
      !authorization.reason?.trim() || authorization.reason.length > 2000) throw new WorkflowError('invalid-input', '续授需要授权 ID、原因及 1 到 3 次额度');
    const task = await this.store.load(taskRef) as Artifact<'task'>, asset = await this.store.load(assetRef) as Artifact<'asset'>;
    if (task.kind !== 'task' || asset.kind !== 'asset' || !same(task.data.scope_ref, asset.data.scope_ref) ||
      ['completed', 'cancelled'].includes(task.data.state) || task.data.stage !== 'design-review') throw new WorkflowError('precondition', '续授须绑定同一范围的未终结设计评估任务');
    const scope = await this.store.load(task.data.scope_ref) as Artifact<'scope'>;
    const group = sha256(json([task.id, task.data.input_sha256, task.data.scope_ref, [...asset.data.module_ids].sort()]));
    const dir = join(this.authorityRoot, 'loops', group); await mkdir(dir, { recursive: true, mode: 0o700 });
    let release;
    try { release = await lockfile.lock(dir, { realpath: true, retries: 0 }); }
    catch { throw new WorkflowError('precondition', '该评估循环已有操作在执行'); }
    try {
      const attempts = await this.attempts(dir), grants = await this.grants(dir);
      const old = grants.find(g => g.authorization_id === authorization.authorization_id);
      if (old) {
        if (old.additional_rounds !== authorization.additional_rounds || old.reason !== authorization.reason || !same(old.asset_ref, assetRef))
          throw new WorkflowError('precondition', '同一授权 ID 不可改变额度、原因或候选');
        return old;
      }
      if (attempts.some(a => a.state === 'pending')) throw new WorkflowError('precondition', '已有结果不明的评估，不能续授后重放');
      const currentLimit = scope.data.budget.max_review_rounds + grants.reduce((n, g) => n + g.additional_rounds, 0);
      if (typeof authorize !== 'function' || !await authorize({ ...authorization, task_ref: taskRef, asset_ref: assetRef,
        used_rounds: attempts.length, current_limit: currentLimit })) throw new WorkflowError('review-rejected', '未取得宿主用户明确授权，不追加额度');
      // 授权等待期间仍持锁；写入前重验任务、候选及其依赖，拒绝过期对象。
      await this.store.load(taskRef); await this.store.load(assetRef);
      const grant: ReviewBudgetGrant = { ...authorization, task_ref: taskRef, asset_ref: assetRef, used_rounds: attempts.length,
        previous_limit: currentLimit, total_limit: currentLimit + authorization.additional_rounds, created_at: new Date().toISOString() };
      await this.atomic(join(dir, `grant-${sha256(authorization.authorization_id)}.json`), grant);
      return grant;
    } finally { await release(); }
  }
  async assess(taskRef: FileRef, assetRef: FileRef, requestId: string, call: ReviewCall): Promise<{ review_ref: FileRef; decision: string; round: number }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(requestId)) throw new WorkflowError('invalid-input', '评估请求 ID 无效');
    const task = await this.store.load(taskRef) as Artifact<'task'>, asset = await this.store.load(assetRef) as Artifact<'asset'>;
    if (task.kind !== 'task' || asset.kind !== 'asset' || !same(task.data.scope_ref, asset.data.scope_ref) || ['completed', 'cancelled'].includes(task.data.state)) {
      throw new WorkflowError('precondition', '评估须绑定相同范围的未终结任务与候选');
    }
    const scope = await this.store.load(task.data.scope_ref) as Artifact<'scope'>;
    const group = sha256(json([task.id, task.data.input_sha256, task.data.scope_ref, [...asset.data.module_ids].sort()]));
    const dir = join(this.authorityRoot, 'loops', group); await mkdir(dir, { recursive: true, mode: 0o700 });
    let release;
    try { release = await lockfile.lock(dir, { realpath: true, retries: 0 }); }
    catch { throw new WorkflowError('precondition', '该评估循环已有评估在执行'); }
    try {
      const attempts = await this.attempts(dir), duplicate = attempts.find(a => a.request_id === requestId);
      if (duplicate) {
        if (!same(duplicate.asset_ref, assetRef)) throw new WorkflowError('precondition', '同一评估请求不能更换候选');
        if (duplicate.state !== 'completed' || !duplicate.review_ref) throw new WorkflowError('precondition', '旧评估未确认完成或已失败，不自动重复模型调用', false,
          [duplicate.raw_ref, duplicate.input_ref, duplicate.static_ref].filter((r): r is FileRef => !!r));
        const review = await this.store.load(duplicate.review_ref) as Artifact<'design-review'>;
        return { review_ref: duplicate.review_ref, decision: review.data.decision, round: duplicate.round };
      }
      if (attempts.some(a => a.state === 'pending')) throw new WorkflowError('precondition', '已有结果不明的评估，先核对旧调用');
      const grants = await this.grants(dir);
      const limit = scope.data.budget.max_review_rounds + grants.reduce((n, g) => n + g.additional_rounds, 0);
      if (attempts.length >= limit) throw new WorkflowError('review-rejected', '设计评估预算已耗尽，不自动批准');
      const last = attempts.at(-1), previous = last?.review_ref ? await this.store.load(last.review_ref) as Artifact<'design-review'> : undefined;
      if (previous?.data.decision === 'blocked') throw new WorkflowError('review-rejected', '上一轮已阻塞，需补充事实或明确新的任务范围');
      const round = attempts.length + 1, contextId = randomUUID(), reviewId = `design-${contextId}`;
      const base = `${posix.dirname(assetRef.path)}/reviews/${reviewId}`;
      const attempt: Attempt = { request_id: requestId, round, asset_ref: assetRef, state: 'pending' };
      const attemptPath = join(dir, `attempt-${round}.json`);
      await this.atomic(attemptPath, attempt);
      let rawRef: FileRef | undefined, inputRef: FileRef | undefined, staticRef: FileRef | undefined;
      try {
        const staticCheck = await checkDesign(this.root, assetRef);
        const evidence: ReviewEvidence[] = (await designEvidence(this.root, assetRef)).map((f, index) => ({ ...f,
          anchors: f.content.split('\n').map((line, n) => ({ anchor_id: `E${index + 1}L${n + 1}`, quote: line.trim().slice(0, 320) }))
            .filter(a => /[\p{L}\p{N}]/u.test(a.quote)).slice(0, 100),
        }));
        staticRef = await this.store.putFile(`${base}/static.json`, json(staticCheck));
        const systemPrompt = await readFile(new URL('../skills/ui-design-review/references/rules.md', import.meta.url), 'utf8');
        const rulesVersion = `D1-D10/1.0:${sha256(json([systemPrompt, designDecisionSchema]))}`;
        const input = { system_prompt: systemPrompt, context_id: contextId, evidence, static_check: staticCheck,
          response_schema: designDecisionSchema, ...(previous ? { previous } : {}) };
        const inputJson = json(input);
        if (Buffer.byteLength(inputJson) > 1024 * 1024) throw new WorkflowError('insufficient-evidence', '完整评估输入超过预算，请拆分范围；不截断原文后继续审批');
        inputRef = await this.store.putFile(`${base}/input.json`, inputJson);
        await this.atomic(attemptPath, { ...attempt, input_ref: inputRef, static_ref: staticRef });
        const response = await call(input);
        rawRef = await this.store.putFile(`${base}/raw.json`, json({ response: response.raw, provider: response.provider, model: response.model, context_id: contextId, stop_reason: response.stop_reason }));
        if (response.stop_reason && ['error', 'aborted', 'length'].includes(response.stop_reason)) throw new WorkflowError('review-rejected', '评估响应未正常完成，保留原文且不批准');
        let decision: DesignDecision;
        try { decision = JSON.parse(response.raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
        catch { throw new WorkflowError('review-rejected', '评估输出不是有效 JSON，保留原始响应且不批准'); }
        if (!validate(decision)) throw new WorkflowError('review-rejected', '评估输出未满足完整规则和证据契约');
        const anchor = (id: string) => {
          for (const file of evidence) {
            const item = file.anchors.find(a => a.anchor_id === id);
            if (item) return { ref: file.ref, quote: item.quote };
          }
          throw new WorkflowError('review-rejected', '评估引用了不存在的原文片段标识');
        };
        // 由程序还原片段的原始引用，模型不必抄写摘要和多行文本；仍核验原始文件字节。
        const canonicalChecks = decision.checks.map(c => ({ ...c, evidence: c.evidence.map(e => 'anchor_id' in e ? anchor(e.anchor_id) : e) }));
        const canonicalIssues = decision.issues.map(i => ({ ...i, evidence_refs: i.evidence_refs.map(r => 'anchor_id' in r ? anchor(r.anchor_id).ref : r) }));
        if (new Set(decision.checks.map(c => c.rule)).size !== 10 || decision.checks.some(c => c.verdict === 'not-applicable' && c.rule !== 'D7')) {
          throw new WorkflowError('review-rejected', '逐项评估重复、缺失或跳过必需规则');
        }
        for (const check of canonicalChecks) for (const item of check.evidence) {
          const source = evidence.find(f => same(f.ref, item.ref));
          if (!source || !source.content.includes(item.quote)) throw new WorkflowError('review-rejected', '评估引用了输入之外的文件或不存在的引文');
        }
        for (const issue of canonicalIssues) if (!issue.evidence_refs.length || issue.evidence_refs.some(r => !evidence.some(f => same(f.ref, r)))) {
          throw new WorkflowError('review-rejected', '评估问题缺少可核对的输入证据');
        }
        if ((!previous && decision.improvement !== 'first') || (previous && decision.improvement === 'first')) throw new WorkflowError('review-rejected', '评估改善状态与历史不一致');
        // 确定性阻断不会被模型的 approved 覆盖；原始模型意见仍保留在 raw.json。
        const staticFailures = staticCheck.issues.filter(i => i.blocking);
        for (const check of canonicalChecks) {
          const failures = staticFailures.filter(f => f.rule === check.rule);
          if (failures.length) { check.verdict = 'fail'; check.reason = failures.map(f => f.reason).join('\n'); }
        }
        for (const failure of staticFailures) if (!canonicalIssues.some(i => i.rule === failure.rule && i.case_id === failure.case_id && i.assertion_id === failure.assertion_id)) {
          canonicalIssues.push({ ...failure, id: `deterministic-${failure.id}` });
        }
        // 退回结果中的逐项失败已经含理由与原文证据；补齐问题索引，避免仅因未重复写 issues 丢失有效退回。
        if (decision.decision !== 'approved') for (const check of canonicalChecks) {
          if (check.verdict === 'fail' && !canonicalIssues.some(i => i.rule === check.rule && i.blocking)) canonicalIssues.push({
            id: `derived-check-${check.rule}`, rule: check.rule, reason: check.reason,
            evidence_refs: check.evidence.map(e => e.ref), fix_condition: `提交新修订并在重新评估中消除此原问题：${check.reason}`, blocking: true,
          });
        }
        if (canonicalChecks.some(c => c.verdict === 'fail' && !canonicalIssues.some(i => i.rule === c.rule && i.blocking))) {
          throw new WorkflowError('review-rejected', '失败规则没有对应阻断问题');
        }
        if (staticFailures.length && decision.decision === 'approved') decision.decision = 'revise';
        if (decision.decision === 'approved' && (canonicalChecks.some(c => c.verdict === 'fail') || canonicalIssues.some(i => i.blocking))) {
          throw new WorkflowError('review-rejected', '评估不能在失败规则或阻断问题下批准');
        }
        if (previous?.data.decision === 'revise' && decision.decision !== 'approved' &&
            (decision.improvement === 'none' || same(previous.data.subject_ref, assetRef))) decision.decision = 'blocked';
        const review = validateArtifact({ schema_version: '1.0', id: reviewId, kind: 'design-review', created_at: new Date().toISOString(),
          data: { subject_ref: assetRef, subject_sha256: assetRef.sha256, round, decision: decision.decision, rules_version: rulesVersion,
            reviewer: { context_id: contextId, model_provider: response.provider, model_id: response.model, isolation: 'separate-agent' },
            checked_rules: decision.checked_rules, checks: canonicalChecks, improvement: decision.improvement, issues: canonicalIssues,
            raw_ref: rawRef, static_ref: staticRef, input_ref: inputRef, ...(last?.review_ref ? { previous_review_ref: last.review_ref } : {}) } });
        const reviewRef = await this.store.put(review);
        if (decision.decision === 'approved') await this.atomic(join(this.authorityRoot, 'accepted', `${reviewRef.sha256}.json`), {
          review_ref: reviewRef, asset_ref: assetRef, rules_version: rulesVersion, context_id: contextId,
        });
        await this.atomic(attemptPath, { ...attempt, state: 'completed', review_ref: reviewRef });
        return { review_ref: reviewRef, decision: decision.decision, round };
      } catch (error) {
        await this.atomic(attemptPath, { ...attempt, state: 'error', error: error instanceof WorkflowError ? error.category : 'runner-error',
          ...(rawRef ? { raw_ref: rawRef } : {}), ...(inputRef ? { input_ref: inputRef } : {}), ...(staticRef ? { static_ref: staticRef } : {}) });
        throw new WorkflowError(error instanceof WorkflowError ? error.category : 'runner-error',
          error instanceof WorkflowError ? error.message : '评估调用失败；保留已有输入与响应，不批准', false,
          [rawRef, inputRef, staticRef].filter((r): r is FileRef => !!r));
      }
    } finally { await release(); }
  }
  async gate(assetRef: FileRef, reviewRef: FileRef, requireRuntime = true): Promise<DesignCheck> {
    const review = await this.store.load(reviewRef) as Artifact<'design-review'>;
    if (review.kind !== 'design-review' || review.data.decision !== 'approved' || !same(review.data.subject_ref, assetRef) || review.data.subject_sha256 !== assetRef.sha256) {
      throw new WorkflowError('review-rejected', '资产没有匹配当前摘要的设计批准');
    }
    let trusted;
    try { trusted = JSON.parse(await readFile(join(this.authorityRoot, 'accepted', `${reviewRef.sha256}.json`), 'utf8')); }
    catch (error) { if (!absent(error)) throw error; throw new WorkflowError('review-rejected', '评估没有经独立评估调用路径登记'); }
    if (!same(trusted.review_ref, reviewRef) || !same(trusted.asset_ref, assetRef) || trusted.context_id !== review.data.reviewer.context_id) {
      throw new WorkflowError('review-rejected', '批准登记与评估版本不匹配');
    }
    const rulesVersion = `D1-D10/1.0:${sha256(json([await readFile(new URL('../skills/ui-design-review/references/rules.md', import.meta.url), 'utf8'), designDecisionSchema]))}`;
    if (review.data.rules_version !== rulesVersion || trusted.rules_version !== rulesVersion) throw new WorkflowError('review-rejected', '评估规则已变化，旧批准不能直接沿用');
    const check = await checkDesign(this.root, assetRef);
    await designEvidence(this.root, assetRef);
    await verifyReferences(this.root, review);
    if (check.issues.some(i => i.blocking)) throw new WorkflowError('review-rejected', '当前候选存在确定性阻断问题');
    if (requireRuntime) {
      const { verifyRuntimeAdmission } = await import('./runtime-admission.js');
      await verifyRuntimeAdmission(this.root, this.authorityRoot, assetRef, reviewRef);
    }
    return check;
  }
}
