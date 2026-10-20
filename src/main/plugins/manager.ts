import { basename, isAbsolute, join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import {
  DefaultPackageManager, SettingsManager, loadSkills, loadSkillsFromDir,
} from '@earendil-works/pi-coding-agent';
import type { PluginInventory } from '../../shared/types.js';

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
    const loaded = loadSkills({
      cwd: this.cwd, agentDir: this.agentDir, includeDefaults: false,
      skillPaths: paths.skills.filter((item) => item.enabled).map((item) => item.path),
    });
    return {
      packages: packages.listConfiguredPackages().map((item) => ({ source: item.source, installed: !!item.installedPath })),
      extensions: paths.extensions.filter((item) => item.enabled).map((item) => ({ name: basename(item.path), path: item.path })),
      skills: loaded.skills.map((item) => ({ name: item.name, description: item.description, path: item.filePath })),
      diagnostics: loaded.diagnostics.map((item) => item.message),
    };
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
        if (!isAbsolute(source)) throw new Error('本地 Skill 请使用完整目录路径，远程 Skill 请作为 Pi 资源包安装');
        const path = await realpath(source);
        const directory = (await stat(path)).isDirectory() ? path : undefined;
        if (!directory || !(await stat(join(directory, 'SKILL.md'))).isFile())
          throw new Error('请选择包含 SKILL.md 的 Skill 目录');
        const result = loadSkillsFromDir({ dir: directory, source: 'user' });
        if (!result.skills.length || result.diagnostics.some((item) => item.type === 'error'))
          throw new Error(result.diagnostics.map((item) => item.message).join('\n') || 'Skill 格式无效');
        settings.setSkillPaths([...new Set([...settings.getSkillPaths(), path])]);
      } else {
        await packages.installAndPersist(source);
      }
      await settings.flush();
      return await this.list();
    } finally {
      this.installing = false;
    }
  }
}
