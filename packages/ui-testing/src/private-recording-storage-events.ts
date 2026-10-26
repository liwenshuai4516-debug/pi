/** Chromium 单 page 存储观察；由受管 fixture 在导航前安装，不登记模型工具。 */
import type { Page } from '@playwright/test';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const maxBytes = 2 * 1024 * 1024;
const maxEvents = 128;
const flushKey = '__pi_private_storage_flush';
const blocked = () =>
  Error(
    'Private storage observation unavailable; withhold output and do not replay',
  );
const outside = (root: string, file: string) => {
  const path = relative(root, file);
  return isAbsolute(path) || path === '..' || path.startsWith('../');
};

/** Installs on one Chromium page before the seed navigates. The file must be outside the workspace. */
export async function observePrivateStorage(page: Page, file: string) {
  if (
    page.url() !== 'about:blank' ||
    page.frames().length !== 1 ||
    page.context().pages().length !== 1
  )
    throw blocked();
  file = resolve(file);
  if (!outside(process.cwd(), file)) throw blocked();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(file));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o077 ||
    realpathSync(dirname(file)) !== dirname(file)
  )
    throw blocked();
  const initial = JSON.stringify({ type: 'starting', version: 1 }) + '\n';
  writeFileSync(file, initial, { mode: 0o600, flag: 'wx' });
  let failed = false,
    disposed = false,
    count = 1,
    bytes = Buffer.byteLength(initial);
  const append = (event: Record<string, unknown>) => {
    if (failed || disposed) return;
    try {
      const line = JSON.stringify(event) + '\n';
      if (++count > maxEvents || (bytes += Buffer.byteLength(line)) > maxBytes)
        throw blocked();
      appendFileSync(file, line);
    } catch {
      failed = true;
    }
  };
  const client = await page.context().newCDPSession(page);
  const types = [
    'DOMStorage.domStorageItemAdded',
    'DOMStorage.domStorageItemUpdated',
    'DOMStorage.domStorageItemRemoved',
    'DOMStorage.domStorageItemsCleared',
  ] as const;
  const listeners: [
    (typeof types)[number],
    (event: Record<string, unknown>) => void,
  ][] = [];
  for (const type of types) {
    const listener = (event: Record<string, unknown>) =>
      append({ type: type.slice('DOMStorage.'.length), ...event });
    client.on(type, listener);
    listeners.push([type, listener]);
  }
  const unsupported = () => append({ type: 'unsupported-new-page' });
  const unsupportedFrame = () => append({ type: 'unsupported-frame' });
  const disconnected = () => {
    failed = true;
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    page.context().off('page', unsupported);
    page.off('frameattached', unsupportedFrame);
    client.off('close', disconnected);
    for (const [type, listener] of listeners) client.off(type, listener);
    await client.detach().catch(() => {});
  };
  const flush = async () => {
    if (failed || disposed) throw blocked();
    try {
      await client.send('Runtime.evaluate', { expression: 'void 0' });
    } catch {
      failed = true;
      throw blocked();
    }
    append({ type: 'barrier' });
    if (failed || disposed) throw blocked();
  };
  client.on('close', disconnected);
  page.context().on('page', unsupported);
  page.on('frameattached', unsupportedFrame);
  page.once('close', () => {
    void dispose();
  });
  try {
    await client.send('DOMStorage.enable');
    append({ type: 'ready', version: 1 });
    Object.defineProperty(page, flushKey, { value: flush });
    if (failed) throw blocked();
    return { flush, dispose };
  } catch {
    await dispose();
    throw blocked();
  }
}

/** Actual CDP values normalized for PrivateEvidence only; never a reconstructed browser snapshot. */
export function readPrivateStorageEvents(file: string, origin: string) {
  try {
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.size > maxBytes
    )
      throw blocked();
    const bytes = readFileSync(file),
      text = bytes.toString('utf8');
    if (bytes.length > maxBytes || !text.endsWith('\n')) throw blocked();
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (
      events.length > maxEvents ||
      events[0]?.type !== 'starting' ||
      events[0]?.version !== 1 ||
      events[1]?.type !== 'ready' ||
      events[1]?.version !== 1 ||
      events.at(-1)?.type !== 'barrier'
    )
      throw blocked();
    const values = [];
    for (const event of events.slice(2, -1)) {
      if (event.type === 'barrier') continue;
      if (
        ![
          'domStorageItemAdded',
          'domStorageItemUpdated',
          'domStorageItemRemoved',
          'domStorageItemsCleared',
        ].includes(event.type) ||
        event.storageId?.securityOrigin !== origin ||
        typeof event.storageId?.isLocalStorage !== 'boolean'
      )
        throw blocked();
      if (
        event.type !== 'domStorageItemsCleared' &&
        typeof event.key !== 'string'
      )
        throw blocked();
      if (
        ['domStorageItemAdded', 'domStorageItemUpdated'].includes(event.type) &&
        typeof event.newValue !== 'string'
      )
        throw blocked();
      if (
        event.type === 'domStorageItemUpdated' &&
        typeof event.oldValue !== 'string'
      )
        throw blocked();
      for (const key of ['oldValue', 'newValue'])
        if (event[key] !== undefined) {
          if (typeof event[key] !== 'string') throw blocked();
          values.push({ value: event[key] });
        }
    }
    return {
      stateForFilter: { cookies: [], origins: [{ localStorage: values }] },
      bytes,
      eventCount: events.length,
      valueObservations: values.length,
    };
  } catch {
    throw blocked();
  }
}
