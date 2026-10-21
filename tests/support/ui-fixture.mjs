import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupFixture } from './fixture.mjs';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** 只用于流程验收的页面，数据局限于独立浏览器 context 的 localStorage。 */
export async function setupUiFixture({ discardPersistence = false } = {}) {
  const fixture = await setupFixture();
  const server = createServer((_req, res) => {
    fixture.state.browserRequests = (fixture.state.browserRequests ?? 0) + 1;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><title>UI capability fixture</title>
      <h1>Names</h1><form><label>Name <input required name="name"></label><button>Save</button></form>
      <ul aria-label="Saved names"></ul><script>
      const list = document.querySelector('ul');
      const names = JSON.parse(localStorage.getItem('names') || '[]');
      function render() { list.replaceChildren(...names.map(name => {
        const li = document.createElement('li'); li.textContent = name; return li;
      })); }
      document.querySelector('form').onsubmit = event => {
        event.preventDefault(); names.push(new FormData(event.target).get('name'));
        ${discardPersistence ? "localStorage.removeItem('names');" : "localStorage.setItem('names', JSON.stringify(names));"} render(); event.target.reset();
      }; render();</script></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await mkdir(join(fixture.project, 'tests'));
  // 临时项目复用锁定依赖，不安装另一套 Playwright；路径空格同时被覆盖。
  await symlink(join(repoRoot, 'node_modules'), join(fixture.project, 'node_modules'), 'dir');
  await writeFile(join(fixture.project, 'package.json'), '{"type":"module"}');
  await writeFile(join(fixture.project, 'playwright.config.mjs'), `export default {
    testDir: './tests', timeout: 15000, workers: 1,
    use: { headless: true, trace: 'retain-on-failure' },
    projects: [{name: 'chromium', use: {browserName: 'chromium'}}]
  };`);
  await writeFile(join(fixture.project, 'tests/seed.spec.ts'), `import {test} from 'playwright/test';
test('seed', async ({page}) => { await page.goto(${JSON.stringify(url)}); });`);
  await writeFile(join(fixture.agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    'playwright-test': { command: process.execPath,
      args: [join(repoRoot, 'node_modules/playwright/cli.js'), 'run-test-mcp-server', '--headless',
        '-c', join(fixture.project, 'playwright.config.mjs')],
      cwd: fixture.project, exposure: 'direct', timeout: 45 },
  } }));
  await writeFile(join(fixture.agentDir, 'SYSTEM.md'), `You verify one isolated UI workflow.
Use only tools of playwright-test. Do not use shell, edit, or write tools.
Follow the requested goal using real browser observations. Generated script is a draft, not approved.
Stop on errors; never invent successful actions.`);
  return { ...fixture, url, async close() {
    // 活体验证可能复制真实凭据；测试收尾只删除隔离目录中的副本。
    await rm(join(fixture.agentDir, 'auth.json'), { force: true });
    await rm(join(fixture.agentDir, 'models.json'), { force: true });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.close();
  } };
}

export function textContent(message) {
  if (typeof message === 'string') return message;
  return message?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
}

/** 将选中配置复制到隔离目录，绝不加载用户扩展或改写原始模型/凭据文件。 */
export async function copyLiveModel(agentDir, sourceDir) {
  const settings = JSON.parse(await readFile(join(sourceDir, 'settings.json'), 'utf8'));
  const models = JSON.parse(await readFile(join(sourceDir, 'models.json'), 'utf8'));
  const auth = JSON.parse(await readFile(join(sourceDir, 'auth.json'), 'utf8'));
  const provider = settings.defaultProvider, modelId = settings.defaultModel;
  if (!models.providers?.[provider] || !modelId) throw new Error('缺少可复制的自定义模型配置');
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { [provider]: models.providers[provider] } }), { mode: 0o600 });
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify(auth[provider] ? { [provider]: auth[provider] } : {}), { mode: 0o600 });
  await chmod(join(agentDir, 'models.json'), 0o600);
  await chmod(join(agentDir, 'auth.json'), 0o600);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId }));
  return { provider, modelId };
}
