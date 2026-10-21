import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UiRunService, RuntimeAdmissionService, sha256 } from '../../packages/ui-testing/dist/index.js';
import { prepareDiagnostic } from './ui-design-fixture.mjs';
import { artifact } from './ui-artifacts.mjs';

export async function ready(t,options){
  const d=await prepareDiagnostic(t,options),{f,assetRef,reviewed,specRef}=d;
  const diagnostic=await new RuntimeAdmissionService(f.root,f.authority).diagnose(assetRef,reviewed.review_ref,specRef,'ready-for-formal-run');
  assert.equal(diagnostic.runtime_ready,true,JSON.stringify(diagnostic.rounds));
  const original=await f.store.load(f.taskRef);
  await f.store.put(artifact('task',{...original.data,intent:'execute',stage:'execute',completed_stages:['design-review'],
    input_sha256:sha256('formal-run'),asset_refs:[assetRef],run_ids:[]},'formal-task'));
  const request={task_id:'formal-task',request_id:'first',asset_ref:assetRef,review_ref:reviewed.review_ref,
    environment_ref:d.spec.environment_ref,config_ref:d.config,timeout_ms:15000};
  return {...d,request,service:new UiRunService(f.root,f.authority)};
}
export async function summary(f,result){
  const ref=result.run.data.output_refs.find(r=>r.path.endsWith('/execution-summary.json'));
  return JSON.parse(await readFile(join(f.root,ref.path),'utf8'));
}
