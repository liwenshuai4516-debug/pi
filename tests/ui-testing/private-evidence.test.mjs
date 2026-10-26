import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateEvidence, ArtifactStore } from '../../packages/ui-testing/dist/index.js';

async function fixture(t, secret = 'synthetic+/private-value') {
  const base = await mkdtemp(join(tmpdir(), 'ui-private-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'workspace'), authority = join(base, 'authority'), state = join(base, 'state.json');
  await mkdir(root);
  await writeFile(state, JSON.stringify({ cookies: [{ value: secret }], origins: [] }), { mode: 0o600 });
  const reference = 'PI_UI_PRIVATE_UNIT_STATE';
  assert.equal(process.env[reference], undefined);
  process.env[reference] = state;
  t.after(() => { delete process.env[reference]; });
  const environment = { auth: { kind: 'storage-state-env', reference } };
  const create = (dir = authority) => PrivateEvidence.create(root, dir, environment, 'qa/ui/runs/private');
  return { base, root, authority, state, reference, secret, environment, create };
}

test('private capture rejects workspace storage and symlinked/private-directory escapes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.create(f.root), /工作区外/);
  await mkdir(f.authority);
  await symlink(f.root, join(f.authority, 'private-evidence'));
  await assert.rejects(f.create(), /私密证据目录/);
  await rm(join(f.authority, 'private-evidence'));
  await mkdir(join(f.authority, 'private-evidence'), { mode: 0o755 });
  await assert.rejects(f.create(), /仅当前用户/);
  process.env[f.reference] = join(f.root, 'state.json');
  await writeFile(process.env[f.reference], await readFile(f.state));
  await assert.rejects(f.create(), /工作区外/);
});

test('anonymous capture is unchanged; private failures do not expose filesystem paths', async t => {
  const f = await fixture(t);
  assert.equal(await PrivateEvidence.create(f.root, undefined, { auth: { kind: 'none' } }, 'qa/ui/runs/none'), undefined);
  await writeFile(f.authority, 'not a directory');
  await assert.rejects(f.create(), error => !error.message.includes(f.base) && /不可用/.test(error.message));
});

test('private capture retains raw process separately and removes supported token/path encodings', async t => {
  const f = await fixture(t), capture = await f.create();
  const forms = value => [value, encodeURI(value), encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')];
  const raw = { code: 1, signal: null, stdout: [...forms(f.secret), ...forms(f.state), ...forms(capture.directory)].join('\n') };
  const sanitized = await capture.process(raw);
  assert.equal(sanitized.code, 1);
  for (const value of [...forms(f.secret), ...forms(f.state), ...forms(capture.directory)]) assert.equal(sanitized.stdout.includes(value), false);
  assert.deepEqual(JSON.parse(await readFile(join(capture.directory, 'process.json'), 'utf8')), raw);
  assert.equal((await stat(capture.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(capture.directory, 'process.json'))).mode & 0o777, 0o600);
  await rm(capture.directory, { recursive: true });
  await assert.rejects(capture.process(raw), error => !error.message.includes(f.base) && /不自动重放/.test(error.message));
});

test('secret attachment paths are opaque publicly and binary attachments remain private', async t => {
  const f = await fixture(t), capture = await f.create(), store = new ArtifactStore(f.root);
  const output = join(capture.directory, 'output', encodeURIComponent(f.secret));
  await mkdir(output, { recursive: true });
  const context = join(output, 'error-context.md'), screenshot = join(output, 'test-failed.png');
  await writeFile(context, f.secret);
  await writeFile(screenshot, f.secret);
  const report = { suites: [{ status: 'failed', attachments: [
    { name: 'error-context', path: context }, { name: 'screenshot', path: screenshot },
    { name: 'private-note', contentType: 'text/plain', body: Buffer.from(f.secret).toString('base64') },
  ] }] };
  await writeFile(join(capture.directory, 'native.json'), JSON.stringify(report));
  await capture.publish(store);
  const publicReport = JSON.parse(await readFile(join(f.root, 'qa/ui/runs/private/native.json'), 'utf8'));
  assert.equal(publicReport.suites[0].status, 'failed');
  const attachments = publicReport.suites[0].attachments;
  assert.equal(attachments.some(a => a.name === 'screenshot'), false);
  assert.equal((await readFile(attachments.find(a => a.name === 'error-context').path, 'utf8')).includes(f.secret), false);
  assert.equal(JSON.stringify(publicReport).includes(encodeURIComponent(f.secret)), false);
  assert.equal(Buffer.from(attachments.find(a => a.name === 'private-note').body, 'base64').toString(), '[PRIVATE]');
  const privacy = JSON.parse(Buffer.from(attachments.find(a => a.name === 'ui-evidence-privacy').body, 'base64').toString());
  assert.equal(privacy.withheld_attachment_count, 1);
});

test('redaction collision cannot rewrite native failure or pass status', async t => {
  const f = await fixture(t, 'failed'), capture = await f.create();
  await writeFile(join(capture.directory, 'native.json'), JSON.stringify({ suites: [{ status: 'failed' }] }));
  await assert.rejects(capture.publish(new ArtifactStore(f.root)), /不推断测试结果/);
  await assert.rejects(readFile(join(f.root, 'qa/ui/runs/private/native.json')), { code: 'ENOENT' });
});

test('runtime credential headers are collected before process, context and trace publication', async t => {
  const f = await fixture(t), capture = await f.create(), store = new ArtifactStore(f.root);
  await symlink(join(process.cwd(), 'node_modules'), join(f.root, 'node_modules'), 'dir');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { yazl } = require('playwright-core/lib/utilsBundle');
  const rotated = 'runtime+/rotated-credential==', bearer = 'runtime-bearer-credential';
  const zip = new yazl.ZipFile(), chunks = [];
  const finished = new Promise((resolve, reject) => {
    zip.outputStream.on('data', c => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  // Reflection precedes the network entry; publication must discover all credentials first.
  zip.addBuffer(Buffer.from(JSON.stringify({ type: 'stdout', text: rotated }) + '\n'), '0.trace');
  zip.addBuffer(Buffer.from(JSON.stringify({ response: { headers: [
    { name: 'Set-Cookie', value: `session=${rotated}; Path=/; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT` },
  ] }, request: { headers: { Authorization: `Bearer ${bearer}`, Cookie: `session=${rotated}; initial=${f.secret}` } } }) + '\n'), '0.network');
  zip.end();
  const output = join(capture.directory, 'output', 'attempt');
  await mkdir(output, { recursive: true });
  const trace = join(output, 'trace.zip'), context = join(output, 'error-context.md');
  await writeFile(trace, await finished);
  await writeFile(context, rotated);
  const raw = { code: 1, stdout: `${rotated}\n${encodeURIComponent(rotated)}\n${Buffer.from(rotated).toString('base64')}\n${bearer}` };
  const sanitized = await capture.process(raw);
  assert.equal(sanitized.code, 1);
  for (const token of [rotated, encodeURIComponent(rotated), Buffer.from(rotated).toString('base64'), bearer])
    assert.equal(sanitized.stdout.includes(token), false);
  assert.deepEqual(JSON.parse(await readFile(join(capture.directory, 'process.json'), 'utf8')), raw);
  await writeFile(join(capture.directory, 'native.json'), JSON.stringify({ suites: [{ status: 'failed', attachments: [
    { name: 'trace', path: trace }, { name: 'error-context', path: context },
    { name: 'note', contentType: 'text/plain', body: Buffer.from(rotated).toString('base64') },
  ] }] }));
  await capture.publish(store);
  const report = JSON.parse(await readFile(join(f.root, 'qa/ui/runs/private/native.json'), 'utf8'));
  assert.equal(report.suites[0].status, 'failed');
  const attachments = report.suites[0].attachments;
  assert.equal(await readFile(attachments.find(a => a.name === 'error-context').path, 'utf8'), '[PRIVATE]');
  assert.equal(Buffer.from(attachments.find(a => a.name === 'note').body, 'base64').toString(), '[PRIVATE]');
  // A corrupt trace must not fall back to publishing uninspected process text.
  await writeFile(trace, 'not a ZIP');
  await assert.rejects(capture.process(raw), /不发布进程输出/);
});

test('JSON storage string leaves stay private when reflected independently of their envelope', async t => {
  const f = await fixture(t);
  const token = 'json+/nested-token==', encoded = 'json-escaped-"token\\value';
  await writeFile(f.state, JSON.stringify({ cookies: [], origins: [{ origin: 'https://fixture.invalid', localStorage: [
    { name: 'session', value: JSON.stringify({ session: { credentials: [{ token }, { token: encoded }] } }) },
    { name: 'quoted-token', value: JSON.stringify('json-quoted-secret') },
    { name: 'raw-token', value: 'not-json+/raw-secret' },
  ] }] }), { mode: 0o600 });
  const capture = await f.create();
  const values = [token, encoded, 'json-quoted-secret', 'not-json+/raw-secret'];
  const forms = values.flatMap(value => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]);
  const raw = { code: 1, stdout: forms.join('\n') }, sanitized = await capture.process(raw);
  assert.equal(sanitized.code, 1);
  for (const value of forms) assert.equal(sanitized.stdout.includes(value), false);
  assert.deepEqual(JSON.parse(await readFile(join(capture.directory, 'process.json'), 'utf8')), raw);
  const output = join(capture.directory, 'output');
  await mkdir(output);
  const context = join(output, 'error-context.md');
  await writeFile(context, forms.join('\n'));
  await writeFile(join(capture.directory, 'native.json'), JSON.stringify({ suites: [{ status: 'failed', attachments: [
    { name: 'error-context', path: context },
    { name: 'note', contentType: 'text/plain', body: Buffer.from(token).toString('base64') },
  ] }] }));
  await capture.publish(new ArtifactStore(f.root));
  const report = JSON.parse(await readFile(join(f.root, 'qa/ui/runs/private/native.json'), 'utf8'));
  assert.equal(report.suites[0].status, 'failed');
  const attachments = report.suites[0].attachments;
  const published = await readFile(attachments.find(a => a.name === 'error-context').path, 'utf8');
  for (const value of forms) assert.equal(published.includes(value), false);
  assert.equal(Buffer.from(attachments.find(a => a.name === 'note').body, 'base64').toString(), '[PRIVATE]');
});

test('runtime storage observations retain new and removed values without trusting malformed state', async t => {
  const f = await fixture(t), capture = await f.create();
  const token = 'runtime-storage+/nested-token==', cookie = 'runtime-storage-cookie';
  const raw = `${token} ${encodeURIComponent(token)} ${Buffer.from(token).toString('base64')} ${cookie}`;
  assert.ok(capture.text(raw).includes(token));
  capture.observeStorageState({ cookies: [{ value: cookie }], origins: [{ origin: 'https://fixture.invalid', localStorage: [
    { name: 'session', value: JSON.stringify({ credentials: [{ token }] }) },
  ] }] });
  capture.observeStorageState({ cookies: [], origins: [] });
  assert.equal(capture.text(raw).includes(token), false);
  assert.equal(capture.text(raw).includes(encodeURIComponent(token)), false);
  assert.equal(capture.text(raw).includes(Buffer.from(token).toString('base64')), false);
  assert.equal(capture.text(raw).includes(cookie), false);
  assert.equal(capture.text('ordinary business text'), 'ordinary business text');
  for (const bad of [null, {}, { cookies: [], origins: [null] }, { cookies: [{ value: 'must-not-be-added' }], origins: [{ localStorage: [{ value: 42 }] }] }])
    assert.throws(() => capture.observeStorageState(bad), error => /存储状态无法核验/.test(error.message) && !error.message.includes('must-not-be-added'));
  assert.equal(capture.text('must-not-be-added'), 'must-not-be-added');
  assert.equal(capture.text(f.secret), '[PRIVATE]');
});
