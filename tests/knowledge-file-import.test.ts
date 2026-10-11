import assert from 'node:assert/strict';
import test from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';

const scope={kind:'guide',storeId:null,productRef:null,language:'zh-CN'};
function upload(content:string|Uint8Array='安装前请阅读说明。',name='guide.txt',type='text/plain',options:{scope?:unknown;title?:string;manifestHash?:string}={}) {
  const form=new FormData();form.append('file',new Blob([typeof content==='string'?content:content.slice().buffer],{type}),name);
  form.append('scope',JSON.stringify(options.scope??scope));form.append('title',options.title??(name.endsWith('.csv')?'':'使用说明'));
  if(options.manifestHash)form.append('manifestHash',options.manifestHash);return form;
}
async function preview(f:Awaited<ReturnType<typeof knowledgeFixture>>,content?:string,name?:string,type?:string):Promise<any> {
  const response=await f.upload('/file-preview',upload(content,name,type));assert.equal(response.status,200,await response.clone().text());return response.json();
}
test('file preview parses UTF-8 Markdown and quoted CSV completely without writing knowledge',async t=>{
  const f=await knowledgeFixture();t.after(f.close);
  const md=await preview(f,'\ufeff# 操作\r\n\r\n请先充电。','readme.md','text/markdown');
  assert.equal(md.entries[0].source.format,'markdown');assert.equal(md.entries[0].source.content,'# 操作\n\n请先充电。');assert.equal(md.entries[0].exists,false);
  const csv=await preview(f,'\ufefftitle,content\r\n"退货,政策","先联系商家。\r\n保留包装。"\r\n"双引号","内容含""引号""。"','guide.csv','text/csv');
  assert.equal(csv.entries.length,2);assert.equal(csv.entries[0].title,'退货,政策');assert.equal(csv.entries[0].source.content,'先联系商家。\n保留包装。');
  assert.equal(csv.entries[1].source.content,'内容含"引号"。');assert.match(csv.manifestHash,/^[a-f0-9]{64}$/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_document').get()?.n,0);
});
test('confirmed file imports deduplicate concurrent requests and preserve later edits',async t=>{
  const f=await knowledgeFixture();t.after(f.close);const p=await preview(f);
  const commands=await Promise.all([1,2].map(()=>f.upload('/file-import',upload(undefined,undefined,undefined,{manifestHash:p.manifestHash}))));
  for(const response of commands)assert.equal(response.status,200,await response.clone().text());
  const id=p.entries[0].documentId;let doc:any=await(await f.request(`/${id}`)).json();assert.equal(doc.document.activeRevision,null);assert.equal(doc.draft.revision,1);
  assert.equal((await f.request(`/${id}/draft`,{expectedVersion:doc.document.version,title:'人工修订',source:{format:'text',content:'已核对的新说明。'}})).status,200);
  const again=await f.upload('/file-import',upload(undefined,undefined,undefined,{manifestHash:p.manifestHash}));assert.equal(again.status,200);
  doc=await(await f.request(`/${id}`)).json();assert.equal(doc.draft.title,'人工修订');assert.equal(doc.draft.revision,2);
  assert.equal((await preview(f)).entries[0].exists,true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_document').get()?.n,1);
});
test('file confirmation binds normalized manifest and never replaces a same-name document',async t=>{
  const f=await knowledgeFixture();t.after(f.close);const a=await preview(f);
  assert.equal((await f.upload('/file-import',upload('不同内容',undefined,undefined,{manifestHash:a.manifestHash}))).status,409);
  assert.equal((await f.upload('/file-import',upload())).status,400);
  assert.equal((await f.upload('/file-import',upload(undefined,undefined,undefined,{manifestHash:a.manifestHash}))).status,200);
  const b=await preview(f,'更新后的正文');assert.notEqual(a.entries[0].documentId,b.entries[0].documentId);assert.equal(b.entries[0].exists,false);
  const renamed=await f.upload('/file-preview',upload(undefined,'renamed.txt'));assert.equal((await renamed.json() as any).entries[0].documentId,a.entries[0].documentId);
});
test('file validation rejects malformed CSV, duplicate headers and records, and oversized content without saving any rows',async t=>{
  const f=await knowledgeFixture();t.after(f.close);
  for(const content of ['title,content\na,"broken','title,title\na,b','title,content\na,b,c','title,content\na,b\na,b','title,content\na,b\nb,','title,content',
    'title,content\n'+Array.from({length:21},(_,i)=>`a${i},b`).join('\n'),'title,content\na,valid\nb,'+'中'.repeat(3000)]) {
    const r=await f.upload('/file-preview',upload(content,'input.csv','text/csv'));assert.equal(r.status,400,content.slice(0,70));
    assert.match((await r.json() as any).error.code,/^KNOWLEDGE_FILE_/);
  }
  assert.equal((await f.upload('/file-preview',upload('x'.repeat(65537)))).status,413);
  assert.equal((await f.upload('/file-preview',upload('x'.repeat(100000)))).status,413);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_document').get()?.n,0);
});
test('file validation rejects spoofed MIME, binary data, invalid UTF-8, unsupported PDF and duplicate form fields',async t=>{
  const f=await knowledgeFixture();t.after(f.close);
  for(const form of [upload('plain','a.txt','application/pdf'),upload('%PDF-1.7','a.txt'),upload(new Uint8Array([0xc3,0x28])),upload('abc\u0000def'),
    upload('hello','scan.pdf','application/pdf'),upload('','a.txt'),upload('x','../../a.txt'),upload('x','a.txt','text/plain',{scope:{...scope,kind:'product',storeId:'store-a',productRef:'1001'}})])
    assert.equal((await f.upload('/file-preview',form)).status,400);
  const duplicate=upload();duplicate.append('title','spoofed');assert.equal((await f.upload('/file-preview',duplicate)).status,400);
  assert.equal((await f.upload('/file-preview',upload('合法文字','a.txt',''))).status,200);
});
test('file imports isolate tenants and scopes, reject staff and recheck the role at the write boundary',async t=>{
  const f=await knowledgeFixture();t.after(f.close);const p=await preview(f);
  assert.equal((await f.upload('/file-preview',upload(),'staff')).status,403);
  assert.equal((await f.upload('/file-preview',upload(),'other')).status,404);
  assert.equal((await f.upload('/file-preview',upload(),'',undefined)).status,401);
  assert.equal((await f.upload('/file-preview',upload(),'owner','company','https://foreign.invalid')).status,403);
  assert.equal((await f.upload('/file-preview',upload(undefined,undefined,undefined,{scope:{...scope,storeId:'store-other'}}))).status,404);
  const other=await f.upload('/file-preview',upload(),'other','other');assert.notEqual((await other.json() as any).entries[0].documentId,p.entries[0].documentId);
  f.before(sql=>{if(sql.startsWith('INSERT INTO knowledge_document'))f.sqlite.prepare("UPDATE member SET role='member' WHERE id='admin'").run();});
  assert.equal((await f.upload('/file-import',upload(undefined,undefined,undefined,{manifestHash:p.manifestHash}),'admin')).status,403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_document').get()?.n,0);
});
test('partially acknowledged file batches can be reconciled and resumed without duplicating saved rows',async t=>{
  const f=await knowledgeFixture();t.after(f.close);const csv='title,content\na,first row\nb,second row';const p=await preview(f,csv,'data.csv','text/csv');
  let heads=0;f.before(sql=>{if(sql.startsWith('INSERT INTO knowledge_document')&&++heads===2)throw new Error('synthetic interruption');});
  const r=await f.upload('/file-import',upload(csv,'data.csv','text/csv',{manifestHash:p.manifestHash}));assert.equal(r.status,503);assert.equal((await r.json() as any).error.code,'OPERATION_UNCONFIRMED');
  f.before(undefined);const retry=await preview(f,csv,'data.csv','text/csv');assert.deepEqual(retry.entries.map((e:{exists:boolean})=>e.exists),[true,false]);
  assert.equal((await f.upload('/file-import',upload(csv,'data.csv','text/csv',{manifestHash:retry.manifestHash}))).status,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_document').get()?.n,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_revision').get()?.n,2);
});
test('file identities survive CSV ordering and Unicode normalization while separating store, language and format',async t=>{
  const f=await knowledgeFixture();t.after(f.close);
  const a=await preview(f,'title,content\ncafé,first\nsecond,last','a.csv','text/csv');
  const b=await preview(f,'title,content\nsecond,last\ncafe\u0301,first','a.csv','text/csv');
  assert.deepEqual(a.entries.map((e:any)=>e.documentId),b.entries.map((e:any)=>e.documentId).reverse());
  const text=await preview(f);
  for(const next of [{...scope,language:'en'},{...scope,storeId:'store-a'},{...scope,kind:'policy'}]) {
    const r=await f.upload('/file-preview',upload(undefined,undefined,undefined,{scope:next}));assert.equal(r.status,200);assert.notEqual((await r.json() as any).entries[0].documentId,text.entries[0].documentId);
  }
  assert.notEqual((await preview(f,undefined,'guide.md','text/markdown')).entries[0].documentId,text.entries[0].documentId);
  const csv='title,content\n'+Array.from({length:20},(_,i)=>`Title ${i},Verified content ${i}`).join('\n');
  const max=await preview(f,csv,'max.csv','text/csv');assert.equal(max.entries.length,20);
  assert.equal((await f.upload('/file-import',upload(csv,'max.csv','text/csv',{manifestHash:max.manifestHash}))).status,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_document').get()?.n,20);
});
test('file import audit failures and conflicting pre-existing IDs never masquerade as successful imports',async t=>{
  const f=await knowledgeFixture();t.after(f.close);const p=await preview(f);
  let auditWrites=0;f.before(sql=>{if(sql.startsWith('INSERT INTO knowledge_audit_event')&&++auditWrites===2)throw new Error('synthetic missing audit acknowledgement');});
  assert.equal((await f.upload('/file-import',upload(undefined,undefined,undefined,{manifestHash:p.manifestHash}))).status,503);
  f.before(undefined);assert.equal((await preview(f)).entries[0].exists,true);
  assert.equal((await f.upload('/file-import',upload(undefined,undefined,undefined,{manifestHash:p.manifestHash}))).status,200);
  const other=await preview(f,'Other content');
  assert.equal((await f.request('',{id:other.entries[0].documentId,...scope,title:'Conflicting manual document',source:{format:'text',content:'Different origin'}})).status,200);
  const conflict=await f.upload('/file-preview',upload('Other content'));assert.equal(conflict.status,409);assert.equal((await conflict.json() as any).error.code,'KNOWLEDGE_FILE_CONFLICT');
  const invalid=upload('title,content\na,valid\nb,','broken.csv','text/csv',{manifestHash:p.manifestHash});assert.equal((await f.upload('/file-import',invalid)).status,400);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_document').get()?.n,2);
});
