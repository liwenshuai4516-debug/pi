import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { changeImpact, inspectImport, exportAsset, importAsset, auditEvidence, assetDigest,
  ArtifactStore, DesignReviewService, RuntimeAdmissionService, UiRunService, sha256 } from '../../packages/ui-testing/dist/index.js';
import { ready } from '../support/ui-run-fixture.mjs';
import { setupUiFixture, repoRoot, textContent } from '../support/ui-fixture.mjs';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { PluginManager } from '../../dist/main/plugins/manager.js';
import { response } from '../support/ui-design-fixture.mjs';
import { artifact } from '../support/ui-artifacts.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('UI-12: native Git impact includes tracked edits and new files with spaces',async t=>{
  const fixture=await setupUiFixture();t.after(()=>fixture.close());
  const execute=promisify(execFile),git=args=>execute('git',args,{cwd:fixture.project});
  await git(['init','-q']);await writeFile(join(fixture.project,'tracked file.ts'),'before');
  await git(['add','--','tracked file.ts']);
  await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture baseline']);
  await writeFile(join(fixture.project,'tracked file.ts'),'after');await writeFile(join(fixture.project,'new file.spec.ts'),'new');
  const impact=await changeImpact(fixture.project,undefined,'HEAD');
  assert.ok(impact.changed_paths.includes('tracked file.ts'));assert.ok(impact.changed_paths.includes('new file.spec.ts'));
  await assert.rejects(changeImpact(fixture.project,undefined,'--output=foreign'),/Git 基准无效/);
});

test('UI-12: shared changes find all registered dependents; incomplete evidence requires review',async t=>{
  const {f,asset}=await ready(t),shared=await f.store.putFile('qa/ui/cases/helpers/shared.txt','shared-v1');
  const refs=[];
  for(const id of ['shared-a','shared-b']){
    const a=structuredClone(asset);a.id=id;a.data.files.push(shared);a.data.content_sha256=assetDigest(a);refs.push(await f.store.put(a));
  }
  await writeFile(join(f.root,shared.path),'shared-v2');
  const impact=await changeImpact(f.root,[shared.path]);
  for(const ref of refs)assert.ok(impact.assets.some(a=>a.asset_ref.path===ref.path&&a.requires_review&&a.matched.includes(shared.path)));
  assert.equal(impact.precision,'registered-dependencies-only');
  await rm(join(f.root,shared.path));
  const missing=await changeImpact(f.root,['unrelated.txt']);
  for(const ref of refs)assert.ok(missing.assets.find(a=>a.asset_ref.path===ref.path).requires_review);
  const script=asset.data.bindings[0].script_ref.path;
  const imported=await inspectImport(f.root,script);
  assert.equal(imported.tests[0].title,'C1 Name persists');assert.equal(imported.readiness,'unmapped-import');
  await assert.rejects(inspectImport(f.root,'../foreign.spec.ts'),/路径/);
  const privateRef=await f.store.putFile('qa/ui/cases/private/auth.json','{"cookies":[]}');
  const privateAsset=structuredClone(asset);privateAsset.id='private-dependency';privateAsset.data.files.push(privateRef);privateAsset.data.content_sha256=assetDigest(privateAsset);
  await assert.rejects(exportAsset(f.root,await f.store.put(privateAsset),'must-not-export'),/认证|私有/);
  const stateRef=await f.store.putFile('qa/ui/cases/private/session.json','{"cookies":[],"origins":[]}');
  const stateAsset=structuredClone(asset);stateAsset.id='private-payload';stateAsset.data.files.push(stateRef);stateAsset.data.content_sha256=assetDigest(stateAsset);
  await assert.rejects(exportAsset(f.root,await f.store.put(stateAsset),'must-not-export-state'),/认证状态|凭据/);
});

