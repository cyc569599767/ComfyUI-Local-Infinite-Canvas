import { expect, test } from 'bun:test';
import { createChatPersistence, encodeChatRecoveryCheckpoint, recoverChatCheckpoint } from '../src/lib/agent-chat-lifecycle';
import type { HistoryMessage } from '../src/lib/agent-chat-history';
const msg=(text:string):HistoryMessage=>({id:text,role:'assistant',text});
test('stream coalesces to latest delta and turn end flush saves before queued continuation',()=>{
 const callbacks=new Map<number,()=>void>();let id=0;const saved:Array<[string,HistoryMessage[]]>=[];
 const pending=createChatPersistence<HistoryMessage>({save:(i,m)=>saved.push([i,m]),schedule:fn=>{callbacks.set(++id,fn);return id as unknown as ReturnType<typeof setTimeout>},cancel:timer=>{callbacks.delete(Number(timer))}});
 pending.stage('A',[msg('partial')]);pending.stage('A',[msg('complete')]);expect(callbacks.size).toBe(1);pending.flush();expect(saved).toEqual([['A',[msg('complete')]]]);expect(callbacks.size).toBe(0);
 pending.stage('A',[msg('complete'),msg('queued partial')]);pending.stage('B',[msg('other')]);expect(saved[1][0]).toBe('A');pending.flush();expect(saved[2][0]).toBe('B');
});
test('reload checkpoint restores recent history but not newer or deleted conversations',()=>{
 const raw=encodeChatRecoveryCheckpoint('A',10,[msg('complete'),msg('partial')]);expect(recoverChatCheckpoint(raw,[{id:'A',updatedAt:9}])?.messages.map(x=>x.text)).toEqual(['complete','partial']);
 expect(recoverChatCheckpoint(raw,[{id:'A',updatedAt:11}])).toBeNull();expect(recoverChatCheckpoint(raw,[])).toBeNull();expect(recoverChatCheckpoint('invalid',[])).toBeNull();
});
test('recovery omits transient stream/media bytes but preserves reference identity',()=>{
 const raw=encodeChatRecoveryCheckpoint('A',1,[{...msg('safe'),attachments:[{id:'upload',name:'image',url:'data:image/png;base64,PRIVATE'}],canvasReferences:[{nodeId:'image-node',label:'图1',title:'Reference',kind:'image',previewUrl:'blob:private'}],streamId:'stream'}]);
 expect(raw).not.toContain('PRIVATE');expect(raw).not.toContain('blob:private');expect(raw).not.toContain('streamId');expect(recoverChatCheckpoint(raw,[{id:'A',updatedAt:1}])?.messages[0].canvasReferences?.[0].nodeId).toBe('image-node');
});
test('oversized recovery checkpoint is skipped rather than monopolizing localStorage',()=>{expect(encodeChatRecoveryCheckpoint('A',1,[msg('x'.repeat(1024*1024))])).toBe('');});
