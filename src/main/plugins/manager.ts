import { basename, isAbsolute, join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import {
  DefaultPackageManager, SettingsManager, loadSkills, loadSkillsFromDir,
} from '@earendil-works/pi-coding-agent';
import type { PluginInventory } from '../../shared/types.js';

/** 只提取单个安装来源交给 SDK，不把用户粘贴的命令交给终端执行。 */
export function packageInstallSource(input: string): string {
  const source = input.trim();
  if (!/^pi(?:\s|$)/.test(source)) return source;
  const command = /^pi\s+install\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))$/.exec(source);
  if (!command) throw new Error('请输入 pi install <来源>，一次安装一个资源包；含空格的路径请用引号包裹');
  const target = command[1] ?? command[2] ?? command[3];
  if (!target.trim()) throw new Error('请填写有效的资源包来源');
  if (target.startsWith('-')) throw new Error('此处安装到用户级配置，请移除 --local、-l 等命令选项');
  if (command[3] && /[;&|`$<>]/.test(target)) throw new Error('请只填写资源包来源，不要附加其他命令');
  return target;
}

/** 全局安装复用 Pi 配置与包协议；资源清单只解析路径，实际加载由会话完成。 */
export class PluginManager {
  private installing = false;
  constructor(private agentDir: string, private cwd: string) {}
  private context() {
    const settings = SettingsManager.create(this.cwd, this.agentDir);
    return { settings, packages: new DefaultPackageManager({ cwd: this.cwd, agentDir: this.agentDir, settingsManager: settings }) };
  }
  async list(): Promise<PluginInventory> {
    const { packages } = this.context();
    const paths = await packages.resolve(async () => 'skip');
    const loaded = paths.skills.map((resource) => ({
      resource,
      result: loadSkills({ cwd: this.cwd, agentDir: this.agentDir, includeDefaults: false, skillPaths: [resource.path] }),
    }));
    return {
      packages: packages.listConfiguredPackages().map((item) => ({ source: item.source, installed: !!item.installedPath })),
      extensions: paths.extensions.map((item) => ({ name: basename(item.path), path: item.path, enabled: item.enabled, source: item.metadata.source })),
      skills: loaded.flatMap(({ resource, result }) => result.skills.map((item) => ({
        name: item.name, description: item.description, path: item.filePath, enabled: resource.enabled, source: resource.metadata.source,
      }))),
      diagnostics: loaded.flatMap(({ result }) => result.diagnostics.map((item) => item.message)),
    };
  }
  async setEnabled(path: string, kind: 'extension' | 'skill', enabled: boolean): Promise<PluginInventory> {
    if (kind !== 'extension' && kind !== 'skill' || typeof enabled !== 'boolean') throw new Error('开关参数无效');
    const { settings, packages } = this.context();
    const paths = await packages.resolve(async () => 'skip');
    const type = kind === 'extension' ? 'extensions' : 'skills';
    const resource = paths[type].find((item) => item.path === path);
    if (!resource || resource.metadata.scope !== 'user') throw new Error('未找到可管理的用户级资源');
    // Pi 包的过滤规则保存在包条目内；顶层路径规则不能禁用包内资源。
    const update = (entries: string[]) => [
      ...entries.filter((entry) => entry !== `+${path}` && entry !== `-${path}`),
      `${enabled ? '+' : '-'}${path}`,
    ];
    if (resource.metadata.origin === 'package') {
      settings.setPackages((settings.getGlobalSettings().packages ?? []).map((entry) => {
        const source = typeof entry === 'string' ? entry : entry.source;
        if (source !== resource.metadata.source) return entry;
        const pkg = typeof entry === 'string' ? { source } : entry;
        return { ...pkg, [type]: update(pkg[type] ?? []) };
      }));
    } else if (type === 'extensions') {
      settings.setExtensionPaths(update(settings.getGlobalSettings().extensions ?? []));
    } else {
      settings.setSkillPaths(update(settings.getGlobalSettings().skills ?? []));
    }
    await settings.flush();
    return this.list();
  }
  async install(source: string, kind: 'package' | 'skill'): Promise<PluginInventory> {
    if (this.installing) throw new Error('正在安装，请等待完成');
    if (typeof source !== 'string' || !source.trim() || source.length > 2000 || /[\x00-\x1f]/.test(source))
      throw new Error('请填写有效的安装来源');
    if (kind !== 'package' && kind !== 'skill') throw new Error('安装类型无效');
    this.installing = true;
    try {
      const { settings, packages } = this.context();
      source = source.trim();
      if (kind === 'skill') {
        if (!isAbsolute(source)) throw new Error('本地技能 请使用完整目录路径，远程技能 请作为 Pi 资源包安装');
        const path = await realpath(source);
        const directory = (await stat(path)).isDirectory() ? path : undefined;
        if (!directory || !(await stat(join(directory, 'SKILL.md'))).isFile())
          throw new Error('请选择包含 SKILL.md 的技能目录');
        const result = loadSkillsFromDir({ dir: directory, source: 'user' });
        if (!result.skills.length || result.diagnostics.some((item) => item.type === 'error'))
          throw new Error(result.diagnostics.map((item) => item.message).join('\n') || '技能格式无效');
        settings.setSkillPaths([...new Set([...settings.getSkillPaths(), path])]);
      } else {
        await packages.installAndPersist(packageInstallSource(source));
      }
      await settings.flush();
      return await this.list();
    } finally {
      this.installing = false;
    }
  }
  async packageAction(source: string, action: 'update' | 'remove'): Promise<PluginInventory> {
    const { settings } = this.context();
    // 清单中的本地来源相对用户配置目录；Pi 管理命令的输入则相对 cwd 解析。
    const packages = new DefaultPackageManager({ cwd: this.agentDir, agentDir: this.agentDir, settingsManager: settings });
    if (!packages.listConfiguredPackages().some((item) => item.source === source && item.scope === 'user')) throw new Error('未找到用户级资源包');
    if (action === 'remove') {
      if (!await packages.removeAndPersist(source)) throw new Error('资源包配置未移除，请刷新后重试');
    }
    else if (action === 'update') await packages.update(source);
    else throw new Error('资源包操作无效');
    await settings.flush();
    return this.list();
  }
}
