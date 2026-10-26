import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import * as native from '../../packages/ui-testing/dist/index.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:18989';
const exec = promisify(execFile);

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'native-recording-capture-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'work'),
    authority = join(root, 'host');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(authority, { mode: 0o700 });
  await symlink(
    join(repo, 'node_modules'),
    join(workspace, 'node_modules'),
    'dir',
  );
  await writeFile(join(workspace, 'package.json'), '{"type":"module"}');
  const reference =
    'PI_UI_DATA_SPACE_' + randomUUID().replaceAll('-', '').toUpperCase();
  const statePath = join(authority, 'state.json'),
    initial = 'synthetic-initial-' + randomUUID(),
    transient = 'synthetic-transient-' + randomUUID();
  const state = {
    cookies: [],
    origins: [{ origin, localStorage: [{ name: 'auth', value: initial }] }],
    pi_ui_private: {
      version: 1,
      reference,
      workspace,
      origin,
      baseUrl: origin + '/',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  process.env[reference] = statePath;
  t.after(() => {
    delete process.env[reference];
  });
  const environment = {
    schema_version: '1.0',
    environment_id: 'fixture',
    deployment_version: 'capture-v1',
    base_url: origin + '/',
    role: 'fixture',
    identity: { selector: 'h1', text: 'Fixture' },
    initial_state: { selector: 'button', text: 'Continue' },
    auth: { kind: 'storage-state-env', reference },
    isolation: 'context',
    timeout_ms: 1000,
  };
  const privacy = await native.PrivateEvidence.create(
    workspace,
    authority,
    environment,
    'qa/ui/recordings/capture',
  );
  const body =
    '<h1>Fixture</h1><button>Continue</button><div id="echo"></div><script>' +
    'const v=' +
    JSON.stringify(transient) +
    ';localStorage.setItem("fresh",JSON.stringify({nested:{token:v}}));' +
    'localStorage.removeItem("fresh");sessionStorage.setItem("session",v);sessionStorage.clear();' +
    'document.querySelector("#echo").textContent=v;</script>';
  return {
    root,
    workspace,
    authority,
    statePath,
    state,
    environment,
    privacy,
    initial,
    transient,
    body,
  };
}

async function browserFixture(t, f) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ storageState: f.statePath });
  const page = await context.newPage();
  await page.route(origin + '/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: f.body }),
  );
  return { browser, context, page };
}

test(
  'native capture installs before navigation, retains transient storage and private trace, and filters before public use',
  { timeout: 30000 },
  async (t) => {
    assert.equal(typeof native.installPrivateRecordingCapture, 'function');
    const f = await fixture(t),
      b = await browserFixture(t, f);
    const capture = await native.installPrivateRecordingCapture(
      b.page,
      f.environment,
      f.workspace,
      f.privacy.directory,
    );
    t.after(capture.dispose);
    await b.page.goto(origin + '/');
    assert.equal(
      await b.page.evaluate(() => localStorage.getItem('fresh')),
      null,
    );
    assert.equal(await b.page.locator('#echo').textContent(), f.transient);
    const value = await b.page.__pi_private_recording_capture(1);
    assert.equal(value, undefined);
    const output = join(f.privacy.directory, 'output/recording');
    const observed = native.readPrivateStorageEvents(
      join(output, 'storage-events.ndjson'),
      origin,
    );
    assert.ok(JSON.stringify(observed.stateForFilter).includes(f.transient));
    const storage = JSON.parse(
      await readFile(join(output, 'capture-1/storage.json'), 'utf8'),
    );
    assert.equal(
      storage.origins[0].localStorage.some((item) => item.name === 'fresh'),
      false,
    );
    f.privacy.observeStorageState(observed.stateForFilter);
    f.privacy.observeStorageState(storage);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(output, 'capture-1/complete.json'), 'utf8'),
      ),
      { version: 1, ordinal: 1 },
    );
    const trace = await readFile(join(output, 'capture-1/trace.zip'));
    assert.equal(trace.subarray(0, 2).toString(), 'PK');
    for (const name of ['storage.json', 'trace.zip', 'complete.json'])
      assert.equal(
        (await lstat(join(output, 'capture-1', name))).mode & 0o777,
        0o600,
      );
    assert.equal((await lstat(join(output, 'capture-1'))).mode & 0o777, 0o700);
    const filtered = await f.privacy.process({
      content: [{ type: 'text', text: f.initial + ' ' + f.transient }],
    });
    assert.equal(JSON.stringify(filtered).includes(f.initial), false);
    assert.equal(JSON.stringify(filtered).includes(f.transient), false);
    assert.equal(await b.page.__pi_private_recording_capture(2), undefined);
    await assert.rejects(
      b.page.__pi_private_recording_capture(2),
      /Private recording capture unavailable/,
    );
    await assert.rejects(
      b.page.__pi_private_recording_capture(3),
      /Private recording capture unavailable/,
    );
    await assert.rejects(lstat(join(output, 'capture-3')), { code: 'ENOENT' });
  },
);

