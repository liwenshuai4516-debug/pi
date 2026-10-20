import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import type { ModelConfigInput } from '../../shared/types.js';

export function validateModelConfig(input: ModelConfigInput): void {
  if (
    !input ||
    typeof input !== 'object' ||
    ![input.provider, input.modelId, input.baseUrl, input.apiKey].every(
      (value) => typeof value === 'string',
    )
  )
    throw new Error('模型配置格式错误');
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(input.provider) ||
    ['__proto__', 'constructor', 'prototype'].includes(input.provider)
  )
    throw new Error('提供商名称只允许字母、数字、点、横线和下划线');
  if (!input.modelId.trim() || input.modelId.length > 256) throw new Error('请输入模型 ID');
  const url = new URL(input.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('请输入有效的 HTTP(S) API 地址');
  if (input.reasoning !== undefined && typeof input.reasoning !== 'boolean')
    throw new Error('思考能力须为布尔值');
  if (!input.apiKey.trim()) throw new Error('请输入 API Key；无认证的本地模型可填写其要求的占位值');
}
async function updateJson(
  file: string,
  update: (value: Record<string, unknown>) => void,
  atomic: boolean,
): Promise<void> {
  try {
    await writeFile(file, '{}', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const release = await lockfile.lock(file, {
    retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
  });
  try {
    const value: unknown = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('原有配置不是有效的 JSON 对象，已保留原文件');
    update(value as Record<string, unknown>);
    const text = JSON.stringify(value, null, 2) + '\n';
    if (atomic) {
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, file);
    } else {
      await writeFile(file, text, { mode: 0o600 });
      await chmod(file, 0o600);
    }
  } finally {
    await release();
  }
}
export async function saveModelConfig(agentDir: string, input: ModelConfigInput): Promise<void> {
  validateModelConfig(input);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await updateJson(
    join(agentDir, 'models.json'),
    (value) => {
      const providers = (value.providers ??= {}) as Record<string, Record<string, unknown>>;
      if (!providers || typeof providers !== 'object' || Array.isArray(providers))
        throw new Error('原有 providers 配置格式错误，已保留原文件');
      const existing = providers[input.provider] ?? {};
      if (existing.api && existing.api !== 'openai-completions')
        throw new Error('该提供商使用其他模型协议，请在 Pi 原配置中编辑；不会覆盖原协议');
      const models = Array.isArray(existing.models)
        ? ([...existing.models] as Record<string, unknown>[])
        : [];
      const index = models.findIndex((model) => model.id === input.modelId);
      const model: Record<string, unknown> =
        index >= 0 ? { ...models[index] } : { id: input.modelId };
      // 未声明时保留原能力配置；明确勾选/取消才更新，不根据模型名字猜测。
      if (input.reasoning !== undefined) model.reasoning = input.reasoning;
      if (index >= 0) models[index] = model;
      else models.push(model);
      providers[input.provider] = {
        ...existing,
        baseUrl: input.baseUrl,
        api: 'openai-completions',
        models,
      };
    },
    true,
  );
  // Same auth.json shape and proper-lockfile lock as Pi. Credentials never return
  // to the renderer, logs or session transcript.
  await updateJson(
    join(agentDir, 'auth.json'),
    (value) => {
      value[input.provider] = { type: 'api_key', key: input.apiKey };
    },
    false,
  );
}
