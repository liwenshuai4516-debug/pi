import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactStore, assetDigest, DesignReviewService, sha256 } from '../../packages/ui-testing/dist/index.js';
import { artifact, scope, cases } from './ui-artifacts.mjs';
import { setupUiFixture } from './ui-fixture.mjs';

export const validCode=`import {test,expect} from 'playwright/test';
test.use({storageState:{cookies:[],origins:[]}});
test('C1 Name persists',async({page})=>{
 const key='qa-'+crypto.randomUUID();await page.goto('/');
 await page.getByRole('textbox',{name:'Name'}).fill(key);
 await page.getByRole('button',{name:'Save'}).click();await page.reload();
 await test.step('A1 Name persists after reload',async()=>{await expect(page.getByRole('listitem')).toHaveText([key]);});
});`;
export async function setup(t,options) {
  const fixture=await setupUiFixture(options);t.after(()=>fixture.close());
  const root=fixture.project,store=new ArtifactStore(root),authority=join(fixture.agentDir,'private-reviews');
  const requirement='R1: Saved Name persists after reload.\nAcceptance for this controlled fixture: start each case in a fresh non-persistent Playwright browser context with empty localStorage and no imported storageState. Enter the generated Name, click Save, then reload. The Saved names list must contain exactly one list item whose text is the original submitted Name, without normalization. Closing that owned context removes its localStorage; no external data is shared.';
  const ref={path:'requirements.md',sha256:sha256(requirement)};
  await writeFile(join(root,ref.path),requirement);
  const s=scope();s.data.sources[0].ref=ref;s.data.base_url=fixture.url;
  s.data.goal='Only valid generated Name inputs: Save then reload and verify persistence. Validation boundaries and other functions are outside this task.';
  const scopeRef=await store.put(s);
  const inventory=artifact('inventory',{scope_ref:scopeRef,features:[{module_id:'names',feature_id:'save',name:'Names',
    entry:'/',role:'tester',actions:['Save Name','Reload'],scenarios:[{scenario_id:'valid-name',title:'Persistence'}],coverage:'discovered',
    source_refs:[ref],source_locations:[{ref,symbol:'R1',line:1}],discovery:'source',priority:'P0',states:['initial','saved','reloaded'],gaps:[]}],
    unexplored:['Input validation and other unselected functions were not explored; this task covers valid-name persistence only.']});
  const inventoryRef=await store.put(inventory);
  const dataRules=await store.putFile('qa/ui/cases/cases-1/data-rules.json',JSON.stringify({name:'qa-${uuid}',isolation:'browser context',cleanup:'close owned context'}));
  const make=async(revision='v1',code=validCode,change=()=>{})=>{
    const c=cases();c.id=`cases-${revision}`;c.data.scope_ref=scopeRef;c.data.sources=s.data.sources;c.data.data_rules_ref=dataRules;
    c.data.gaps=['Boundary/invalid-input scenarios are outside the selected persistence scope and remain untested.'];
    c.data.cases[0].preconditions=['Fresh non-persistent context, empty localStorage, no imported storageState; only the owned generated Name is saved.'];
    c.data.cases[0].assertions[0].expected={from:'generated input key'};change(c);
    const casesRef=await store.put(c);
    const scriptRef=await store.putFile(`qa/ui/assets/names/revisions/${revision}/name.spec.ts`,code);
    const asset=artifact('asset',{revision,module_ids:['names'],scope_ref:scopeRef,inventory_ref:inventoryRef,cases_ref:casesRef,
      recording_refs:[],files:[scriptRef,dataRules],bindings:[{case_id:'C1',script_ref:scriptRef,test_title:'C1 Name persists',assertion_ids:['A1']}],
      dependencies:[{name:'playwright',version:'1.62.1'}],readiness:'design-only',content_sha256:'0'.repeat(64),gaps:[]},'names');
    asset.data.content_sha256=assetDigest(asset);const assetRef=await store.put(asset);
    return {asset,assetRef,scriptRef,cases:c,casesRef};
  };
  const candidate=await make('v1',options?.testCode??validCode);
  const task=artifact('task',{intent:'record',scope_ref:scopeRef,state:'running',stage:'design-review',completed_stages:['discover-record','case-design'],
    input_sha256:sha256('design names'),asset_refs:[],run_ids:[],output_refs:[],blockers:[]});
  const taskRef=await store.put(task);
  return {fixture,root,store,authority,service:new DesignReviewService(root,authority),make,taskRef,...candidate};
}
export function decision(input,kind='approved',improvement=input.previous?'improved':'first') {
  const script=input.evidence.find(f=>f.ref.path.endsWith('.spec.ts'));
  const source=input.evidence.find(f=>f.ref.path==='requirements.md');
  const asset=input.evidence[0];
  const checks=Array.from({length:10},(_,i)=>{
    const evidence=i===1?source:i===6?asset:script;
    return {rule:`D${i+1}`,verdict:i===6?'not-applicable':'pass',reason:'Protocol fixture cites actual original source bytes; semantic quality is separately calibrated.',
      evidence:[{ref:evidence.ref,quote:evidence.content.slice(0,80)}]};
  });
  const issues=[];
  if(kind!=='approved'){
    checks[1].verdict='fail';issues.push({id:'I1',rule:'D2',case_id:'C1',assertion_id:'A1',reason:'Candidate expectation lacks the required independent source.',
      evidence_refs:[source.ref],fix_condition:'Bind the expected value to R1 and independent generated input.',blocking:true});
  }
  return {decision:kind,checked_rules:checks.map(c=>c.rule),checks,issues,improvement};
}
export const response = input => ({raw:JSON.stringify(decision(input)),provider:'fixture',model:'protocol'});

