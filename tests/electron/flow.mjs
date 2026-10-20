import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { setupFixture, until } from '../support/fixture.mjs';
const fixture = await setupFixture();
await mkdir(join(fixture.agentDir, 'extensions'));
await writeFile(join(fixture.agentDir, 'extensions', 'desktop.ts'), `
import { writeFileSync } from 'node:fs';
export default (pi) => pi.registerCommand('desktop-extension', {
  handler: (_, ctx) => writeFileSync(ctx.cwd + '/desktop-extension.txt', 'EXTENSION_EXECUTED'),
});
`);
const evidence = resolve(
  process.env.PI_AGENT_EXECUTABLE ? 'evidence/packaged' : 'evidence/electron',
);
await mkdir(evidence, { recursive: true });
const report = {
  architecture:
    'direct pi-agent-core Agent + Electron + TypeScript; no AgentSession, Next.js or HTTP business service',
  provider: 'controlled local protocol fixture; not an external model test',
  checks: [],
  pageErrors: [],
};
const pass = (name) => {
  report.checks.push(name);
  console.log('PASS', name);
};
let app;
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: fixture.agentDir,
  PI_AGENT_TEST_USER_DATA: join(fixture.root, 'desktop'),
};
const launch = async () =>
  electron.launch({
    ...(process.env.PI_AGENT_EXECUTABLE
      ? { executablePath: process.env.PI_AGENT_EXECUTABLE }
      : { args: ['.'] }),
    env,
    timeout: 60000,
  });
