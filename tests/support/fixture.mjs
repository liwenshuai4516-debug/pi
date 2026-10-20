import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function setupFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-agent-client-'));
  const agentDir = join(root, 'agent'),
    project = join(root, '测试项目 with spaces');
  await mkdir(agentDir);
  await mkdir(project);
  const outputPath = join(project, 'agent-result.txt');
  const pidPath = join(project, 'owned-tool-pid.txt');
  const state = {
    requests: 0,
    waiting: 0,
    aborted: 0,
    instructions: [],
    toolResults: [],
    payloads: [],
  };
  const provider = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.requests++;
      state.payloads.push(body);
      const lastUser = body.messages.findLastIndex((message) => message.role === 'user');
      const prompt = JSON.stringify(body.messages[lastUser]?.content);
      state.instructions.push(prompt);
      const hasToolResult = body.messages
        .slice(lastUser)
        .some((message) => message.role === 'tool');
      if (hasToolResult)
        state.toolResults.push(
          body.messages.slice(lastUser).filter((message) => message.role === 'tool'),
        );
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', model: 'fixture-agent', created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      send({ role: 'assistant', content: '' });
      if (prompt.includes('WAIT_FOR_STOP')) {
        state.waiting++;
        send({ content: '等待停止测试' });
        const timer = setInterval(() => response.write(': heartbeat\n\n'), 100);
        response.once('close', () => {
          clearInterval(timer);
          state.aborted++;
        });
        return;
      }
      if (prompt.includes('EXTENSION_TOOL') && !hasToolResult) {
        send({ tool_calls: [{ index: 0, id: 'extension-fixture', type: 'function', function: {
                name: prompt.includes('EXTENSION_TOOL_NESTED') ? 'qa_nested' : 'qa_echo', arguments: JSON.stringify({ text: '真实扩展工具' }),
        } }] });
        send({}, 'tool_calls');
      } else if (prompt.includes('LONG_BASH') && !hasToolResult) {
        const quotedPidPath = "'" + pidPath.replaceAll("'", "'\\''") + "'";
        send({
          tool_calls: [
            {
              index: 0,
              id: 'bash-fixture',
              type: 'function',
              function: {
                name: 'bash',
                arguments: JSON.stringify({
                  command: `echo $$ > ${quotedPidPath}; echo BASH_RUNNING; sleep 30`,
                }),
              },
            },
          ],
        });
        send({}, 'tool_calls');
      } else if (prompt.includes('WRITE_FIXTURE') && !hasToolResult) {
        send({
          tool_calls: [
            {
              index: 0,
              id: 'write-fixture',
              type: 'function',
              function: {
                name: 'write',
                arguments: JSON.stringify({
                  path: outputPath,
                  content: 'Written by real Pi Agent SDK\n',
                }),
              },
            },
          ],
        });
        send({}, 'tool_calls');
      } else {
        for (const word of (hasToolResult ? '工具已完成，文件已写入。' : '会话已继续。').split(
          '',
        )) {
          send({ content: word });
          await delay(35);
        }
        send({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'test-provider': {
          baseUrl,
          api: 'openai-completions',
          apiKey: 'test-only',
          models: [
            {
              id: 'fixture-agent',
              name: '本地协议测试模型',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'test-provider',
      defaultModel: 'fixture-agent',
      defaultThinkingLevel: 'off',
      retry: { enabled: false },
    }),
  );
  return {
    root,
    agentDir,
    project,
    outputPath,
    pidPath,
    state,
    baseUrl,
    close() {
      provider.closeAllConnections();
      provider.close();
    },
  };
}
export async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for condition');
}
