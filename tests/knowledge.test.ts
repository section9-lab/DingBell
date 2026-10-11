import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture as fixture } from './fixtures/knowledge.ts';



const source = (content='宽度：26 cm。颜色：白色。') => ({format:'text',content});
const input = (extra={}) => ({id:crypto.randomUUID(),title:'桌面收纳盒',kind:'guide',storeId:'store-a',productRef:'sku-a',language:'ru',source:source(),...extra});
const create = async(f:Awaited<ReturnType<typeof fixture>>,value=input()) => {const r=await f.request('',value);assert.equal(r.status,200,await r.clone().text());return await r.json() as any;};

test('knowledge administration enforces fresh company roles, owned stores, CSRF and strict input',async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal((await f.request()).status,200);
  assert.equal((await f.request('',undefined,'unknown')).status,401);
  assert.equal((await f.request('',undefined,'other')).status,404);
  assert.equal((await f.request('',undefined,'staff')).status,403);
  assert.equal((await f.request('',input(),'owner','company','https://evil.invalid')).status,403);
  assert.equal((await f.request('',input({storeId:'store-other'}))).status,400);
  assert.equal((await f.request('',input({storeId:null,productRef:'sku-a'}))).status,400);
  assert.equal((await f.request('',input({source:{format:'pdf',content:'%PDF-1.6'}}))).status,400);
  assert.equal((await f.request('',input({source:source('hello\u0000binary')}))).status,400);
  assert.equal((await f.request('',input({source:source('中'.repeat(2800))}))).status,400);
  assert.equal((await f.request('',input({source:{format:'text',content:'OK',vector:[1]}}))).status,400);
  const result=await create(f);const id=result.document.id;
  assert.equal(result.companyId,'company');assert.equal(result.document.activeRevision,null);
  assert.equal((await f.request(`/${id}`,undefined,'other','other')).status,404);
  assert.equal((await f.request(`/${id}`)).headers.get('cache-control'),'no-store');
});

