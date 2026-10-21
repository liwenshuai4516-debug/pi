import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analysisInputs } from './analysis.js';
import type { FileRef } from './contracts.js';
import { sha256, verifyReferences, workspacePath, WorkflowError } from './validation.js';

/** 复用已锁定 Playwright 的 ZIP 库，只读原始事件，不解压路径、不接受模型生成的摘录。 */
export async function traceEvidence(root: string, resultsRef: FileRef, traceRef: FileRef) {
  const input = await analysisInputs(root, resultsRef);
  const owners = input.data.instances.flatMap(i => i.attempts.filter(a => a.evidence_refs.some(r =>
    r.path === traceRef.path && r.sha256 === traceRef.sha256)).map(a => ({ instance_id: i.instance_id, attempt: a.attempt })));
  if (!owners.length || !traceRef.path.endsWith('/trace.zip')) throw new WorkflowError('insufficient-evidence', 'trace 必须属于本批次已登记实例/attempt');
  await verifyReferences(root, traceRef);
  const bytes = await readFile(await workspacePath(root, traceRef.path));
  if (bytes.length > 32 * 1024 * 1024) throw new WorkflowError('insufficient-evidence', 'trace 超出读取预算，不截断后作为完整证据');
  const require = createRequire(join(root, 'package.json'));
  if (require('playwright-core/package.json').version !== '1.62.1') throw new WorkflowError('incompatible-version', 'trace 读取仅验证过 Playwright 1.62.1');
  const { yauzl } = require('playwright-core/lib/utilsBundle');
  const zip = await new Promise<any>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (e: Error | null, z: unknown) => e ? reject(e) : resolve(z)));
  const events: { entry: string; line: number; event: unknown }[] = [];
  let size = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);zip.on('end', resolve);
      zip.on('entry', async (entry: { fileName: string; uncompressedSize: number }) => {
        try {
          if (!entry.fileName.endsWith('.trace')) { zip.readEntry();return; }
          size += entry.uncompressedSize;
          if (size > 4 * 1024 * 1024) throw new Error('trace event budget');
          const stream = await new Promise<any>((resolve, reject) => zip.openReadStream(entry, (e: Error | null, s: unknown) => e ? reject(e) : resolve(s)));
          const chunks: Buffer[] = [];let actualSize = 0;
          for await (const chunk of stream) { actualSize += chunk.length;if (actualSize > entry.uncompressedSize) throw new Error('trace size mismatch');chunks.push(chunk); }
          Buffer.concat(chunks).toString('utf8').split('\n').forEach((line, index) => {
            if (!line.trim()) return;
            const event = JSON.parse(line);
            if (['before', 'after', 'log', 'event', 'console'].includes(event.type)) events.push({ entry: entry.fileName, line: index + 1, event });
          });
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
  } catch { throw new WorkflowError('insufficient-evidence', 'trace 事件无法完整读取，保留原归档，不补造内容'); }
  finally { zip.close(); }
  if (!events.length) throw new WorkflowError('insufficient-evidence', 'trace 中没有可读取事件');
  const output = { source_ref: traceRef, owners, selection: 'All before/after/log/event/console records from *.trace; excludes snapshots, resources and network archives. Not proof of server root cause.', events };
  if (Buffer.byteLength(JSON.stringify(output)) > 512 * 1024) throw new WorkflowError('insufficient-evidence', 'trace 事件超出评估预算，不静默截断');
  // 前后核对原始归档；返回内容由原始字节重算，不能混入手工伪造的摘录。
  if (sha256(await readFile(await workspacePath(root, traceRef.path))) !== traceRef.sha256) throw new WorkflowError('insufficient-evidence', 'trace 在读取期间变化');
  return output;
}