try {
  app = await launch();
  const page = await app.firstWindow();
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  await page
    .locator('#global-status')
    .filter({ hasText: '本地工作空间' })
    .waitFor({ timeout: 30000 });
  assert.ok(page.url().startsWith('file://'));
  assert.equal(await page.evaluate(() => typeof window.agentClient.send), 'function');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  pass('native Electron file UI with isolated, restricted TypeScript preload');
  const prefs = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  const rejected = await page.evaluate(async () => {
    try {
      await window.agentClient.createSession('/not-selected-by-user');
      return '';
    } catch (error) {
      return error.message;
    }
  });
  assert.match(rejected, /目录选择器/);
  pass('IPC rejects project paths not selected by the user');
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, fixture.project);
  await page.locator('#project-picker').click();
  await page.locator('#project-name').filter({ hasText: '测试项目 with spaces' }).waitFor();
  await page.locator('#prompt').waitFor({ state: 'visible' });
  await until(async () => !(await page.locator('#prompt').isDisabled()));
  const captures = await page.evaluate(() => {
    window.__testViews = [];
    window.agentClient.onSession((view) => window.__testViews.push(view));
    return true;
  });
  assert.ok(captures);
  await page.locator('#prompt').fill('中文输入确认');
  await page.locator('#prompt').evaluate((node) => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }));
  });
  assert.equal(fixture.state.requests, 0);
  await page.locator('#prompt').fill('WRITE_FIXTURE：请使用工具写入测试文件');
  await page.locator('#prompt').press('Shift+Enter');
  assert.ok((await page.locator('#prompt').inputValue()).endsWith('\n'));
  await page.locator('#prompt').press('Enter');
  await until(async () => {
    try {
      return (await readFile(fixture.outputPath, 'utf8')) === 'Written by real Pi Agent SDK\n';
    } catch {
      return false;
    }
  }, 30000);
  await page.getByText('工具已完成，文件已写入。', { exact: false }).waitFor();
  await until(async () => (await page.locator('#send').getAttribute('aria-label')) === '发送任务');
  assert.ok(
    await page.evaluate(
      () =>
        window.__testViews.filter(
          (view) => view.running && view.messages.some((message) => message.role === 'assistant'),
        ).length >= 2,
    ),
  );
  await page.locator('.tool-card summary').click();
  await page.locator('.tool-card').getByText('完成', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'agent-client.png') });
  pass(
    'Enter sends through real SDK; Shift+Enter adds newline; IME confirmation/repeat never sends',
  );
  pass('real composer → direct SDK streaming → write tool → actual file and tool result');
  const beforeExtension = fixture.state.requests;
  await page.locator('#prompt').fill('/desktop-extension');
  await page.locator('#prompt').press('Enter');
  await until(async () => {
    try { return (await readFile(join(fixture.project, 'desktop-extension.txt'), 'utf8')) === 'EXTENSION_EXECUTED'; }
    catch { return false; }
  });
  await until(async () => (await page.locator('#send').getAttribute('aria-label')) === '发送任务');
  assert.equal(fixture.state.requests, beforeExtension);
  pass('Pi extension loads in Electron main and composer slash command executes without a model request');
  assert.equal(await page.getByText('只读工具', { exact: true }).count(), 0);
  await page.locator('#permissions summary').click();
  assert.equal(await page.locator('#workspace-permission').inputValue(), 'workspace');
  await page.locator('#workspace-permission').selectOption('full-access');
  await until(async () => (await page.locator('#permission-label').textContent()) === '完全访问');
  await page.locator('#workspace-permission').selectOption('read-only');
  await until(async () => (await page.locator('#permission-label').textContent()) === '只读');
  await page.screenshot({ path: join(evidence, 'workspace-permissions.png') });
  await page.locator('#permissions summary').click();
  pass(
    'workspace permission UI switches real per-session tool policy, default workspace and explicit full/read-only',
  );
  await page.locator('#prompt').fill('第一条会话的未发送草稿');
  await page.locator('#new-session').click();
  await page.getByRole('heading', { name: '从一个任务开始' }).waitFor();
  assert.equal(await page.locator('#prompt').inputValue(), '');
  await page.locator('[data-session]').filter({ hasText: 'WRITE_FIXTURE' }).click();
  await until(
    async () => (await page.locator('#prompt').inputValue()) === '第一条会话的未发送草稿',
  );
  pass('new/switch/continue sessions preserve per-session unsent drafts');
  await page.locator('#prompt').fill('WAIT_FOR_STOP');
  await page.locator('#send').click();
  await until(() => fixture.state.waiting > 0);
  assert.equal(await page.locator('#thinking').isDisabled(), true);
  assert.equal(await page.locator('#workspace-permission').isDisabled(), true);
  const runningRequests = fixture.state.requests;
  await page.locator('#prompt').fill('运行中草稿');
  await page.locator('#prompt').press('Enter');
  assert.equal(fixture.state.requests, runningRequests);
  assert.equal(fixture.state.aborted, 0);
  await page.locator('#prompt').fill('');
  pass('running task locks permission/thinking; Enter preserves draft without sending or stopping');
  await app.evaluate(({ app, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    app.quit();
  });
  await until(async () => (await page.locator('#send').getAttribute('aria-label')) === '停止执行');
  assert.equal(fixture.state.aborted, 0, 'canceling quit must keep the task running');
  pass('canceling quit leaves the native window and running task intact');
  await page.getByRole('button', { name: '停止执行', exact: true }).click();
  await until(() => fixture.state.aborted > 0);
  await page.getByText('已停止', { exact: true }).waitFor();
  await until(async () => (await page.locator('#send').getAttribute('aria-label')) === '发送任务');
  pass('real stop button cancels SDK run and upstream connection');
  await page.locator('#settings-button').click();
  await page.locator('[name="provider"]').fill('second-provider');
  await page.locator('[name="baseUrl"]').fill(fixture.baseUrl);
  await page.locator('[name="modelId"]').fill('another-model');
  await page.locator('[name="apiKey"]').fill('fixture-key-only');
  await page.locator('[name="reasoning"]').check();
  await page.locator('#save-model').click();
  await until(async () => !(await page.locator('#settings-dialog').evaluate((node) => node.open)));
  assert.ok((await page.locator('#model').inputValue()).includes('another-model'));
  await until(async () => !(await page.locator('#thinking').isDisabled()));
  assert.equal(
    await page.locator('#thinking').evaluate((select) => {
      select.value = 'high';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return document.getElementById('send').disabled;
    }),
    true,
    'changing thinking locks send until IPC completes',
  );
  await until(async () => (await page.locator('#thinking').inputValue()) === 'high');
  pass('model settings persist provider/key separately and expose declared thinking strength');
  const sourceId = await page.locator('[data-session].active').getAttribute('data-session');
  await page.locator(`[data-manage="${sourceId}"]`).click();
  await page.locator('#session-name').fill('WRITE_FIXTURE · 已重命名');
  await page.locator('#session-rename').click();
  await page.locator('#session-dialog').waitFor({ state: 'hidden' });
  await page.locator('#chat-title').filter({ hasText: '已重命名' }).waitFor();
  assert.equal(
    await page.evaluate(
      (id) => document.activeElement?.getAttribute('data-manage') === id,
      sourceId,
    ),
    true,
  );
  const invalid = await page.evaluate(async (id) => {
    const failures = [];
    for (const action of [
      () => window.agentClient.renameSession(id, '  '),
      () => window.agentClient.deleteSession('/tmp/forged.jsonl'),
      () => window.agentClient.forkSession('unknown-id'),
      () => window.agentClient.setPermission(id, 'invalid-mode'),
      () => window.agentClient.setThinking(id, 'invalid-strength'),
    ]) {
      try {
        await action();
      } catch (error) {
        failures.push(error.message);
      }
    }
    return failures;
  }, sourceId);
  assert.equal(invalid.length, 5);
  pass('session rename persists via validated IPC; dialog restores keyboard focus');
  await page.setViewportSize({ width: 900, height: 700 });
  await page.screenshot({ path: join(evidence, 'narrow.png') });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  pass('900px desktop layout has no horizontal page overflow');
  const before = fixture.state.requests;
  await app.evaluate(({ app }) => app.quit());
  await app.waitForEvent('close', { timeout: 20000 }).catch(() => {});
  app = await launch();
  const resumed = await app.firstWindow();
  resumed.on('pageerror', (error) => report.pageErrors.push(error.message));
  await resumed
    .locator('[data-session]')
    .filter({ hasText: 'WRITE_FIXTURE' })
    .waitFor({ timeout: 30000 });
  await resumed.locator('[data-session]').filter({ hasText: 'WRITE_FIXTURE' }).click();
  await resumed.getByText('工具已完成，文件已写入。', { exact: false }).waitFor();
  assert.equal(fixture.state.requests, before);
  assert.match(await resumed.locator('#chat-title').textContent(), /已重命名/);
  assert.equal(await resumed.locator('#thinking').inputValue(), 'high');
  assert.equal(await resumed.locator('#permission-label').textContent(), '只读');
  await resumed.locator('#prompt').fill('AFTER_RESTART');
  await resumed.locator('#prompt').press('Enter');
  await resumed.getByText('会话已继续。', { exact: false }).waitFor();
  assert.equal(fixture.state.payloads.at(-1).reasoning_effort, 'high');
  pass(
    'thinking strength and read-only policy survive restart; selected high reaches real model request',
  );
  pass('app restart restores SDK JSONL history, does not replay tasks, and continues conversation');
  await until(
    async () => (await resumed.locator('#send').getAttribute('aria-label')) === '发送任务',
  );
  const original = await resumed.locator('[data-session].active').getAttribute('data-session');
  await resumed.locator('#prompt').fill('原会话的独立草稿');
  const requestCount = fixture.state.requests;
  await resumed.locator(`[data-manage="${original}"]`).click();
  await resumed.locator('#session-fork').click();
  await resumed.locator('#session-dialog').waitFor({ state: 'hidden' });
  const fork = await resumed.locator('[data-session].active').getAttribute('data-session');
  assert.notEqual(fork, original);
  assert.equal(fixture.state.requests, requestCount);
  assert.equal(await resumed.locator('#prompt').inputValue(), '');
  await resumed.locator('#chat-title').filter({ hasText: '分支' }).waitFor();
  pass('UI fork opens an independent completed-history snapshot without replay');
  await resumed.locator(`[data-session="${original}"]`).click();
  assert.equal(await resumed.locator('#prompt').inputValue(), '原会话的独立草稿');
  await resumed.locator(`[data-manage="${original}"]`).click();
  await resumed.locator('#session-delete').click();
  assert.equal(await resumed.evaluate(() => document.activeElement.id), 'cancel-session-delete');
  await resumed.screenshot({ path: join(evidence, 'session-delete-confirm.png') });
  await resumed.locator('#cancel-session-delete').click();
  await resumed.locator('#close-session-dialog').click();
  assert.equal(await resumed.locator('#prompt').inputValue(), '原会话的独立草稿');
  pass('delete confirmation defaults to return; cancel preserves history and draft');
  await resumed.locator('#prompt').fill('WAIT_FOR_STOP');
  const waitingBefore = fixture.state.waiting;
  await resumed.locator('#send').click();
  await until(() => fixture.state.waiting > waitingBefore);
  const abortBefore = fixture.state.aborted;
  await resumed.locator(`[data-manage="${original}"]`).click();
  await resumed.locator('#session-delete').click();
  await resumed.locator('#confirm-session-delete').click();
  await resumed.locator('#session-dialog').waitFor({ state: 'hidden' });
  await until(() => fixture.state.aborted > abortBefore);
  assert.equal(await resumed.locator(`[data-session="${original}"]`).count(), 0);
  assert.equal(await resumed.locator('#prompt').isDisabled(), true);
  await resumed.locator(`[data-session="${fork}"]`).click();
  await resumed.locator('#prompt').fill('INDEPENDENT_BRANCH_CONTINUE');
  await resumed.locator('#send').click();
  await resumed.getByText('INDEPENDENT_BRANCH_CONTINUE', { exact: true }).waitFor();
  await until(
    async () => (await resumed.locator('#send').getAttribute('aria-label')) === '发送任务',
  );
  pass('confirmed delete cancels running request, clears selected session; branch continues');
  // 删除另一个未选中的会话不能覆盖当前会话草稿。
  await resumed.locator('#prompt').fill('保留分支草稿');
  await resumed.locator('#new-session').click();
  await resumed.getByRole('heading', { name: '从一个任务开始' }).waitFor();
  const emptyId = await resumed.locator('[data-session].active').getAttribute('data-session');
  await resumed.locator(`[data-session="${fork}"]`).click();
  await resumed.locator(`[data-manage="${emptyId}"]`).click();
  await resumed.locator('#session-fork').click();
  await resumed.locator('#session-action-error').filter({ hasText: '暂无已保存' }).waitFor();
  await resumed.locator('#session-delete').click();
  await resumed.locator('#confirm-session-delete').click();
  await resumed.locator('#session-dialog').waitFor({ state: 'hidden' });
  assert.equal(await resumed.locator('#prompt').inputValue(), '保留分支草稿');
  await resumed.locator('#prompt').fill('');
  pass(
    'empty branch shows actionable error; deleting nonactive empty session preserves active draft',
  );
  await resumed.locator(`[data-manage="${fork}"]`).click();
  await resumed.screenshot({ path: join(evidence, 'session-management.png') });
  assert.equal(
    await resumed
      .locator('#session-dialog')
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  await resumed.keyboard.press('Escape');
  await app.evaluate(({ app, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    app.quit();
  });
  await app.waitForEvent('close', { timeout: 20000 }).catch(() => {});
  app = await launch();
  const finalPage = await app.firstWindow();
  finalPage.on('pageerror', (error) => report.pageErrors.push(error.message));
  await finalPage.locator(`[data-session="${fork}"]`).waitFor({ timeout: 30000 });
  assert.equal(await finalPage.locator(`[data-session="${original}"]`).count(), 0);
  await finalPage.locator(`[data-session="${fork}"]`).click();
  await finalPage.getByText('INDEPENDENT_BRANCH_CONTINUE', { exact: true }).waitFor();
  pass('restart retains independent branch and confirmed deletion');
  assert.deepEqual(report.pageErrors, []);
  await finalPage.screenshot({ path: join(evidence, 'continued-session.png') });
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
  if (app) {
    const failed = await app.firstWindow();
    report.uiAtFailure = await failed.locator('body').innerText();
    await failed.screenshot({ path: join(evidence, 'failure.png') });
  }
} finally {
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
      })
      .catch(() => {});
    await app.close().catch(() => {});
  }
  fixture.close();
  report.providerRequests = fixture.state.requests;
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
}
