import { writeFile } from 'node:fs/promises';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
const [agentDir,root,outputPath,prompt]=process.argv.slice(2);
const host=new AgentHost(()=>{},()=>{},agentDir);
let timer,unsubscribe,timedOut=false,toolLimitReached=false,starts=0;
try {
  const view=await host.create(root,true);
  // 活体验收可显式限制一次原生任务；不自建执行循环或自动重发业务请求。
  if(process.env.PI_UI_WORKFLOW_DEADLINE_MS){
    timer=setTimeout(()=>{timedOut=true;void host.stop(view.id);},Number(process.env.PI_UI_WORKFLOW_DEADLINE_MS));
    unsubscribe=host.entries.get(view.id).agent.subscribe(event=>{
      if(event.type==='tool_execution_start'&&++starts>Number(process.env.PI_UI_WORKFLOW_MAX_TOOLS??100)){
        toolLimitReached=true;void host.stop(view.id);
      }
    });
  }
  await host.send(view.id,`/skill:ui-test-workflow ${prompt}`,[],[]);
  const messages=host.entries.get(view.id).agent.state.messages;
  const calls=messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(c=>c.type==='toolCall').map(c=>c.name));
  const results=messages.filter(m=>m.role==='toolResult').map(m=>({tool:m.toolName,isError:m.isError,
    text:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')}));
  const final=messages.findLast(m=>m.role==='assistant');
  const errorText=final?.errorMessage??'';
  await writeFile(outputPath,JSON.stringify({pid:process.pid,session_id:view.id,skills:view.skills.map(s=>s.name),calls,results,
    tool_calls:messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(c=>c.type==='toolCall')),
    final:final?.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'),stop_reason:final?.stopReason,
    error_status:errorText.match(/\b[45]\d\d\b/)?.[0]??null,quota_or_balance:/balance|quota|insufficient|credit|余额|额度/i.test(errorText),
    timed_out:timedOut,tool_limit_reached:toolLimitReached}));
  if(timedOut||toolLimitReached||final?.stopReason==='error')throw new Error('Workflow model task did not finish normally; original output retained');
}finally{clearTimeout(timer);unsubscribe?.();await host.dispose();}