test(
  'native capture refuses unsafe private directories, expired auth and frame history without a completion marker',
  { timeout: 30000 },
  async (t) => {
    assert.equal(typeof native.installPrivateRecordingCapture, 'function');
    for (const mode of [
      'workspace',
      'public-mode',
      'symlink',
      'expired',
      'frame',
    ]) {
      const f = await fixture(t),
        b = await browserFixture(t, f);
      let directory = f.privacy.directory;
      if (mode === 'workspace') directory = f.workspace;
      if (mode === 'public-mode') await chmod(directory, 0o755);
      if (mode === 'symlink') {
        const alias = join(f.authority, 'alias');
        await symlink(directory, alias, 'dir');
        directory = alias;
      }
      if (['workspace', 'public-mode', 'symlink'].includes(mode)) {
        await assert.rejects(
          native.installPrivateRecordingCapture(
            b.page,
            f.environment,
            f.workspace,
            directory,
          ),
          /Private recording capture unavailable/,
        );
        assert.equal(b.page.url(), 'about:blank');
        assert.equal('__pi_private_recording_capture' in b.page, false);
        continue;
      }
      const capture = await native.installPrivateRecordingCapture(
        b.page,
        f.environment,
        f.workspace,
        directory,
      );
      await b.page.goto(origin + '/');
      if (mode === 'expired')
        await writeFile(
          f.statePath,
          JSON.stringify({
            ...f.state,
            pi_ui_private: {
              ...f.state.pi_ui_private,
              expiresAt: '2000-01-01T00:00:00.000Z',
            },
          }),
        );
      else
        await b.page.evaluate(() => {
          const frame = document.createElement('iframe');
          document.body.append(frame);
          frame.remove();
        });
      await assert.rejects(
        b.page.__pi_private_recording_capture(1),
        /Private recording capture unavailable/,
      );
      await assert.rejects(
        lstat(join(directory, 'output/recording/capture-1/complete.json')),
        { code: 'ENOENT' },
      );
      await capture.dispose();
    }
  },
);

test(
  'native capture bounds ordinals and rejects overlapping capture and post-disposal calls',
  { timeout: 30000 },
  async (t) => {
    assert.equal(typeof native.installPrivateRecordingCapture, 'function');
    for (const mode of ['zero', 'path', 'over-budget', 'overlap', 'dispose']) {
      const f = await fixture(t),
        b = await browserFixture(t, f);
      const capture = await native.installPrivateRecordingCapture(
        b.page,
        f.environment,
        f.workspace,
        f.privacy.directory,
      );
      await b.page.goto(origin + '/');
      if (mode === 'overlap') {
        const result = await Promise.allSettled([
          b.page.__pi_private_recording_capture(1),
          b.page.__pi_private_recording_capture(2),
        ]);
        assert.deepEqual(
          result.map((r) => r.status),
          ['rejected', 'rejected'],
        );
      } else {
        if (mode === 'dispose') await capture.dispose();
        const ordinal =
          mode === 'zero'
            ? 0
            : mode === 'path'
              ? '../../public'
              : mode === 'over-budget'
                ? 9
                : 1;
        await assert.rejects(
          b.page.__pi_private_recording_capture(ordinal),
          /Private recording capture unavailable/,
        );
      }
      await assert.rejects(
        b.page.__pi_private_recording_capture(1),
        /Private recording capture unavailable/,
      );
      await capture.dispose();
    }
  },
);