test('UI-12: maintenance is available through the existing Pi package and loaded workflow Skill',async t=>{
  const fixture=await setupUiFixture();t.after(()=>fixture.close());
  const script='tests/imported.spec.ts';await writeFile(join(fixture.project,script),"import {test} from 'playwright/test';test('existing save',async()=>{});");
  await new PluginManager(fixture.agentDir,fixture.project).install(join(repoRoot,'packages/ui-testing'),'package');
  const host=new AgentHost(()=>{},()=>{},fixture.agentDir);t.after(()=>host.dispose());const view=await host.create(fixture.project,true);
  let calls=0;fixture.state.respond=body=>{
    if(calls++===0)return {tool:'ui_asset_maintain',args:{request:{operation:'inspect-import',script_path:script}}};
    const last=body.messages.findLast(m=>m.role==='tool');const output=JSON.parse(textContent(last.content));
    assert.equal(output.tests[0].title,'existing save');assert.equal(output.readiness,'unmapped-import');
    return {text:'Existing test discovered; source-grounded case/assertion mapping and independent review remain required.'};
  };
  await host.send(view.id,'/skill:ui-test-workflow Inspect existing tests only, without executing.',[],[]);
  if(fixture.state.responseError)throw fixture.state.responseError;
  assert.equal(calls,2);assert.equal(fixture.state.browserRequests??0,0);
});

test('UI-12: portable asset moves to a new workspace, gets new approval and executes without old source path',{timeout:90000},async t=>{
  const d=await ready(t),{f,assetRef}=d;
  const bundle=await exportAsset(f.root,assetRef,'portable');
  const exported=JSON.parse(await readFile(join(f.root,bundle.bundle_ref.path),'utf8'));
  assert.ok(exported.files.every(r=>!r.path.includes('auth.json')&&!r.path.includes('ui-review-authority')));
  const target=await setupUiFixture();t.after(()=>target.close());
  await cp(join(f.root,dirname(bundle.bundle_ref.path)),join(target.project,'incoming'),{recursive:true});
  const bundleRef={path:'incoming/bundle.json',sha256:bundle.bundle_ref.sha256};
  const missing=exported.files.find(r=>r.path.endsWith('.spec.ts'));
  await rm(join(target.project,'incoming/files',missing.path));
  const blocked=await importAsset(target.project,bundleRef);assert.equal(blocked.imported,false);assert.ok(blocked.problems.some(p=>p.includes(missing.path)));
  await cp(join(f.root,missing.path),join(target.project,'incoming/files',missing.path));
  const migrated=await importAsset(target.project,bundleRef);assert.equal(migrated.imported,true);assert.equal(migrated.runtime_ready,false);
  assert.deepEqual(migrated.issues,[]);
  const destination=new ArtifactStore(target.project),authority=join(target.agentDir,'private-reviews');
  const oldTask=await f.store.load(f.taskRef);await destination.put(oldTask);
  const unavailable=f.root+'-offline';await rename(f.root,unavailable);t.after(()=>rename(unavailable,f.root));
  const reviewer=new DesignReviewService(target.project,authority);
  const assessed=await reviewer.assess(f.taskRef,assetRef,'destination-review',response);
  assert.equal((await new RuntimeAdmissionService(target.project,authority).diagnose(assetRef,assessed.review_ref,d.specRef,'destination-runtime')).runtime_ready,true);
  await destination.put(artifact('task',{...oldTask.data,intent:'execute',stage:'execute',asset_refs:[assetRef],run_ids:[],output_refs:[]},'migrated-run'));
  const run=await new UiRunService(target.project,authority).start({...d.request,task_id:'migrated-run',review_ref:assessed.review_ref});
  assert.equal(run.run.data.exit_code,0);assert.ok(run.run.data.command.some(s=>s.includes(target.project)));
});

test('UI-12: missing historical evidence is marked unverifiable and referenced evidence is never automatically removed',{timeout:60000},async t=>{
  const {f,service,request}=await ready(t,{targetFault:true});
  const run=await service.start(request),trace=run.run.data.output_refs.find(r=>r.path.endsWith('/trace.zip'));
  const raw=await readFile(join(f.root,run.run_ref.path));await rm(join(f.root,trace.path));
  const audit=await auditEvidence(f.root,1,'retention-check');
  assert.equal(audit.deleted_count,0);assert.ok(audit.evidence.every(e=>e.protected));
  assert.equal(audit.evidence.find(e=>e.ref.path===trace.path).verifiable,false);
  assert.deepEqual(await readFile(join(f.root,run.run_ref.path)),raw);
  assert.ok(audit.audit_ref.sha256===sha256(await readFile(join(f.root,audit.audit_ref.path))));
});
