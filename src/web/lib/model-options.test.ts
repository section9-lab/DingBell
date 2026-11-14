import assert from 'node:assert/strict';
import {test} from 'node:test';
import {providerModelOptions} from './model-options.ts';

test('provider model labels do not repeat a formatted model id',()=>{
  assert.deepEqual(providerModelOptions([
    {id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash'},
    {id:'glm-5.3-flash',name:'GLM-5.3-Flash'},
  ]),[
    {id:'deepseek-v4.1-flash',label:'DeepSeek V4.1 Flash'},
    {id:'glm-5.3-flash',label:'GLM-5.3-Flash'},
  ]);
});

test('provider model labels keep the id only when names collide',()=>{
  assert.deepEqual(providerModelOptions([
    {id:'model-a',name:'Same Name'},
    {id:'model-b',name:'Same Name'},
    {id:'model-c',name:'Unique'},
  ]),[
    {id:'model-a',label:'Same Name (model-a)'},
    {id:'model-b',label:'Same Name (model-b)'},
    {id:'model-c',label:'Unique'},
  ]);
});
