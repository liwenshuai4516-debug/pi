import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createInstallFixture } from '../support/install-fixture.mjs';
import { setupFixture, until } from '../support/fixture.mjs';
const fixture = await setupFixture();
const installFixture = await createInstallFixture(fixture);
await mkdir(join(fixture.agentDir, 'extensions'));
await writeFile(join(fixture.agentDir, 'extensions', 'desktop.ts'), `
import { writeFileSync, appendFileSync } from 'node:fs';
export default (pi) => {
  pi.registerCommand('desktop-extension', {
    handler: (_, ctx) => writeFileSync(ctx.cwd + '/desktop-extension.txt', 'EXTENSION_EXECUTED'),
  });
  pi.registerShortcut('ctrl+shift+s', { handler: ctx => appendFileSync(ctx.cwd + '/desktop-shortcut.txt', 'KEY_EXECUTED') });
  pi.registerShortcut('ctrl+k', { handler: ctx => writeFileSync(ctx.cwd + '/reserved-key.txt', 'SHOULD_NOT_RUN') });
};
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
  await until(async () => !(await page.locator('#prompt').isDisabled()));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'prompt');
  assert.equal(await page.locator('#project-name').textContent(), '选择工作区');
  assert.equal(await page.locator('#session-sidebar #project-picker').count(), 0);
  assert.equal(await page.locator('.composer-area #project-picker').count(), 1);
  assert.equal(await page.locator('[data-choose-project]').count(), 0);
  assert.equal(await page.locator('#project-path').isVisible(), false);
  assert.equal(await page.locator('#new-session').isDisabled(), false);
  assert.equal(await page.locator('.chat-panel').evaluate((node) => node.classList.contains('empty-chat')), true);
  await page.screenshot({ path: join(evidence, 'startup-chat.png') });
  const listSessionId = await page.locator('[data-session].active').getAttribute('data-session');
  await page.locator('#toggle-session-list').click();
  assert.equal(await page.locator('#sessions').isVisible(), false);
  assert.equal(await page.locator('#toggle-session-list').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#plugins-button').isVisible(), true);
  await page.locator('#prompt').press('Control+k');
  assert.equal(await page.locator('#sessions').isVisible(), true);
  assert.equal(await page.locator('[data-session].active').getAttribute('data-session'), listSessionId);
  await page.locator('#search-sessions').click();
  pass('recent sessions collapse independently; search reopens list without losing active conversation');
  const initial = await page.evaluate(() => window.agentClient.initialize());
  assert.equal(initial.defaultCwd, join(fixture.root, 'desktop', 'workspace'));
  const startupId = await page.locator('[data-session].active').getAttribute('data-session');
  const startupView = await page.evaluate((id) => window.agentClient.openSession(id), startupId);
  assert.equal(startupView.cwd, initial.defaultCwd);
  await page.locator('#prompt').fill('DEFAULT_CHAT：无需选择工作区直接对话');
  await page.locator('#prompt').press('Enter');
  await page.getByText('会话已继续。', { exact: false }).waitFor();
  await until(async () => (await page.locator('#send').getAttribute('aria-label')) === '发送任务');
  assert.equal(fixture.state.requests, 1);
  pass('startup focuses a ready chat; real SDK sends from app-owned default workspace without choosing a project');
  await page.locator('#new-session').click();
  await page.locator('#prompt').fill('选择工作区前输入的任务');
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.locator('#project-picker').click();
  assert.equal(await page.locator('#prompt').inputValue(), '选择工作区前输入的任务');
  assert.equal(await page.locator('#project-name').textContent(), '选择工作区');
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, fixture.project);
  await page.locator('#project-picker').click();
  await page.locator('#project-name').filter({ hasText: '测试项目 with spaces' }).waitFor();
  await page.locator('#prompt').waitFor({ state: 'visible' });
  await until(async () => !(await page.locator('#prompt').isDisabled()));
  assert.equal(await page.locator('#prompt').inputValue(), '选择工作区前输入的任务');
  assert.equal(await page.locator('#project-path').isVisible(), true);
  assert.ok((await page.locator('#project-picker').getAttribute('title')).includes(fixture.project));
  pass('composer workspace picker handles cancellation and preserves unsent task when switching to a selected project');
  const beforeIme = fixture.state.requests;
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
  assert.equal(fixture.state.requests, beforeIme);
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
  const thought = page.locator('.thinking-block').first();
  await thought.getByText('先确认目标文件路径，再使用写入工具完成任务。', { exact: true }).waitFor();
  assert.equal(await thought.evaluate((node) => node.open), true);
  assert.equal(await thought.locator('p').evaluate((node) => getComputedStyle(node).fontStyle), 'italic');
  assert.equal(await page.locator('.message-heading').first().evaluate((node) => getComputedStyle(node).display), 'flex');
  assert.equal(await page.locator('.tool-card summary').first().evaluate((node) => getComputedStyle(node).display), 'flex');
  await page.screenshot({ path: join(evidence, 'agent-client.png') });
  await thought.locator('summary').press('Enter');
  await page.evaluate(async () => {
    const view = window.__testViews.at(-1);
    await window.agentClient.setThinking(view.id, view.thinking);
  });
  assert.equal(await thought.evaluate((node) => node.open), false);
  await thought.locator('summary').press('Enter');
  assert.equal(await thought.evaluate((node) => node.open), true);
  pass(
    'Enter sends through real SDK; Shift+Enter adds newline; IME confirmation/repeat never sends',
  );
  pass('real composer → direct SDK streaming → write tool → actual file and tool result');
  const expandedWidth = await page.locator('.chat-panel').evaluate((node) => node.clientWidth);
  const currentSession = await page.locator('[data-session].active').getAttribute('data-session');
  await page.locator('#prompt').fill('折叠时保留的草稿');
  await page.locator('#toggle-sidebar').click();
  assert.equal(await page.locator('#session-sidebar').isVisible(), false);
  assert.equal(await page.locator('#toggle-sidebar').getAttribute('aria-expanded'), 'false');
  assert.ok(await page.locator('.chat-panel').evaluate((node) => node.clientWidth) > expandedWidth);
  assert.equal(await page.locator('#prompt').inputValue(), '折叠时保留的草稿');
  await page.screenshot({ path: join(evidence, 'sidebar-collapsed.png') });
  await page.locator('#toggle-sidebar').press('Enter');
  assert.equal(await page.locator('#session-sidebar').isVisible(), true);
  assert.equal(await page.locator('#toggle-sidebar').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('[data-session].active').getAttribute('data-session'), currentSession);
  await page.locator('#toggle-sidebar').click();
  await page.locator('#prompt').press('Control+k');
  assert.equal(await page.locator('#session-sidebar').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'session-search');
  await page.locator('#session-search').fill('不存在的会话标题');
  assert.equal(await page.locator('[data-session]').count(), 0);
  await page.locator('#session-search').fill('');
  await page.locator('[data-session].active').waitFor();
  pass('sidebar collapse frees chat space, preserves draft/selection; keyboard toggle and search reopen work');
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
  await page.locator('#prompt').press('Control+Shift+S');
  await until(async () => {
    try { return (await readFile(join(fixture.project, 'desktop-shortcut.txt'), 'utf8')) === 'KEY_EXECUTED'; }
    catch { return false; }
  });
  await page.locator('#prompt').evaluate((node) => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, repeat: true, bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, isComposing: true, bubbles: true }));
  });
  await page.locator('#prompt').press('Control+k');
  await page.locator('#session-search').evaluate((node) => { if (document.activeElement !== node) throw new Error('Client shortcut lost focus'); });
  await assert.rejects(readFile(join(fixture.project, 'reserved-key.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(fixture.project, 'desktop-shortcut.txt'), 'utf8'), 'KEY_EXECUTED');
  assert.equal(fixture.state.requests, beforeExtension);
  pass('extension shortcut reaches main; reserved client keys, repeat and IME are protected');
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
  const spinner = page.locator('.running-label .execution-spinner');
  await spinner.waitFor();
  const frames = new Set();
  for (let index = 0; index < 8; index++) {
    frames.add(await spinner.evaluate((node) => getComputedStyle(node, '::before').content));
    await page.waitForTimeout(100);
  }
  assert.ok(frames.size > 1, 'running indicator must actually change frames');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await spinner.evaluate((node) => getComputedStyle(node, '::before').animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.screenshot({ path: join(evidence, 'execution-animation.png') });
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
  assert.equal(await page.locator('.running-label .execution-spinner').count(), 0);
  assert.equal(await page.locator('#messages').getByText('Request was aborted', { exact: true }).count(), 0);
  assert.equal(await page.locator('#error-banner').isVisible(), false);
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
  // 真实重命名后的长标题保持单行，管理按钮仍在可点击区域内。
  const longName = 'WRITE_FIXTURE · 已重命名 · ' + '用于验证单行省略的长会话标题'.repeat(5);
  await page.locator(`[data-manage="${sourceId}"]`).click();
  await page.locator('#session-name').fill(longName);
  await page.locator('#session-rename').click();
  await page.locator('#session-dialog').waitFor({ state: 'hidden' });
  const row = page.locator(`[data-session="${sourceId}"]`);
  assert.ok((await row.getAttribute('title')).startsWith(longName));
  assert.equal(await row.locator('small').count(), 0);
  const geometry = await row.evaluate((node) => {
    const title = node.querySelector('strong');
    const menu = node.parentElement.querySelector('[data-manage]').getBoundingClientRect();
    return {
      height: node.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(title).lineHeight),
      titleHeight: title.getBoundingClientRect().height,
      ellipsis: getComputedStyle(title).textOverflow,
      truncated: title.scrollWidth > title.clientWidth,
      menuInside: menu.right <= document.getElementById('session-sidebar').getBoundingClientRect().right,
    };
  });
  assert.equal(geometry.height, 36);
  assert.equal(geometry.titleHeight, geometry.lineHeight);
  assert.equal(geometry.ellipsis, 'ellipsis');
  assert.equal(geometry.truncated, true);
  assert.equal(geometry.menuInside, true);
  await page.screenshot({ path: join(evidence, 'sessions-compact.png') });
  pass('long session titles stay on one compact line with tooltip and accessible management action');
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
  await page.locator('#toggle-sidebar').click();
  assert.equal(await page.locator('#session-sidebar').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: join(evidence, 'narrow-collapsed.png') });
  await page.locator('#toggle-sidebar').click();
  pass('900px desktop layout has no horizontal page overflow with sidebar expanded or collapsed');
  await page.locator('#search-sessions').click();
  assert.equal(await page.locator('#session-search-box').isVisible(), false);
  await page.locator('#search-sessions').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'session-search');
  pass('sidebar header search button opens and closes search with keyboard focus');
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
  await finalPage.locator('#plugins-button').click();
  await until(async () => !(await finalPage.locator('#install-plugin').isDisabled()));
  await finalPage.locator('#plugin-install summary').click();
  await finalPage.locator('#plugin-source').fill(join(fixture.root, 'missing-package'));
  await finalPage.locator('#install-plugin').click();
  await finalPage.locator('#plugin-error').waitFor({ state: 'visible' });
  assert.equal(await finalPage.locator('#plugin-packages').getByText('已安装', { exact: true }).count(), 0);
  await finalPage.locator('#plugin-source').fill(installFixture.packageDir);
  await finalPage.locator('#install-plugin').click();
  await finalPage.locator('#plugin-status').filter({ hasText: '安装完成' }).waitFor();
  await until(async () => (await finalPage.locator('#plugin-extensions li:not(.resource-empty)').count()) >= 2);
  await finalPage.locator('#plugin-kind').selectOption('skill');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, installFixture.skillDir);
  await finalPage.locator('#choose-plugin-source').click();
  await until(async () => (await finalPage.locator('#plugin-source').inputValue()) === installFixture.skillDir);
  await finalPage.locator('#install-plugin').click();
  await finalPage.locator('#plugin-status').filter({ hasText: '安装完成' }).waitFor();
  await finalPage.locator('#skills-tab').click();
  await finalPage.locator('#plugin-skills').getByText('installed-skill', { exact: true }).waitFor();
  await finalPage.screenshot({ path: join(evidence, 'plugins-installed.png') });
  await finalPage.locator('#activate-plugins').click();
  await finalPage.locator('#plugins-dialog').waitFor({ state: 'hidden' });
  await finalPage.locator('#prompt').fill('INSTALLED_PLUGIN_TOOL');
  await finalPage.locator('#prompt').press('Enter');
  await until(async () => {
    try { return (await readFile(join(fixture.project, 'installed-plugin-proof.txt'), 'utf8')) === 'INSTALLED_PLUGIN_EXECUTED'; }
    catch { return false; }
  });
  await until(async () => (await finalPage.locator('#send').getAttribute('aria-label')) === '发送任务');
  const trace = finalPage.locator('.tool-card').filter({ hasText: '读取会话' });
  await trace.locator('summary strong').filter({ hasText: '读取会话' }).waitFor();
  assert.equal(await trace.locator('.tool-status').textContent(), '完成');
  assert.ok(await finalPage.locator('.turn-label').filter({ hasText: '第 1 轮' }).count());
  await trace.locator('summary').press('Enter');
  await trace.getByRole('heading', { name: '输入参数' }).waitFor();
  await trace.getByText('INSTALLED_PLUGIN_EXECUTED', { exact: true }).waitFor();
  await finalPage.screenshot({ path: join(evidence, 'trace-chinese.png') });
  pass('UI-installed Pi plugin loads in new conversation and real model tool call writes proof; trace uses Chinese labels');
  await finalPage.locator('#prompt').fill('/skill:installed-skill 检查安装是否生效');
  await finalPage.locator('#prompt').press('Enter');
  await until(async () => (await finalPage.locator('#send').getAttribute('aria-label')) === '发送任务');
  assert.match(fixture.state.instructions.at(-1), /SKILL_INSTALL_PROOF/);
  await finalPage.locator('.skill-invocation').filter({ hasText: '使用 Skill · installed-skill' }).waitFor();
  assert.match(JSON.stringify(fixture.state.payloads.at(-1)), /INSTALL_SKILL_DESCRIPTION/);
  await finalPage.locator('#plugins-button').click();
  await until(async () => !(await finalPage.locator('#install-plugin').isDisabled()));
  await finalPage.locator('#skills-tab').click();
  await finalPage.locator('#plugin-skills').getByText('当前会话已加载', { exact: true }).waitFor();
  const skillSwitch = finalPage.locator('#plugin-skills [role=switch]');
  assert.equal(await skillSwitch.getAttribute('aria-checked'), 'true');
  await skillSwitch.click();
  await finalPage.locator('#plugin-status').filter({ hasText: '新建对话后生效' }).waitFor();
  assert.equal(await finalPage.locator('#plugin-skills [role=switch]').getAttribute('aria-checked'), 'false');
  await finalPage.screenshot({ path: join(evidence, 'plugins-loaded.png') });
  await finalPage.locator('#plugins-tab').click();
  const extensionSwitch = finalPage.locator('#plugin-extensions [role=switch][data-path$="/index.ts"]');
  assert.equal(await extensionSwitch.getAttribute('aria-checked'), 'true');
  await extensionSwitch.click();
  await finalPage.locator('#plugin-status').filter({ hasText: '新建对话后生效' }).waitFor();
  assert.equal(await extensionSwitch.getAttribute('aria-checked'), 'false');
  await finalPage.locator('#close-plugins').click();
  await finalPage.locator('#new-session').click();
  await finalPage.locator('#plugins-button').click();
  await until(async () => !(await finalPage.locator('#install-plugin').isDisabled()));
  await finalPage.locator('#skills-tab').click();
  assert.equal(await finalPage.locator('#plugin-skills [role=switch]').getAttribute('aria-checked'), 'false');
  await finalPage.locator('#plugin-skills [role=switch]').click();
  await finalPage.locator('#plugin-status').filter({ hasText: '新建对话后生效' }).waitFor();
  await finalPage.locator('#plugins-tab').click();
  await finalPage.locator('#plugin-extensions [role=switch][data-path$="/index.ts"]').click();
  await finalPage.locator('#plugin-status').filter({ hasText: '新建对话后生效' }).waitFor();
  await finalPage.locator('#close-plugins').click();
  await finalPage.locator('#new-session').click();
  await finalPage.locator('#prompt').fill('INSTALLED_PLUGIN_TOOL');
  await finalPage.locator('#prompt').press('Enter');
  await until(async () => {
    try { return (await readFile(join(fixture.project, 'installed-plugin-proof.txt'), 'utf8')) === 'INSTALLED_PLUGIN_EXECUTED'; }
    catch { return false; }
  });
  await finalPage.locator('#plugins-button').click();
  await until(async () => !(await finalPage.locator('#install-plugin').isDisabled()));
  await finalPage.locator('#skills-tab').click();
  assert.equal(await finalPage.locator('#plugin-skills [role=switch]').getAttribute('aria-checked'), 'true');
  await finalPage.locator('#close-plugins').click();
  assert.deepEqual(report.pageErrors, []);
  pass('UI-imported Skill is loaded, advertised in model context, and slash invocation sends real Skill contents');

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
