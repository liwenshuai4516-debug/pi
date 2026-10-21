import { test as base, expect, type TestInfo } from '@playwright/test';
import { ArtifactStore } from './store.js';
import { UiDataScope, authState, validateEnvironment, type DataOwner, type UiEnvironment } from './environment.js';
import { WorkflowError } from './validation.js';

export type UiOptions = { uiEnvironment: UiEnvironment | undefined; uiOwner: DataOwner | undefined; uiProjectRoot: string };
export type UiFixtures = { uiData: UiDataScope };
async function attach(info: TestInfo, name: string, value: unknown) {
  await info.attach(name, { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' });
}

/** 复用 Playwright 原生 test/page/context/teardown，不另建浏览器生命周期或执行器。 */
export const test = base.extend<UiFixtures & UiOptions>({
  uiEnvironment: [undefined, { option: true }], uiOwner: [undefined, { option: true }],
  uiProjectRoot: [process.cwd(), { option: true }],
  storageState: async ({ uiEnvironment }, use, info) => {
    if (!uiEnvironment) throw new WorkflowError('precondition', '缺少 UI 环境配置');
    let state: string | undefined;
    try { state = await authState(validateEnvironment(uiEnvironment)); }
    catch (error) {
      await attach(info, 'ui-preflight', { status: 'blocked', category: 'precondition', check: 'auth-reference' });
      throw error;
    }
    await use(state);
  },
  uiData: [async ({ page, uiEnvironment, uiOwner, uiProjectRoot }, use, info) => {
    if (!uiEnvironment || !uiOwner) throw new WorkflowError('precondition', '缺少环境或数据归属');
    const config = validateEnvironment(uiEnvironment);
    if (config.isolation === 'shared' && (info.config.workers !== 1 || info.config.shard)) {
      throw new WorkflowError('precondition', '共享环境须 workers=1 且不能分片');
    }
    const store = new ArtifactStore(uiProjectRoot);
    const data = new UiDataScope(store, uiOwner, config);
    const release = config.isolation === 'shared'
      ? await store.acquireResource(`environment:${config.environment_id}:${new URL(config.base_url).origin}`) : undefined;
    try {
      let phase = 'site';
      try {
        const response = await page.goto(config.base_url, { timeout: config.timeout_ms, waitUntil: 'domcontentloaded' });
        if (!response?.ok() || new URL(page.url()).origin !== new URL(config.base_url).origin) {
          throw new WorkflowError('precondition', '站点不可用或跳转到其他身份入口');
        }
        phase = 'identity';
        await expect(page.locator(config.identity.selector)).toHaveText(config.identity.text, { timeout: config.timeout_ms });
        phase = 'initial-state';
        await expect(page.locator(config.initial_state.selector)).toHaveText(config.initial_state.text, { timeout: config.timeout_ms });
        await attach(info, 'ui-preflight', { status: 'completed', environment_id: config.environment_id,
          deployment_version: config.deployment_version, role: config.role, checks: ['site', 'identity', 'initial-state'] });
      } catch {
        await attach(info, 'ui-preflight', { status: 'blocked', category: 'precondition', check: phase,
          environment_id: config.environment_id, reason: phase === 'identity' ? 'identity-mismatch-or-session-expired' : 'preflight-failed' });
        throw new WorkflowError('precondition', `UI 前置检查失败：${phase}；未执行业务用例`);
      }
      try { await use(data); }
      finally {
        // Playwright 在失败/超时/受控取消时仍执行 fixture teardown；强制杀进程由 preparing/attempt 记录表示未核对。
        const records = await data.cleanup();
        await attach(info, 'ui-data-lifecycle', { namespace: data.namespace, records,
          residual: records.filter(r => r.cleanup_state !== 'cleaned').map(r => r.business_key) });
      }
    } finally { await release?.(); }
  }, { auto: true, timeout: 60000 }],
});
export { expect };
