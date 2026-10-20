import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { setupFixture, until } from '../support/fixture.mjs';

for (const exposure of ['direct', 'codemode', 'mixed']) {
  test(`extension-registered MCP connects and executes through real Agent (${exposure})`, async (t) => {
    const fixture = await setupFixture();
    let calls = 0;
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.id === undefined) { response.writeHead(202).end(); return; }
      const result = body.method === 'initialize'
        ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'postman-fixture', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'echo', description: 'MCP proof tool', inputSchema: { type: 'object', properties: {} } }] }
          : body.method === 'tools/call'
            ? (calls++, { content: [{ type: 'text', text: 'MCP_EXECUTED' }] }) : {};
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const host = new AgentHost(() => {}, () => {}, fixture.agentDir);
    t.after(async () => { await host.dispose(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fixture.close(); });
    await mkdir(join(fixture.agentDir, 'extensions'));
    const config = { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, exposure: exposure === 'mixed' ? 'direct' : exposure };
    await writeFile(join(fixture.agentDir, 'extensions', 'postman.js'), `export default pi => {
      ${exposure === 'mixed' ? `pi.registerMcpServer('other', ${JSON.stringify({ ...config, exposure: 'codemode' })});` : ''}
      pi.registerMcpServer('postman', ${JSON.stringify(config)});
    };`);
    const view = await host.create(fixture.project, true);
    assert.doesNotMatch(view.warning ?? '', /no loaded extension connects MCP/);
    await host.send(view.id, exposure === 'codemode' ? 'MCP_CODEMODE_PROOF' : 'MCP_DIRECT_PROOF', [], []);
    assert.equal(calls, 1, JSON.stringify(fixture.state.toolResults));
    assert.match(JSON.stringify(fixture.state.toolResults), /MCP_EXECUTED/);
    await host.send(view.id, '/mcp', [], []);
    await until(() => host.view(view.id).warning?.includes('postman: connected'));
    assert.match(host.view(view.id).warning, /1 tools/);
    const completions = await host.complete(view.id, '/mcp reconnect post');
    assert.deepEqual(completions.map(item => item.value), ['/mcp reconnect postman']);
    assert.doesNotMatch(host.view(view.id).warning, /no loaded extension connects MCP|扩展加载失败/);
  });
}

test('MCP authentication challenge reports login requirement instead of missing connector', async (t) => {
  const fixture = await setupFixture();
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="test"' });
    response.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = new AgentHost(() => {}, () => {}, fixture.agentDir);
  t.after(async () => { await host.dispose(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fixture.close(); });
  await mkdir(join(fixture.agentDir, 'extensions'));
  await writeFile(join(fixture.agentDir, 'extensions', 'postman.js'), `export default pi => pi.registerMcpServer('postman', { type: 'http', url: 'http://127.0.0.1:${server.address().port}/mcp' });`);
  const view = await host.create(fixture.project, true);
  await until(() => host.view(view.id).warning?.includes('postman: needs sign-in'));
  await host.send(view.id, '/mcp', [], []);
  assert.match(host.view(view.id).warning, /run \/mcp login postman/);
  assert.doesNotMatch(host.view(view.id).warning, /no loaded extension connects MCP/);
  assert.equal(fixture.state.requests, 0);
});

test('desktop stop cancels an extension browser callback wait without waiting for session shutdown', async (t) => {
  const fixture = await setupFixture();
  const host = new AgentHost(() => {}, () => {}, fixture.agentDir);
  t.after(async () => { await host.dispose(); fixture.close(); });
  await mkdir(join(fixture.agentDir, 'extensions'));
  await writeFile(join(fixture.agentDir, 'extensions', 'login.js'), `export default pi => {
    pi.registerCommand('browser-wait', { handler: async (_, ctx) => {
      ctx.ui.notify('AUTH_WAITING_TEST');
      await ctx.ui.input('Waiting for browser callback', '', {signal: new AbortController().signal});
      ctx.ui.notify('AUTH_WAIT_CANCELLED_TEST');
    }});
  };`);
  const view = await host.create(fixture.project, true);
  const pending = host.send(view.id, '/browser-wait', [], []);
  await until(() => host.view(view.id).warning?.includes('AUTH_WAITING_TEST'));
  await host.stop(view.id);
  await pending;
  assert.match(host.view(view.id).warning, /AUTH_WAIT_CANCELLED_TEST/);
  assert.equal(fixture.state.requests, 0);
});
