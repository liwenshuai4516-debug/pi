import { writeFile } from 'node:fs/promises';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
const [agentDir,root,outputPath,prompt]=process.argv.slice(2);
const host=new AgentHost(()=>{},()=>{},agentDir);
try {
  const view=await host.create(root,true);
  await host.send(view.id,`/skill:ui-test-workflow ${prompt}`,[],[]);
  const messages=host.entries.get(view.id).agent.state.messages;
  const calls=messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(c=>c.type==='toolCall').map(c=>c.name));
  const results=messages.filter(m=>m.role==='toolResult').map(m=>({tool:m.toolName,isError:m.isError,
    text:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')}));
  await writeFile(outputPath,JSON.stringify({session_id:view.id,skills:view.skills.map(s=>s.name),calls,results}));
}finally{await host.dispose();}
