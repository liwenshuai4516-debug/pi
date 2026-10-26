import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { ArtifactStore, UiDataScope, validateEnvironment, authState } from '../../packages/ui-testing/dist/index.js';
import { setupUiFixture, repoRoot } from '../support/ui-fixture.mjs';
import { until } from '../support/fixture.mjs';
const exec = promisify(execFile);
const config = url => ({ schema_version: '1.0', environment_id: 'test', deployment_version: 'v1', base_url: url,
  role: 'anonymous', identity: { selector: 'h1', text: 'Names' }, initial_state: { selector: 'button', text: 'Save' },
  auth: { kind: 'none' }, isolation: 'context', timeout_ms: 500 });

async function root(t) {
  const path = await mkdtemp(join(tmpdir(), 'ui-environment-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test('UI-04: environment validates auth references without exposing credential values', async t => {
  const env = config('http://127.0.0.1:1234');
  assert.equal(validateEnvironment(env).role, 'anonymous');
  assert.throws(() => validateEnvironment({ ...env, base_url: 'http://user:password@example.com' }), /凭据/);
  assert.throws(() => validateEnvironment({ ...env, base_url: 'http://example.com?token=secret' }), /凭据/);
  const dir = await root(t);
  const auth = { ...env, auth: { kind: 'storage-state-env', reference: 'PI_UI_TEST_STATE' } };
  const old = process.env.PI_UI_TEST_STATE;
  t.after(() => { if (old === undefined) delete process.env.PI_UI_TEST_STATE; else process.env.PI_UI_TEST_STATE = old; });
  delete process.env.PI_UI_TEST_STATE;
  await assert.rejects(authState(auth), /认证引用未配置/);
  const path = join(dir, 'auth.json'); process.env.PI_UI_TEST_STATE = path;
  await writeFile(path, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
  assert.equal(await authState(auth), path);
  await writeFile(path, '{');
  await assert.rejects(authState(auth), /缺失或无效/);
});

test('UI-04: data ownership, preparation failure, cleanup failure and agreed retention persist', async t => {
  const dir = await root(t), store = new ArtifactStore(dir), env = config('http://localhost');
  const scope = new UiDataScope(store, { task_id: 'T1', kind: 'recording', id: 'R1' }, env);
  const owned = new Set(['unrelated']);
  const common = { creation_method: 'fixture', fixture_version: '1', ttl_ms: 60000, cleanup_method: 'owned-key' };
  await scope.prepare({ ...common, create: async key => {owned.add(key);return {id:'server-owned-id'};}, identify: value => [value.id], cleanup: async key => owned.delete(key) });
  await assert.rejects(scope.prepare({ ...common, create: async key => { owned.add(key); throw new Error('partial create'); },
    cleanup: async key => owned.delete(key) }), /partial create/);
  await scope.prepare({ ...common, create: async () => {}, cleanup: async () => { throw new Error('private backend error'); } });
  await scope.prepare({ ...common, create: async () => {}, retain_reason: 'temporary fixture has no deletion API' });
  const records = await scope.cleanup();
  assert.deepEqual([...owned], ['unrelated']);
  assert.deepEqual(records.map(r => r.cleanup_state), ['cleaned', 'cleaned', 'failed', 'retained']);
  assert.equal(records[1].state, 'prepare-failed');
  assert.deepEqual(records[0].object_ids, ['server-owned-id']);
  assert.equal(JSON.stringify(records).includes('private backend error'), false);
  assert.deepEqual(await scope.cleanup(), records);
  await assert.rejects(scope.prepare({ ...common, create: async () => {}, cleanup: async () => {} }), /已清理/);
  const other = new UiDataScope(store, { task_id: 'T1', kind: 'run', id: 'run-2' }, env);
  assert.notEqual(other.namespace, scope.namespace);
  const index = await store.reindex();
  assert.ok(index.incomplete.some(path => path === 'qa/ui/recordings/R1'));
  const persisted = JSON.parse(await readFile(join(dir, `qa/ui/recordings/R1/data/${scope.namespace}/${records[2].data_id}/cleanup-result.json`), 'utf8'));
  assert.equal(persisted.cleanup_state, 'failed');
});

test('UI-04: shared environment resource lock excludes another owner and is released', async t => {
  const dir = await root(t), store = new ArtifactStore(dir);
  const release = await store.acquireResource('environment:test');
  await store.putFile('qa/ui/runs/shared-test/log.json', '{}');
  await assert.rejects(new ArtifactStore(dir).acquireResource('environment:test'), /占用/);
  await release(); await (await store.acquireResource('environment:test'))();
});

async function installFixture(fixture, file, body, timeout = 15000) {
  const fixtureUrl = pathToFileURL(join(repoRoot, 'packages/ui-testing/dist/fixtures.js')).href;
  await writeFile(join(fixture.project, 'tests', file), `import {test,expect} from ${JSON.stringify(fixtureUrl)};
test.use(${JSON.stringify({ uiEnvironment: config(fixture.url), uiOwner: { task_id: 'T1', kind: 'run', id: 'run-1' }, uiProjectRoot: fixture.project })});
${body}`);
  await writeFile(join(fixture.project, 'playwright.config.mjs'), `export default {testDir:'./tests', workers:1, timeout:${timeout}, use:{headless:true}, reporter:[['json',{outputFile:'results.json'}]]};`);
}
function testEntries(report) {
  return report.suites.flatMap(function walk(s) { return [...s.specs.flatMap(spec => spec.tests.flatMap(test => test.results.map(result => ({title:spec.title,...result})))), ...(s.suites ?? []).flatMap(walk)]; });
}
const attachment = (result, name) => JSON.parse(Buffer.from(result.attachments.find(a => a.name === name).body, 'base64').toString());

test('UI-04: real Playwright fixtures isolate runs, block expired identity and retain raw failures', { timeout: 60000 }, async t => {
  const fixture = await setupUiFixture(); t.after(() => fixture.close());
  await installFixture(fixture, 'lifecycle.spec.mjs', `
for (const name of ['first','second','business-failure','cleanup-failure']) {
 test(name, async ({page,uiData}) => {
  await expect(page.getByRole('listitem')).toHaveCount(0);
  await uiData.prepare({creation_method:'ui',fixture_version:'1',ttl_ms:60000,cleanup_method:'isolated-localStorage',
   create:async key => { await page.getByRole('textbox',{name:'Name'}).fill(key); await page.getByRole('button',{name:'Save'}).click(); },
   cleanup:async key => { if(name==='cleanup-failure')throw new Error('secret fixture error');
     await page.evaluate(key => { const names=JSON.parse(localStorage.getItem('names')||'[]'); localStorage.setItem('names',JSON.stringify(names.filter(n=>n!==key))); },key); }
  });
  if(name==='business-failure') await expect(page.getByRole('listitem')).toHaveText('deliberately wrong',{timeout:100});
 });
}
test.describe('invalid initial state',()=> {
 test.use({uiEnvironment:${JSON.stringify({ ...config(fixture.url), initial_state: { selector: 'button', text: 'Ready for a different workflow' } })}});
 test('wrong-state',async()=>{throw new Error('business must not run');});
});
test.describe('site unavailable',()=> {
 test.use({uiEnvironment:${JSON.stringify(config('http://127.0.0.1:1'))}});
 test('unreachable',async()=>{throw new Error('business must not run');});
});
test.describe('invalid identity',()=> {
 test.use({uiEnvironment:${JSON.stringify({ ...config(fixture.url), identity: { selector: 'h1', text: 'Authenticated tester' } })}});
 test('expired-auth',async({page})=>{throw new Error('business must not run');});
});`);
  const result = await exec(process.execPath, [join(repoRoot, 'node_modules/playwright/cli.js'), 'test', 'lifecycle.spec.mjs'], { cwd: fixture.project }).catch(e => e);
  assert.equal(result.code, 1);
  const report = JSON.parse(await readFile(join(fixture.project, 'results.json'), 'utf8'));
  const entries = testEntries(report);
  assert.equal(entries.length, 7);
  const first = entries.find(r => r.title === 'first'), second = entries.find(r => r.title === 'second');
  assert.equal(first.status, 'passed'); assert.equal(second.status, 'passed');
  assert.notEqual(attachment(first,'ui-data-lifecycle').namespace, attachment(second,'ui-data-lifecycle').namespace);
  const failed = entries.find(r => r.title === 'business-failure');
  assert.equal(failed.status, 'failed'); assert.equal(attachment(failed,'ui-data-lifecycle').records[0].cleanup_state, 'cleaned');
  const residual = entries.find(r => r.title === 'cleanup-failure');
  assert.equal(residual.status, 'passed'); assert.equal(attachment(residual,'ui-data-lifecycle').records[0].cleanup_state, 'failed');
  assert.equal(attachment(entries.find(r => r.title === 'wrong-state'),'ui-preflight').check,'initial-state');
  assert.equal(attachment(entries.find(r => r.title === 'unreachable'),'ui-preflight').check,'site');
  const expired = entries.find(r => r.title === 'expired-auth');
  assert.equal(attachment(expired,'ui-preflight').reason, 'identity-mismatch-or-session-expired');
  assert.equal(expired.errors.some(e => e.message?.includes('business must not run')), false);
});

test('UI-04: real runner cancellation attempts owned cleanup', { timeout: 45000 }, async t => {
  const fixture = await setupUiFixture(); t.after(() => fixture.close());
  const ready = join(fixture.project, 'ready.json');
  await installFixture(fixture, 'cancel.spec.mjs', `
import {writeFile} from 'node:fs/promises';
test('cancel',async({page,uiData})=>{
 await uiData.prepare({creation_method:'ui',fixture_version:'1',ttl_ms:60000,cleanup_method:'owned',
  create:async key=>{await page.getByRole('textbox',{name:'Name'}).fill(key);await page.getByRole('button',{name:'Save'}).click();},
  cleanup:async()=>{await page.evaluate(()=>localStorage.removeItem('names'));}});
 await writeFile(${JSON.stringify(ready)},'ready');
 await page.waitForTimeout(60000);
});`, 90000);
  const child = spawn(process.execPath, [join(repoRoot, 'node_modules/playwright/cli.js'), 'test', 'cancel.spec.mjs'], { cwd: fixture.project, stdio: 'pipe' });
  let output=''; child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const exited = new Promise(resolve => child.once('exit', (code,signal) => resolve({code,signal})));
  t.after(() => { if(child.exitCode===null) child.kill('SIGKILL'); });
  await until(async()=>readFile(ready).then(()=>true,()=>false));
  child.kill('SIGINT'); await exited;
  const report = JSON.parse(await readFile(join(fixture.project,'results.json'),'utf8'));
  const result = testEntries(report)[0];
  assert.equal(result.status,'interrupted',output);
  assert.equal(attachment(result,'ui-data-lifecycle').records[0].cleanup_state,'cleaned');
});


test('UI-04: private storage state authenticates, expired state blocks before business actions', { timeout: 45000 }, async t => {
  const fixture = await setupUiFixture(); t.after(() => fixture.close());
  const secret = 'private-session-marker-never-in-ledger';
  const server = createServer((req, res) => {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(req.headers.cookie?.includes(secret) ? '<h1>Names</h1><button>Save</button>' : '<h1>Login required</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const authPath = join(fixture.project, 'private-state.json');
  const validState = {cookies:[{name:'session',value:secret,domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'}],origins:[]};
  await writeFile(authPath, JSON.stringify(validState), { mode: 0o600 });
  await installFixture(fixture, 'auth.spec.mjs', `
    test.use({uiEnvironment:${JSON.stringify({...config(url),auth:{kind:'storage-state-env',reference:'PI_UI_AUTH_FIXTURE'}})}});
    test('authenticated',async({page})=>{await expect(page.locator('h1')).toHaveText('Names');});`);
  const args = [join(repoRoot, 'node_modules/playwright/cli.js'), 'test', 'auth.spec.mjs'];
  const options = { cwd: fixture.project, env: {...process.env, PI_UI_AUTH_FIXTURE: authPath} };
  await exec(process.execPath, args, options);
  let report = JSON.parse(await readFile(join(fixture.project, 'results.json'),'utf8'));
  assert.equal(testEntries(report)[0].status, 'passed');
  assert.equal(JSON.stringify(report).includes(secret),false);
  // 同一认证引用已失效：不复用先前通过结论，重新核验页面身份。
  await writeFile(authPath, JSON.stringify({cookies:[],origins:[]}));
  const failed = await exec(process.execPath,args,options).catch(e=>e);
  assert.equal(failed.code,1);
  report=JSON.parse(await readFile(join(fixture.project,'results.json'),'utf8'));
  assert.equal(attachment(testEntries(report)[0],'ui-preflight').reason,'identity-mismatch-or-session-expired');
});

test('managed private auth binds workspace, origin and expiry before browser startup', async t => {
  const { mkdtemp, mkdir, writeFile, rm, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { authState } = await import('../../packages/ui-testing/dist/environment.js');
  const base = await mkdtemp(join(tmpdir(), 'ui-managed-auth-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'), foreign = join(base, 'other'), statePath = join(base, 'private.json');
  await mkdir(root); await mkdir(foreign);
  const reference = 'PI_UI_DATA_SPACE_UNIT_TEST';
  assert.equal(process.env[reference], undefined);
  process.env[reference] = statePath;
  t.after(() => { delete process.env[reference]; });
  const config = { base_url: 'http://127.0.0.1:18999/app', auth: { kind: 'storage-state-env', reference } };
  const state = { cookies: [], origins: [{ origin: 'http://127.0.0.1:18999', localStorage: [{ name: 'token', value: 'synthetic-managed-token' }] }],
    pi_ui_private: { version: 1, reference, workspace: await realpath(root), origin: 'http://127.0.0.1:18999', baseUrl: 'http://127.0.0.1:18999/app', expiresAt: new Date(Date.now() + 60000).toISOString() } };
  const save = async value => writeFile(statePath, JSON.stringify(value), { mode: 0o600 });
  await save(state);
  assert.equal(await authState(config, root), statePath);
  await assert.rejects(authState(config, foreign), /缺失或无效/);
  await assert.rejects(authState({ ...config, base_url: 'http://127.0.0.1:19000/app' }, root), /缺失或无效/);
  await assert.rejects(authState({ ...config, base_url: 'http://127.0.0.1:18999/application' }, root), /缺失或无效/);
  await save({ ...state, pi_ui_private: { ...state.pi_ui_private, expiresAt: new Date(Date.now() - 1).toISOString() } });
  await assert.rejects(authState(config, root), /缺失或无效/);
  await save({ ...state, pi_ui_private: { ...state.pi_ui_private, version: 2 } });
  await assert.rejects(authState(config, root), /缺失或无效/);
  await save({ cookies: [], origins: [] });
  await assert.rejects(authState(config, root), /缺失或无效/);
});
