import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { until } from '../support/fixture.mjs';
import { setupUiFixture, textContent, repoRoot } from '../support/ui-fixture.mjs';

const run = promisify(execFile);

test('UI-01: native Pi MCP drives browser, journals actions and writes replayable test', { timeout: 90000 }, async t => {
  const fixture = await setupUiFixture();
  const host = new AgentHost(() => {}, () => {}, fixture.agentDir);
  t.after(async () => { await host.dispose(); await fixture.close(); });
  const view = await host.create(fixture.project, true);
  await until(async () => (await host.listMcp(view.id)).servers.some(s => s.state === 'connected'));
  const tools = host.entries.get(view.id).agent.state.tools;
  for (const name of ['generator_setup_page', 'generator_read_log', 'generator_write_test', 'browser_type', 'browser_click']) {
    assert.ok(tools.some(tool => tool.name.endsWith(`__${name}`)), `缺少工具 ${name}`);
  }
  const schema = name => tools.find(tool => tool.name.endsWith(`__${name}`)).parameters;
  const calls = [];
  let journal;
  fixture.state.respond = body => {
    const previous = body.messages.filter(m => m.role === 'tool').at(-1);
    const observed = previous ? textContent(previous.content) : '';
    const tool = (name, args) => {
      calls.push(name);
      return { tool: tools.find(item => item.name.endsWith(`__${name}`)).name, args };
    };
    switch (calls.length) {
      case 0: return tool('generator_setup_page', { plan: 'Fill Name with UI proof; save; verify saved name persists after reload.', seedFile: 'tests/seed.spec.ts', project: 'chromium' });
      case 1: {
        const ref = observed.match(/textbox "Name".*?\[ref=([^\]]+)\]/)?.[1];
        assert.ok(ref, observed);
        return tool('browser_type', { element: 'Name textbox', target: ref, text: 'UI proof', intent: 'Enter the name UI proof' });
      }
      case 2: return tool('browser_snapshot', {});
      case 3: {
        const ref = observed.match(/button "Save".*?\[ref=([^\]]+)\]/)?.[1];
        assert.ok(ref, observed);
        return tool('browser_click', { element: 'Save button', target: ref, intent: 'Save the name' });
      }
      case 4: return tool('browser_snapshot', {});
      case 5:
        assert.match(observed, /listitem.*UI proof/, JSON.stringify(schema('browser_click')));
        return tool('generator_read_log', {});
      case 6: {
        journal = observed;
        assert.match(journal, /getByRole\('textbox'.*Name/);
        assert.match(journal, /getByRole\('button'.*Save/);
        const code = `import {test, expect} from 'playwright/test';
test('UI proof persists', async ({page}) => {
  await page.goto(${JSON.stringify(fixture.url)});
  await page.getByRole('textbox', {name:'Name', exact:true}).fill('UI proof');
  await page.getByRole('button', {name:'Save', exact:true}).click();
  await expect(page.getByRole('listitem')).toHaveText(['UI proof']);
  await page.reload();
  await expect(page.getByRole('listitem')).toHaveText(['UI proof']);
});`;
        return tool('generator_write_test', { fileName: 'tests/generated.spec.ts', code });
      }
      default: assert.match(observed, /Test written to/); return { text: 'Recorded draft saved; no design approval claimed.' };
    }
  };
  await host.send(view.id, 'Record the isolated Name feature, then write a script draft.', [], []);
  if (fixture.state.responseError) throw fixture.state.responseError;
  assert.deepEqual(calls, ['generator_setup_page', 'browser_type', 'browser_snapshot', 'browser_click', 'browser_snapshot', 'generator_read_log', 'generator_write_test']);
  const script = await readFile(join(fixture.project, 'tests/generated.spec.ts'), 'utf8');
  assert.match(script, /page.reload/);
  assert.ok(!script.includes('[ref='));
  await writeFile(join(fixture.project, 'generator-log.md'), journal);
  const result = await run(process.execPath, [join(repoRoot, 'node_modules/playwright/cli.js'), 'test', 'generated.spec.ts', '--reporter=json'], { cwd: fixture.project, timeout: 30000 });
  const report = JSON.parse(result.stdout);
  assert.equal(report.stats.expected, 1);
  assert.equal(report.stats.unexpected, 0);

  // 工具返回业务错误时不能被折算为成功。
  const invalid = tools.find(item => item.name.endsWith('__browser_click')).name;
  let errorRequested = false;
  fixture.state.respond = () => {
    if (errorRequested) return { text: 'The locator failed; stop this branch.' };
    errorRequested = true;
    return { tool: invalid, args: { target: 'getByRole("button", { name: "ABSENT", exact: true })', intent: 'Verify missing locator is reported as an error' } };
  };
  await host.send(view.id, 'Exercise an invalid locator on the isolated page.', [], []);
  assert.ok(host.view(view.id).tools.some(tool => tool.name === invalid && tool.status === 'error'));

  const waitName = tools.find(item => item.name.endsWith('__browser_wait_for')).name;
  let waitRequested = false;
  fixture.state.respond = () => {
    if (waitRequested) return { text: 'Cancellation probe ended.' };
    waitRequested = true;
    return { tool: waitName, args: { time: 10, intent: 'Wait to verify cancellation' } };
  };
  const pending = host.send(view.id, 'Exercise browser cancellation.', [], []);
  try {
    await until(() => host.view(view.id).tools.some(tool => tool.name === waitName && tool.status === 'running'));
  } catch (error) {
    assert.fail(JSON.stringify({ error: host.view(view.id).error, tools: host.view(view.id).tools.slice(-2) }));
  }
  const stopAt = Date.now();
  await host.stop(view.id);
  await pending;
  assert.ok(Date.now() - stopAt < 4000, '取消不能等待整个浏览器动作超时');
  assert.equal(host.view(view.id).running, false);
  t.diagnostic(`protocol fixture + real browser evidence: ${fixture.project}`);
});