test(
  'recording fixture installs the observer before inherited uiData navigation using native Playwright CLI',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const fixtures = pathToFileURL(
      join(repo, 'packages/ui-testing/dist/recording-fixtures.js'),
    ).href;
    await mkdir(join(f.workspace, 'tests'));
    const seed = `import {test,expect} from ${JSON.stringify(fixtures)};
test.use(${JSON.stringify({ uiEnvironment: f.environment, uiOwner: { task_id: 'capture', kind: 'recording', id: 'fixture' }, uiProjectRoot: f.workspace })});
test('managed seed',async ({page})=>{
 await expect(page.locator('#echo')).toHaveText(${JSON.stringify(f.transient)});
 await page.__pi_private_recording_capture(1);
});`;
    // route belongs to context fixture, so it is active before the inherited auto uiData navigation.
    const custom = `import {test as base,expect} from ${JSON.stringify(fixtures)};
const test=base.extend({context:async({context},use)=>{await context.route(${JSON.stringify(origin + '/**')},r=>r.fulfill({contentType:'text/html',body:${JSON.stringify(f.body)}}));await use(context);}});
`;
    await writeFile(
      join(f.workspace, 'tests/seed.spec.ts'),
      custom + seed.replace(/import \{test,expect\}[^;]+;/, ''),
    );
    await writeFile(
      join(f.workspace, 'playwright.config.mjs'),
      "export default {testDir:'./tests',workers:1,retries:0,use:{trace:'off'},reporter:[['json',{outputFile:'report.json'}]]};",
    );
    await exec(
      process.execPath,
      [
        join(repo, 'node_modules/playwright/cli.js'),
        'test',
        '--config=playwright.config.mjs',
      ],
      {
        cwd: f.workspace,
        env: {
          ...process.env,
          PI_UI_PRIVATE_EVIDENCE_DIR: f.privacy.directory,
        },
        timeout: 25000,
      },
    );
    const report = JSON.parse(
      await readFile(join(f.workspace, 'report.json'), 'utf8'),
    );
    assert.equal(report.stats.expected, 1);
    assert.equal(report.stats.unexpected, 0);
    const observed = native.readPrivateStorageEvents(
      join(f.privacy.directory, 'output/recording/storage-events.ndjson'),
      origin,
    );
    assert.ok(JSON.stringify(observed.stateForFilter).includes(f.transient));
  },
);

test(
  'eight captures are allowed, ninth is blocked; native trace failure never gets a completion marker',
  { timeout: 30000 },
  async (t) => {
    assert.equal(typeof native.installPrivateRecordingCapture, 'function');
    for (const mode of ['budget', 'trace-failure']) {
      const f = await fixture(t),
        b = await browserFixture(t, f);
      const capture = await native.installPrivateRecordingCapture(
        b.page,
        f.environment,
        f.workspace,
        f.privacy.directory,
      );
      await b.page.goto(origin + '/');
      const output = join(f.privacy.directory, 'output/recording');
      if (mode === 'budget') {
        for (let i = 1; i <= 8; i++) {
          assert.equal(
            await b.page.__pi_private_recording_capture(i),
            undefined,
          );
          assert.deepEqual(
            JSON.parse(
              await readFile(
                join(output, 'capture-' + i, 'complete.json'),
                'utf8',
              ),
            ),
            { version: 1, ordinal: i },
          );
        }
        await assert.rejects(
          b.page.__pi_private_recording_capture(9),
          /Private recording capture unavailable/,
        );
        await assert.rejects(lstat(join(output, 'capture-9')), {
          code: 'ENOENT',
        });
      } else {
        await b.context.tracing.stop();
        await assert.rejects(
          b.page.__pi_private_recording_capture(1),
          /Private recording capture unavailable/,
        );
        await assert.rejects(lstat(join(output, 'capture-1/complete.json')), {
          code: 'ENOENT',
        });
        await assert.rejects(
          b.page.__pi_private_recording_capture(2),
          /Private recording capture unavailable/,
        );
      }
      await capture.dispose();
    }
  },
);

test(
  'host private capture root may contain the isolated mirror but captured files stay outside that mirror',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const mirror = join(f.privacy.directory, 'mirror');
    await mkdir(mirror, { mode: 0o700 });
    await writeFile(
      f.statePath,
      JSON.stringify({
        ...f.state,
        pi_ui_private: { ...f.state.pi_ui_private, workspace: mirror },
      }),
    );
    const b = await browserFixture(t, f);
    const capture = await native.installPrivateRecordingCapture(
      b.page,
      f.environment,
      mirror,
      f.privacy.directory,
    );
    await b.page.goto(origin + '/');
    assert.equal(await b.page.__pi_private_recording_capture(1), undefined);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(f.privacy.directory, 'output/recording/capture-1/complete.json'),
          'utf8',
        ),
      ),
      { version: 1, ordinal: 1 },
    );
    await assert.rejects(lstat(join(mirror, 'output')), { code: 'ENOENT' });
    await capture.dispose();
  },
);
