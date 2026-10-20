import { createServer } from 'node:http';

export async function createMcpFixture() {
  let calls = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.id === undefined) { response.writeHead(202).end(); return; }
    const result = body.method === 'initialize'
      ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'desktop-mcp-fixture', version: '1' } }
      : body.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: '真实 MCP 回显测试', inputSchema: { type: 'object', properties: {} } }] }
        : body.method === 'tools/call'
          ? (calls++, { content: [{ type: 'text', text: 'MCP_EXECUTED' }] }) : {};
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    get calls() { return calls; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
