import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function createInstallFixture(fixture) {
  const packageDir = join(fixture.root, 'local-pi-package');
  const skillDir = join(fixture.root, 'installed-skill');
  await mkdir(packageDir);
  await mkdir(skillDir);
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: 'desktop-install-proof', version: '1.0.0', type: 'module',
    pi: { extensions: ['./index.ts'] },
  }));
  await writeFile(join(packageDir, 'index.ts'), `
import { writeFileSync } from 'node:fs';
export default (pi) => {
  pi.registerTool({
    name: 'conversation_read', label: '读取会话', description: 'Install verification tool',
    parameters: { type: 'object', properties: {} },
    execute: async (_id, _args, _signal, _onUpdate, ctx) => {
      writeFileSync(ctx.cwd + '/installed-plugin-proof.txt', 'INSTALLED_PLUGIN_EXECUTED');
      return { content: [{ type: 'text', text: 'INSTALLED_PLUGIN_EXECUTED' }], details: {} };
    },
  });
};
`);
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: installed-skill\ndescription: INSTALL_SKILL_DESCRIPTION\n---\nSKILL_INSTALL_PROOF: inspect requirements and report evidence.\n');
  await writeFile(join(skillDir, 'reference.txt'), 'SKILL_REFERENCE_PROOF');
  return { packageDir, skillDir };
}
