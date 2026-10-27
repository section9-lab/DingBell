import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { URL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { createApp } from '../../src/application.ts';
import { services } from '../../src/modules/identity/services.ts';

export async function knowledgeFixture(lastMigration?:string) {
  const sqlite=new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  const folder=new URL('../../migrations/',import.meta.url);
  for(const file of readdirSync(folder).filter(file=>file.endsWith('.sql')&&(!lastMigration||file.slice(0,4)<=lastMigration)).sort()) sqlite.exec(readFileSync(new URL(file,folder),'utf8'));
  let beforeStatement:((sql:string)=>void)|undefined;
  let afterStatement:((sql:string)=>void)|undefined;
  function prepare(sql:string,parameters:SQLInputValue[]=[]) {
    const statement=()=>{beforeStatement?.(sql);return sqlite.prepare(sql);};
    const done=<T>(value:T)=>{afterStatement?.(sql);return value;};
    return {bind:(...values:SQLInputValue[])=>prepare(sql,values),
      async all(){return done({success:true,results:statement().all(...parameters),meta:{}});},
      async raw(){const query=statement();query.setReturnArrays(true);return query.all(...parameters);},
      async first(column?:string){const row=statement().get(...parameters);return done(row?column?row[column]:row:null);},
      async run(){const result=statement().run(...parameters);return done({success:true,results:[],meta:{changes:Number(result.changes)}});}};
  }
  const password='synthetic-knowledge-test-password', hash=await hashPassword(password);
  sqlite.exec("INSERT INTO organization(id,name,slug,created_at) VALUES('company','Company','company',1),('other','Other','other',1)");
  for(const [id,company,role] of [['owner','company','owner'],['admin','company','admin'],['staff','company','member'],['other','other','owner']]) {
    sqlite.prepare('INSERT INTO user(id,name,email,email_verified) VALUES(?,?,?,1)').run(id,id,`${id}@example.invalid`);
    sqlite.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES(?,?,'credential',?,?,1)").run(id,id,id,hash);
    sqlite.prepare('INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES(?,?,?,?,1)').run(id,company,id,role);
  }
  for(const [id,company] of [['store-a','company'],['store-b','company'],['store-other','other']])
    sqlite.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,created_at,updated_at) VALUES(?,?,?,?,1,1)").run(id,company,id,id);
  const batch=async(statements:{all:()=>Promise<unknown>}[])=>{sqlite.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.all());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}};
  const env={DB:{prepare,batch} as unknown as D1Database,APP_BASE_URL:'https://knowledge.example.invalid',BETTER_AUTH_SECRET:'synthetic-knowledge-secret-at-least-thirty-two'};
  const app=createApp(),cookies:Record<string,string>={};
  for(const id of ['owner','admin','staff','other']) {
    const response=await services(env)!.auth.api.signInEmail({body:{email:`${id}@example.invalid`,password},asResponse:true});
    assert.equal(response.status,200);cookies[id]=response.headers.getSetCookie().map(cookie=>cookie.split(';',1)[0]).join('; ');
  }
  const request=(suffix='',body?:unknown,actor='owner',company='company',origin=env.APP_BASE_URL)=>app.request(`${env.APP_BASE_URL}/api/companies/${company}/knowledge${suffix}`,{
    method:body===undefined?'GET':'POST',headers:{cookie:cookies[actor]??'',origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),
  },env);
  const upload=(suffix:string,body:FormData,actor='owner',company='company',origin=env.APP_BASE_URL)=>app.request(`${env.APP_BASE_URL}/api/companies/${company}/knowledge${suffix}`,{
    method:'POST',headers:{cookie:cookies[actor]??'',origin},body,
  },env);
  return {sqlite,db:env.DB,env,request,upload,before:(value:typeof beforeStatement)=>{beforeStatement=value;},after:(value:typeof afterStatement)=>{afterStatement=value;},close:()=>sqlite.close()};
}