export async function prepareDiagnostic(t,{targetFault=false,globalSetupSource,testCode}={}) {
  const f=await setup(t,{discardPersistence:targetFault,testCode}),broken=await setupUiFixture({discardPersistence:true});t.after(()=>broken.close());
  const base='qa/ui/assets/names/revisions/v1/probes';
  const setupRef=globalSetupSource?await f.store.putFile(`${base}/global-setup.mjs`,globalSetupSource):undefined;
  const config=await f.store.putFile(`${base}/base.config.mjs`,
    "import {readFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';const environment=JSON.parse(readFileSync(new URL('./positive.json',import.meta.url),'utf8'));"+
    `export default {${setupRef?"globalSetup:fileURLToPath(new URL('./global-setup.mjs',import.meta.url)),":''}timeout:10000,expect:{timeout:400},use:{baseURL:environment.base_url}};`);
  const negativeConfig=await f.store.putFile(`${base}/negative.config.mjs`,
    "import {readFileSync} from 'node:fs';const environment=JSON.parse(readFileSync(new URL('./negative.json',import.meta.url),'utf8'));"+
    'export default {timeout:10000,expect:{timeout:400},use:{baseURL:environment.base_url}};');
  const environment=url=>({schema_version:'1.0',environment_id:'test',deployment_version:'fixture-v1',base_url:url,
    role:'tester',identity:{selector:'h1',text:'Names'},initial_state:{selector:'button',text:'Save'},auth:{kind:'none'},isolation:'context',timeout_ms:500});
  const goodEnv=await f.store.putFile(`${base}/positive.json`,JSON.stringify(environment(f.fixture.url)));
  const badEnv=await f.store.putFile(`${base}/negative.json`,JSON.stringify(environment(broken.url)));
  const positiveResponse=await fetch(f.fixture.url),positiveBody=await positiveResponse.text();
  const positiveSource=await f.store.putFile(`${base}/positive-source.html`,positiveBody);
  const positiveProvenance=await f.store.putFile(`${base}/positive-http-source.json`,JSON.stringify({
    environment_ref:goodEnv,source_ref:positiveSource,request:{method:'GET',url:f.fixture.url},
    response:{status:positiveResponse.status,content_type:positiveResponse.headers.get('content-type'),body_sha256:sha256(positiveBody)},
    acquired_at:new Date().toISOString(),isolation:'independent local controlled application and browser context',
  }));
  const httpResponse=await fetch(broken.url),body=await httpResponse.text();
  const badSource=await f.store.putFile(`${base}/discard-persistence.html`,body);
  const provenance=await f.store.putFile(`${base}/negative-http-source.json`,JSON.stringify({
    environment_ref:badEnv,mutation_ref:badSource,request:{method:'GET',url:broken.url},
    response:{status:httpResponse.status,content_type:httpResponse.headers.get('content-type'),body_sha256:sha256(body)},
    acquired_at:new Date().toISOString(),isolation:'local controlled application copy; browser context data only',
  }));
  const spec={environment_ref:goodEnv,config_ref:config,timeout_ms:15000,probes:[{id:'discard-persistence',environment_ref:badEnv,
    config_ref:negativeConfig,mutation_refs:[badSource,provenance],description:'Save updates the visible list but erases persisted names, so reload loses the submitted Name.',assertion_ids:['A1']}]};
  let controlRef;
  if(targetFault){
    const healthy=await setupUiFixture();t.after(()=>healthy.close());
    controlRef=await f.store.putFile(`${base}/control.json`,JSON.stringify(environment(healthy.url)));
    spec.control_environment_ref=controlRef;
  }
  const specRef=await f.store.putFile(`${base}/plan.json`,JSON.stringify(spec));
  const asset=structuredClone(f.asset);asset.id='names-diagnostic';asset.data.files.push(config,negativeConfig,goodEnv,badEnv,positiveSource,positiveProvenance,badSource,provenance,specRef,...(controlRef?[controlRef]:[]),...(setupRef?[setupRef]:[]));
  asset.data.content_sha256=assetDigest(asset);const assetRef=await f.store.put(asset);
  const reviewed=await f.service.assess(f.taskRef,assetRef,'diagnostic-review',response);
  return {f,base,config,environment,spec,specRef,asset,assetRef,reviewed};
}

