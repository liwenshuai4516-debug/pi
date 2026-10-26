import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { authState, type UiEnvironment } from './environment.js';
import { ArtifactStore } from './store.js';
import { sha256, WorkflowError } from './validation.js';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const variants = (value: string) => [value, encodeURI(value), encodeURIComponent(value),
  JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')];
// storageState 常把认证对象存为 JSON 字符串；浏览器可单独反射其中的字符串值。
// 只解码存储项的一层 JSON，不猜测任意编码或将响应正文当秘密字典。
const storageSecrets = (value: string): string[] => {
  const values = [value];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return values; }
  const pending: unknown[] = [parsed];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') values.push(item);
    else if (item && typeof item === 'object') pending.push(...Object.values(item));
  }
  return values;
};
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
};

/** Raw authenticated capture never enters the workspace. Public copies are explicitly reduced evidence. */
export class PrivateEvidence {
  private readonly publishedPaths = new Map<string, string>();
  readonly env: Record<string, string>;
  readonly marker = { authenticated: true, redacted: true, media_withheld: true,
    private_capture_id: '',
    limitation: 'Public capture excludes binary resources and images; it is not complete visual evidence.' };
  private constructor(readonly root: string, readonly directory: string, readonly publicBase: string,
    private readonly secrets: string[]) {
    this.env = { PI_UI_PRIVATE_EVIDENCE_DIR: directory };
    this.marker.private_capture_id = basename(directory);
  }
  static async create(root: string, authority: string | undefined, environment: UiEnvironment, publicBase: string) {
    if (environment.auth.kind === 'none') return undefined;
    try {
      if (!authority) throw new WorkflowError('precondition', '私密证据需要宿主私有目录，不能写入工作区');
      root = await realpath(root);
      const statePath = await realpath((await authState(environment, root))!);
      await mkdir(authority, { recursive: true, mode: 0o700 });
      authority = await realpath(authority);
      if (within(root, authority) || within(root, statePath))
        throw new WorkflowError('precondition', '认证文件和原始私密证据必须位于工作区外');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const secrets = [...new Set([statePath, process.env[environment.auth.reference!]!].flatMap(variants))];
      const base = join(authority, 'private-evidence');
      await mkdir(base, { recursive: true, mode: 0o700 });
      const info = await lstat(base);
      if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) || within(root, await realpath(base)))
        throw new WorkflowError('precondition', '私密证据目录必须位于工作区外且仅当前用户可访问');
      const directory = join(base, randomUUID());
      await mkdir(directory, { mode: 0o700 });
      const capture = new PrivateEvidence(root, directory, publicBase, secrets);
      capture.observeStorageState(state);
      return capture;
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError('precondition', '私密证据目录或认证文件不可用；未启动测试进程');
    }
  }
  /** 宿主从实际浏览器私有采集；先完整校验再累积，删除/轮换不遗忘旧值。 */
  observeStorageState(state: unknown) {
    const values: string[] = [];
    try {
      if (!state || typeof state !== 'object') throw new Error();
      const { cookies, origins } = state as { cookies: unknown; origins: unknown };
      if (!Array.isArray(cookies) || !Array.isArray(origins)) throw new Error();
      const collect = (items: unknown[]) => {
        for (const item of items) {
          if (!item || typeof item !== 'object' || typeof (item as { value?: unknown }).value !== 'string') throw new Error();
          values.push(...storageSecrets((item as { value: string }).value));
        }
      };
      collect(cookies);
      for (const origin of origins) {
        if (!origin || typeof origin !== 'object') throw new Error();
        const { localStorage } = origin as { localStorage?: unknown };
        if (localStorage !== undefined && !Array.isArray(localStorage)) throw new Error();
        collect(localStorage ?? []);
      }
    } catch {
      throw new WorkflowError('insufficient-evidence', '私密存储状态无法核验；不发布原始输出或自动重放');
    }
    for (const value of values.filter(Boolean))
      for (const variant of variants(value)) if (!this.secrets.includes(variant)) this.secrets.push(variant);
    this.secrets.sort((a, b) => b.length - a.length);
  }
  text(value: string) {
    for (const [source, target] of this.publishedPaths) value = value.split(source).join(target);
    for (const path of variants(this.directory)) value = value.split(path).join(join(this.root, this.publicBase));
    for (const secret of this.secrets) value = value.split(secret).join('[PRIVATE]');
    return value;
  }
  redact(value: any): any {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map(item => this.redact(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.text(key), this.redact(item)]));
  }
  private credentials(value: any) {
    if (!value || typeof value !== 'object') return;
    const header = (name: string, content: unknown) => {
      if (typeof content !== 'string' || !/^(cookie|set-cookie|authorization|proxy-authorization)$/i.test(name)) return;
      const values = [content];
      if (/authorization$/i.test(name)) values.push(content.replace(/^(Bearer|Basic)\s+/i, ''));
      else {
        const cookies = /^set-cookie$/i.test(name) ? content.split(/,(?=\s*[^=;,\s]+=)/) : content.split(';');
        for (const cookie of cookies) {
          const match = cookie.trim().match(/^[^=;\s]+=([^;]*)/);
          if (match) values.push(match[1]);
        }
      }
      for (const token of values.filter(Boolean))
        for (const variant of variants(token)) if (!this.secrets.includes(variant)) this.secrets.push(variant);
      this.secrets.sort((a, b) => b.length - a.length);
    };
    // 从私有 trace 的标准认证头收集轮换值，不把响应正文当凭据词典。
    if (typeof value.name === 'string') header(value.name, value.value);
    for (const [key, item] of Object.entries(value)) {
      header(key, item);
      this.credentials(item);
    }
  }
  private async discoverCredentials(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('private trace symlink');
      if (entry.isDirectory()) await this.discoverCredentials(join(path, entry.name));
      else if (entry.isFile() && entry.name === 'trace.zip') await this.trace(await readFile(join(path, entry.name)), true);
    }
  }
  async process<T>(result: T): Promise<T> {
    try { await writeFile(join(this.directory, 'process.json'), json(result), { mode: 0o600 }); }
    catch { throw new WorkflowError('insufficient-evidence', '原始私密进程记录未能保存；执行结果未确认，不自动重放'); }
    try { await this.discoverCredentials(join(this.directory, 'output')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new WorkflowError('insufficient-evidence', '私密认证头无法核验；原始捕获保留，不发布进程输出或自动重放');
    }
    return this.redact(result);
  }
  private async trace(bytes: Buffer, discoverOnly = false) {
    const projectRequire = createRequire(join(this.root, 'package.json'));
    const require = createRequire(projectRequire.resolve('playwright/package.json'));
    if (require('playwright-core/package.json').version !== '1.62.1')
      throw new WorkflowError('incompatible-version', '私密 trace 仅支持锁定的 Playwright 1.62.1');
    const { yauzl, yazl } = require('playwright-core/lib/utilsBundle');
    const input = await new Promise<any>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true },
      (error: Error | null, archive: unknown) => error ? reject(error) : resolve(archive)));
    const output = new yazl.ZipFile(), chunks: Buffer[] = [];
    const finished = new Promise<Buffer>((resolve, reject) => {
      output.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      output.outputStream.on('error', reject);
      output.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    let size = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        input.on('error', reject); input.on('end', resolve);
        input.on('entry', async (entry: { fileName: string; uncompressedSize: number }) => {
          try {
            // Binary resources (including screenshots and response bodies) stay private.
            if (!/^[\w.-]+\.(trace|network|stacks)$/.test(entry.fileName)) { input.readEntry(); return; }
            size += entry.uncompressedSize;
            if (size > 32 * 1024 * 1024) throw new Error('private trace budget');
            const stream = await new Promise<any>((resolve, reject) => input.openReadStream(entry,
              (error: Error | null, stream: unknown) => error ? reject(error) : resolve(stream)));
            const parts: Buffer[] = []; let actual = 0;
            for await (const chunk of stream) {
              actual += chunk.length;
              if (actual > entry.uncompressedSize) throw new Error('private trace size mismatch');
              parts.push(chunk);
            }
            const lines = Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)
              .map(line => {
                const value = JSON.parse(line);
                if (discoverOnly) this.credentials(value);
                return JSON.stringify(discoverOnly ? null : this.redact(value));
              });
            output.addBuffer(Buffer.from(lines.join('\n') + '\n'), this.text(entry.fileName));
            input.readEntry();
          } catch (error) { reject(error); }
        });
        input.readEntry();
      });
      output.addBuffer(Buffer.from(json(this.marker)), 'ui-evidence-privacy.json');
      output.end();
      return await finished;
    } catch {
      output.end();
      await finished.catch(() => {});
      throw new WorkflowError('insufficient-evidence', '私密 trace 无法生成公开副本，原始文件保留在私有目录');
    } finally { input.close(); }
  }
  async publish(store: ArtifactStore) {
    try {
      const published = new Set<string>();
      const walk = async (path: string, local: string) => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const name = `${local}/${entry.name}`, source = join(path, entry.name);
          if (entry.isSymbolicLink()) throw new WorkflowError('precondition', '私密证据不接受符号链接');
          if (entry.isDirectory()) { await walk(source, name); continue; }
          if (!entry.isFile() || !['trace.zip', 'error-context.md'].includes(entry.name)) continue;
          const bytes = await readFile(source);
          const publicBytes = entry.name === 'trace.zip' ? await this.trace(bytes)
            : Buffer.from(this.text(bytes.toString('utf8')));
          // 测试标题可能进入附件目录名；公开路径使用摘要，不能直接复制原路径。
          const ref = await store.putFile(`${this.publicBase}/output/${sha256(name)}/${entry.name}`, publicBytes);
          this.publishedPaths.set(source, join(this.root, ref.path));
          published.add(join(this.root, ref.path));
        }
      };
      try { await walk(join(this.directory, 'output'), '/output'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const report = JSON.parse(await readFile(join(this.directory, 'native.json'), 'utf8'));
      const transform = (value: any): any => {
        if (Array.isArray(value)) return value.map(transform);
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value.attachments)) {
          const count = value.attachments.length;
          value.attachments = value.attachments.filter((a: any) => {
            if (a.path) return published.has(this.text(a.path));
            if (!a.body) return true;
            if (!/^(application\/json|text\/)/.test(a.contentType ?? '')) return false;
            a.body = Buffer.from(this.text(Buffer.from(a.body, 'base64').toString('utf8'))).toString('base64');
            return true;
          });
          value.attachments.push({ name: 'ui-evidence-privacy', contentType: 'application/json',
            body: Buffer.from(json({ ...this.marker, withheld_attachment_count: count - value.attachments.length,
              trace_resources_withheld: value.attachments.some((a: any) => a.name === 'trace') })).toString('base64') });
        }
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transform(item)]));
      };
      const transformed = transform(report), sanitized = this.redact(transformed);
      // 短认证值可能与 reporter 字段/状态重名：宁可保留缺证据，也不能改写通过/失败事实。
      const checkStructure = (before: any, after: any) => {
        if (!before || typeof before !== 'object') return;
        if (JSON.stringify(Object.keys(before)) !== JSON.stringify(Object.keys(after))) throw new Error('report keys changed');
        for (const [key, value] of Object.entries(before)) {
          if (['status', 'expectedStatus', 'projectName'].includes(key) && value !== after[key]) throw new Error('report status changed');
          checkStructure(value, after[key]);
        }
      };
      checkStructure(transformed, sanitized);
      await store.putFile(`${this.publicBase}/native.json`, json(sanitized));
      return store.putFile(`${this.publicBase}/privacy.json`, json(this.marker));
    } catch {
      throw new WorkflowError('insufficient-evidence', '私密证据无法安全生成公开副本；原始记录保留在私有目录，不推断测试结果');
    }
  }
}

/** The generated config carries only an environment-variable name, never the private directory. */
export const privateCaptureConfig = `...(process.env.PI_UI_PRIVATE_EVIDENCE_DIR?{outputDir:process.env.PI_UI_PRIVATE_EVIDENCE_DIR+'/output',reporter:[['json',{outputFile:process.env.PI_UI_PRIVATE_EVIDENCE_DIR+'/native.json'}]]}:{}),`;
