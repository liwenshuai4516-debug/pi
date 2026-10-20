/** 展开 Pi 声明式提示模板；只做一次替换，不递归解释用户参数。 */
export function expandTemplate(
  templates: { name: string; content: string }[],
  text: string,
): string {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const template = match && templates.find((item) => item.name === match[1]);
  if (!template || !match) return text;
  const args: string[] = [];
  let current = '',
    quote = '';
  for (const char of match[2] ?? '') {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else current += char;
  }
  if (current) args.push(current);
  // 沿用 Pi 模板的参数、默认值与切片语义；单次替换避免递归展开用户输入。
  return template.content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_, target: string, fallback: string, start: string, length: string, simple: string) => {
      if (target)
        return (
          (target === '@' || target === 'ARGUMENTS' ? args.join(' ') : args[Number(target) - 1]) ||
          fallback
        );
      if (start) {
        const offset = Math.max(0, Number(start) - 1);
        return args.slice(offset, length ? offset + Number(length) : undefined).join(' ');
      }
      return simple === '@' || simple === 'ARGUMENTS'
        ? args.join(' ')
        : (args[Number(simple) - 1] ?? '');
    },
  );
}
