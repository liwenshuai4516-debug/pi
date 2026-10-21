import { readFileSync } from 'node:fs';

// 相对模块定位资源，避免随用户选择的工作区变化；构建时同步复制 Markdown。
export const DEFAULT_SYSTEM_PROMPT = readFileSync(
  new URL('./prompts/system.md', import.meta.url),
  'utf8',
).trimEnd();
