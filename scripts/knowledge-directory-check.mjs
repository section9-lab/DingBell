import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const root=resolve(import.meta.dirname,'..'),directory=mkdtempSync(join(tmpdir(),'dingbell-knowledge-directory-'));
const database=new DatabaseSync(join(directory,'directory.sqlite'));
const measure=(name,run)=>{const start=performance.now(),value=run();return {name,milliseconds:Number((performance.now()-start).toFixed(3)),value};};
try {
  database.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;');
  for(const file of readdirSync(join(root,'migrations')).filter(name=>name.endsWith('.sql')).sort())
    for(const statement of readFileSync(join(root,'migrations',file),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean)) database.exec(statement);
  database.exec("INSERT INTO organization(id,name,slug,created_at) VALUES('directory-org','Directory org','directory-org',1)");
  const document=database.prepare(`INSERT INTO knowledge_document
    (organization_id,id,kind,language,version,draft_revision,active_revision,mutation_id,updated_at)
    VALUES('directory-org',?,'guide',?,1,1,?, ?,1)`);
  const revision=database.prepare(`INSERT INTO knowledge_revision
    (organization_id,document_id,revision,title,source_json,content_hash,status,created_at,created_by)
    VALUES('directory-org',?,1,?,'{"format":"text","content":"synthetic directory fixture"}',?,'draft',1,'synthetic')`);
  const seed=measure('seed-10000-documents',()=>{database.exec('BEGIN');try{for(let index=0;index<10_000;index++){
    const id=`directory-${index.toString().padStart(5,'0')}`,language=index%2?'zh-CN':'ru';
    document.run(id,language,index%3===0?1:null,`mutation-${index}`);revision.run(id,`Synthetic ${index}`,index.toString(16).padStart(64,'0'));
  }database.exec('COMMIT');}catch(error){database.exec('ROLLBACK');throw error;}return 10_000;});
  const page=database.prepare(`SELECT doc.id FROM knowledge_document doc JOIN knowledge_revision rev
    ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.draft_revision
    WHERE doc.organization_id='directory-org' AND doc.id>? AND (? IS NULL OR doc.language=?) ORDER BY doc.id LIMIT 21`);
  const first=measure('first-keyset-page',()=>page.all('',null,null).map(row=>row.id));
  const middle=measure('middle-filtered-keyset-page',()=>page.all('directory-04999','zh-CN','zh-CN').map(row=>row.id));
  const plan=database.prepare(`EXPLAIN QUERY PLAN SELECT doc.id FROM knowledge_document doc JOIN knowledge_revision rev
    ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.draft_revision
    WHERE doc.organization_id='directory-org' AND doc.id>'' ORDER BY doc.id LIMIT 21`).all().map(row=>row.detail);
  const count=database.prepare("SELECT count(*) n FROM knowledge_document WHERE organization_id='directory-org'").get().n;
  const foreignKeyErrors=database.prepare('PRAGMA foreign_key_check').all().length;
  if(count!==10_000||foreignKeyErrors!==0||first.value.length!==21||middle.value.length!==21
    ||new Set(first.value).size!==21||new Set(middle.value).size!==21
    ||middle.value.some(id=>Number(id.slice(-5))%2!==1)
    ||!plan.some(value=>String(value).includes('knowledge_document'))) throw new Error('KNOWLEDGE_DIRECTORY_CONTRACT_FAILED');
  console.log(JSON.stringify({schemaVersion:1,scope:'Synthetic local SQLite observation only; not Vectorize, D1, Workers or semantic quality evidence.',
    node:process.version,dataset:{documents:Number(count)},foreignKeyErrors,plan,measurements:[seed,{...first,value:first.value.length},{...middle,value:middle.value.length}],rssBytes:process.memoryUsage().rss}));
} finally { database.close();rmSync(directory,{recursive:true,force:true}); }
