import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationSyncNotice} from './conversation-sync-notice.ts';
test('a retrying sync is never described as stopped',()=>{
 const notice=conversationSyncNotice('verified',{enabled:true,lastError:'invalid_response'});
 assert.equal(notice?.stopped,false);assert.match(notice!.message,/自动重试/);assert.doesNotMatch(notice!.message,/停止/);
 assert.equal(conversationSyncNotice('verified',{enabled:true,lastError:null}),null);
});
test('stopped, paused, disconnected and never-enabled states remain distinct',()=>{
 assert.match(conversationSyncNotice('verified',{enabled:false,lastError:'invalid_response'})!.message,/异常停止/);
 assert.equal(conversationSyncNotice('verified',{enabled:false,lastError:'invalid_response'})!.stopped,true);
 assert.match(conversationSyncNotice('paused',{enabled:true,lastError:null})!.message,/暂停/);
 assert.match(conversationSyncNotice('disconnected',{enabled:true,lastError:'invalid_response'})!.message,/断开/);
 assert.match(conversationSyncNotice('verified',{enabled:false,lastError:null})!.message,/尚未启用/);
});