test('knowledge content is normalized, versioned and immutable; repeated requests do not create revisions',async t=>{
  const f=await fixture();t.after(f.close);
  const value=input({source:source('e\u0301\r\n规格：26 cm。')});let result=await create(f,value);const id=result.document.id;
  assert.equal(result.document.version,1);assert.equal(result.draft.revision,1);assert.equal(result.draft.status,'draft');
  assert.match(result.draft.contentHash,/^[a-f0-9]{64}$/);assert.equal(result.draft.source.content,'é\n规格：26 cm。');
  const duplicate=await create(f,value);assert.equal(duplicate.document.version,1);
  assert.equal((await f.request('',{...value,title:'different'})).status,409);
  const body={expectedVersion:1,title:value.title,source:source('é\n规格：26 cm。')};
  let response=await f.request(`/${id}/draft`,body);assert.equal(response.status,200,await response.clone().text());
  result=await response.json();assert.equal(result.document.version,1);assert.equal(result.draft.revision,1);
  response=await f.request(`/${id}/draft`,{...body,source:source('宽度：28 cm。')});assert.equal(response.status,200,await response.clone().text());
  result=await response.json();assert.equal(result.document.version,2);assert.equal(result.draft.revision,2);
  assert.equal(result.document.activeRevision,null);assert.notEqual(result.draft.contentHash,duplicate.draft.contentHash);
  assert.equal((await f.request(`/${id}/draft`,body)).status,409);
  assert.equal((await f.request(`/${id}/publish`,{expectedVersion:2})).status,409);
  const history=await f.request(`/${id}/versions?before=3`);assert.equal(history.status,200);
  assert.deepEqual((await history.json() as any).revisions.map((v:any)=>v.revision),[2,1]);
  assert.throws(()=>f.sqlite.prepare("UPDATE knowledge_revision SET source_json='{}' WHERE organization_id='company' AND document_id=?").run(id));
  assert.throws(()=>f.sqlite.prepare("DELETE FROM knowledge_revision WHERE organization_id='company' AND document_id=?").run(id));
  const replacement=f.sqlite.prepare("SELECT * FROM knowledge_revision WHERE organization_id='company' AND document_id=? AND revision=1").get(id)!;
  const columns=Object.keys(replacement);assert.throws(()=>f.sqlite.prepare(`INSERT OR REPLACE INTO knowledge_revision (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(replacement)));
});

test('product knowledge retains variant identity and published bodies remain server owned',async t=>{
  const f=await fixture();t.after(f.close);
  const result=await create(f,input({kind:'product',source:{format:'product',facts:[{label:'型号',value:'DB-260 白色款'},{label:'宽度',value:'26 cm'}]}}));
  assert.equal(result.document.productRef,'sku-a');assert.equal(result.draft.source.facts[0].value,'DB-260 白色款');
  assert.equal((await f.request('',input({kind:'product',productRef:null}))).status,400);
  assert.equal((await f.request(`/${result.document.id}/draft`,{expectedVersion:1,title:'Trying scope change',source:source(),storeId:'store-b'})).status,400);
  assert.equal((await f.request('?after=x&after=y')).status,400);
  assert.equal((await f.request('?namespace=other')).status,400);
  f.before(sql=>{if(sql.startsWith('UPDATE knowledge_document')){f.before(undefined);f.sqlite.exec("UPDATE member SET role='member' WHERE id='admin'");}});
  const r=await f.request(`/${result.document.id}/draft`,{expectedVersion:1,title:'lost permission',source:{format:'product',facts:[{label:'宽度',value:'30 cm'}]}},'admin');
  assert.ok([403,404].includes(r.status),await r.clone().text());
  assert.equal(f.sqlite.prepare('SELECT version FROM knowledge_document WHERE id=?').get(result.document.id)?.version,1);
});

// This fixture supplies separate draft and publication proofs; it does not simulate retrieval testing or promotion.
function verifiedIndex(f:Awaited<ReturnType<typeof fixture>>,id:string,revision:number) {
  f.sqlite.prepare("UPDATE knowledge_revision SET status='ready',index_profile='synthetic-verified-profile',mutation_id='synthetic-query-visible',tested_at=1,published_profile='synthetic-verified-profile',published_mutation_id='synthetic-published-visible',published_at=2 WHERE organization_id='company' AND document_id=? AND revision=?").run(id,revision);
}
const citationFor=(f:Awaited<ReturnType<typeof fixture>>,id:string,revision:number)=>{
  const row=f.sqlite.prepare("SELECT id,body_hash FROM knowledge_chunk WHERE organization_id='company' AND document_id=? AND revision=? ORDER BY ordinal LIMIT 1").get(id,revision)!;
  return {documentId:id,revision,chunkId:row.id,bodyHash:row.body_hash};
};
const citationRequest=(citations:unknown[],extra={})=>({storeId:'store-a',productRef:'sku-a',language:'ru',citations,...extra});

test('publishing switches one immutable revision; withdrawal and restoration preserve historical sources',async t=>{
  const f=await fixture();t.after(f.close);
  let result=await create(f);const id=result.document.id;
  assert.equal((await f.request(`/${id}/publish`,{expectedVersion:1})).status,409);
  verifiedIndex(f,id,1);
  let r=await f.request(`/${id}/publish`,{expectedVersion:1});assert.equal(r.status,200,await r.clone().text());result=await r.json();
  assert.equal(result.document.activeRevision,1);assert.equal(result.document.version,2);
  r=await f.request(`/${id}/draft`,{expectedVersion:2,title:'V2',source:source('第二版，尚未通过检索验证')});assert.equal(r.status,200);
  result=await r.json();assert.equal(result.document.activeRevision,1);assert.equal(result.active.source.content,source().content);
  assert.equal((await f.request(`/${id}/publish`,{expectedVersion:3})).status,409);
  r=await f.request(`/${id}/withdraw`,{expectedVersion:3});assert.equal(r.status,200,await r.clone().text());result=await r.json();
  assert.equal(result.document.activeRevision,null);assert.equal(result.document.version,4);
  verifiedIndex(f,id,2);assert.equal((await f.request(`/${id}/publish`,{expectedVersion:3})).status,409);
  r=await f.request(`/${id}/restore`,{expectedVersion:4,revision:1});assert.equal(r.status,200,await r.clone().text());result=await r.json();
  assert.equal(result.document.draftRevision,3);assert.equal(result.document.activeRevision,null);
  assert.equal(result.draft.rollbackOf,1);assert.equal(result.draft.source.content,source().content);assert.equal(result.draft.status,'draft');
  assert.equal(result.draft.testedAt,null);assert.equal((await f.request(`/${id}/publish`,{expectedVersion:5})).status,409);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM knowledge_audit_event WHERE action='restore' AND outcome='succeeded'").get()?.n,1);
});

test('citation resolution enforces company, store, product, language, publication and exact chunk hashes',async t=>{
  const f=await fixture();t.after(f.close);
  const result=await create(f);const id=result.document.id, citation=citationFor(f,id,1);
  assert.equal((await f.request('/citations',citationRequest([citation]))).status,409);
  verifiedIndex(f,id,1);assert.equal((await f.request(`/${id}/publish`,{expectedVersion:1})).status,200);
  let r=await f.request('/citations',citationRequest([citation]));assert.equal(r.status,200,await r.clone().text());
  const body=await r.json() as any;assert.equal(body.citations[0].body,'桌面收纳盒\n商品 / Product: sku-a\n\n'+source().content);
  for(const extra of [{storeId:'store-b'},{productRef:'sku-b'},{productRef:null},{language:'zh-CN'}])
    assert.equal((await f.request('/citations',citationRequest([citation],extra))).status,409);
  assert.equal((await f.request('/citations',citationRequest([citation]),'other','other')).status,404);
  assert.equal((await f.request('/citations',citationRequest([citation]),'staff')).status,404);
  f.sqlite.exec("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES('company','store-a','staff',1)");
  assert.equal((await f.request('/citations',citationRequest([citation]),'staff')).status,200);
  for(const bad of [{...citation,bodyHash:'a'.repeat(64)},{...citation,revision:2},{...citation,chunkId:'b'.repeat(64)}])
    assert.equal((await f.request('/citations',citationRequest([bad]))).status,409);
  assert.equal((await f.request('/citations',citationRequest([citation,citation]))).status,400);
  assert.equal((await f.request('/citations',citationRequest([{...citation,body:'fabricated'}]))).status,400);
  assert.equal((await f.request(`/${id}/withdraw`,{expectedVersion:2})).status,200);
  assert.equal((await f.request('/citations',citationRequest([citation]))).status,409);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM knowledge_chunk WHERE document_id=?').get(id)?.n,1);
});

test('source creation is atomic and preserves Unicode, chunk bounds, tenant-specific identifiers and pagination',async t=>{
  const f=await fixture();t.after(f.close);
  const text=('第一段 👩‍💻 Русский абзац.\n'.repeat(100));const result=await create(f,input({source:source(text)}));const id=result.document.id;
  const chunks=f.sqlite.prepare('SELECT * FROM knowledge_chunk WHERE document_id=? ORDER BY ordinal').all(id);
  assert.ok(chunks.length>1);assert.equal(new Set(chunks.map(c=>c.id)).size,chunks.length);
  for(const chunk of chunks){assert.ok(Buffer.byteLength(String(chunk.body))<=2400);assert.equal(String(chunk.body).isWellFormed(),true);}
  const other=await create(f,input({source:source(text)}));assert.notEqual(citationFor(f,id,1).chunkId,citationFor(f,other.document.id,1).chunkId);
  f.before(sql=>{if(sql.startsWith('INSERT INTO knowledge_chunk')){f.before(undefined);throw new Error('synthetic insert failure');}});
  const r=await f.request(`/${id}/draft`,{expectedVersion:1,title:'failed draft',source:source('do not commit')});assert.equal(r.status,503);
  assert.equal(f.sqlite.prepare('SELECT version FROM knowledge_document WHERE id=?').get(id)?.version,1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM knowledge_revision WHERE document_id=?').get(id)?.n,1);
  for(let i=0;i<19;i++)await create(f,input({title:`Doc ${i}`}));
  const first=await (await f.request()).json() as any;assert.equal(first.documents.length,20);assert.ok(first.nextAfter);
  const second=await (await f.request(`?after=${first.nextAfter}`)).json() as any;assert.equal(second.documents.length,1);assert.equal(second.nextAfter,null);
});

test('identical document IDs in different companies do not share citations and late revocation fails closed',async t=>{
  const f=await fixture();t.after(f.close);
  const a=await create(f),id=a.document.id;verifiedIndex(f,id,1);
  assert.equal((await f.request(`/${id}/publish`,{expectedVersion:1})).status,200);
  const other=await f.request('',input({id,storeId:'store-other'}),'other','other');assert.equal(other.status,200);
  const own=citationFor(f,id,1);
  assert.equal((await f.request('/citations',citationRequest([own],{storeId:'store-other'}),'other','other')).status,409);
  let reads=0;
  f.before(sql=>{if(sql.startsWith('SELECT chunk.document_id')&&++reads===2){f.before(undefined);f.sqlite.prepare("UPDATE knowledge_document SET active_revision=NULL,version=version+1 WHERE organization_id='company' AND id=?").run(id);}});
  assert.equal((await f.request('/citations',citationRequest([own]))).status,409);
  assert.equal(reads,2);
});

test('company-wide policy citations still require a currently authorized store',async t=>{
  const f=await fixture();t.after(f.close);
  const a=await create(f,input({storeId:null,productRef:null,kind:'policy'}));verifiedIndex(f,a.document.id,1);
  assert.equal((await f.request(`/${a.document.id}/publish`,{expectedVersion:1})).status,200);
  const citation=citationFor(f,a.document.id,1);
  f.sqlite.exec("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES('company','store-a','staff',1)");
  assert.equal((await f.request('/citations',citationRequest([citation],{productRef:null}),'staff')).status,200);
  let reads=0;f.before(sql=>{if(sql.startsWith('SELECT chunk.document_id')&&++reads===2){f.before(undefined);f.sqlite.exec("DELETE FROM store_grant WHERE member_id='staff'");}});
  assert.equal((await f.request('/citations',citationRequest([citation]),'staff')).status,409);
});

test('opaque product references retain distinct Unicode forms instead of merging variants',async t=>{
  const f=await fixture();t.after(f.close);
  const a=await create(f,input({productRef:'e\u0301'}));assert.equal(a.document.productRef,'e\u0301');
  verifiedIndex(f,a.document.id,1);assert.equal((await f.request(`/${a.document.id}/publish`,{expectedVersion:1})).status,200);
  const reference=citationFor(f,a.document.id,1);
  assert.equal((await f.request('/citations',citationRequest([reference],{productRef:'é'}))).status,409);
  assert.equal((await f.request('/citations',citationRequest([reference],{productRef:'e\u0301'}))).status,200);
});
