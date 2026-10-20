export function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
export const escape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
export const nameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() || path;
