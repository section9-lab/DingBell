import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { hashPassword } from 'better-auth/crypto';

const root=resolve(import.meta.dirname,'..');
let developmentVariables='';try{developmentVariables=readFileSync(join(root,'.dev.vars'),'utf8');}catch{throw new Error('Create .dev.vars from .dev.vars.example before creating the local demo account.');}
const variables=Object.fromEntries(developmentVariables.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')&&line.includes('=')).map(line=>{const at=line.indexOf('=');return [line.slice(0,at).trim(),line.slice(at+1).trim().replace(/^(["'])(.*)\1$/,'$2')];}));
if(variables.APP_BASE_URL!=='http://127.0.0.1:5173'||!variables.BETTER_AUTH_SECRET||variables.BETTER_AUTH_SECRET.length<32)
  throw new Error('LOCAL_DEMO_REQUIRES_LOOPBACK_IDENTITY_CONFIG');
const config=JSON.parse(readFileSync(join(root,'wrangler.jsonc'),'utf8'));
const localDatabase=config.d1_databases?.find(value=>value.binding==='DB');
if(localDatabase?.database_id!=='dingbell-local-only')throw new Error('LOCAL_DEMO_REFUSES_NONLOCAL_DATABASE');

const credentialPath=join(root,'.dev.vars.demo-account.json');
let credentials;
try {
  const parsed=JSON.parse(readFileSync(credentialPath,'utf8'));
  if(parsed?.email!=='demo@dingbell.invalid'||typeof parsed.password!=='string'||parsed.password.length<20)throw new Error('invalid');
  credentials=parsed;
} catch {
  credentials={email:'demo@dingbell.invalid',password:`DingBell-local-${randomBytes(18).toString('base64url')}!Aa1`};
  writeFileSync(credentialPath,JSON.stringify(credentials,null,2)+'\n',{mode:0o600});
}
chmodSync(credentialPath,0o600);
const passwordHash=await hashPassword(credentials.password),now=Date.now();
const stateDirectory=join(root,'.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const candidates=readdirSync(stateDirectory).filter(name=>name.endsWith('.sqlite')&&name!=='metadata.sqlite').map(name=>join(stateDirectory,name));
const databases=candidates.filter(path=>{let candidate;try{candidate=new DatabaseSync(path,{readOnly:true});const names=candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user','account','organization','member')").all();return names.length===4;}catch{return false;}finally{candidate?.close();}});
if(databases.length!==1)throw new Error('LOCAL_DEMO_DATABASE_NOT_UNIQUE');
const db=new DatabaseSync(databases[0]);
try {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  const userById=db.prepare("SELECT id,email FROM user WHERE id='local-demo-user'").get(),userByEmail=db.prepare('SELECT id,email FROM user WHERE email=?').get(credentials.email);
  const otherCredential=db.prepare("SELECT id FROM account WHERE user_id='local-demo-user' AND provider_id='credential' AND id<>'local-demo-account'").get();
  const companyById=db.prepare("SELECT id,slug FROM organization WHERE id='local-demo-company'").get(),companyBySlug=db.prepare("SELECT id,slug FROM organization WHERE slug='local-demo-company'").get();
  const accountById=db.prepare("SELECT id,user_id,provider_id FROM account WHERE id='local-demo-account'").get(),memberById=db.prepare("SELECT id,organization_id,user_id FROM member WHERE id='local-demo-owner'").get();
  const conflict=(userById&&userById.email!==credentials.email)||(userByEmail&&userByEmail.id!=='local-demo-user')||otherCredential
    ||(companyById&&companyById.slug!=='local-demo-company')||(companyBySlug&&companyBySlug.id!=='local-demo-company')
    ||(accountById&&(accountById.user_id!=='local-demo-user'||accountById.provider_id!=='credential'))
    ||(memberById&&(memberById.organization_id!=='local-demo-company'||memberById.user_id!=='local-demo-user'));
  if(conflict)throw new Error('LOCAL_DEMO_IDENTITY_CONFLICT');
  const changes=[
    db.prepare("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('local-demo-user','本地演示管理员',?,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email_verified=1,updated_at=excluded.updated_at").run(credentials.email,now,now),
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('local-demo-company','DingBell 本地演示','local-demo-company',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name").run(now),
    db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES('local-demo-account','local-demo-user','credential','local-demo-user',?,?,?) ON CONFLICT(id) DO UPDATE SET password=excluded.password,updated_at=excluded.updated_at WHERE account.user_id='local-demo-user' AND account.provider_id='credential'").run(passwordHash,now,now),
    db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('local-demo-owner','local-demo-company','local-demo-user','owner',?) ON CONFLICT(id) DO UPDATE SET role='owner' WHERE member.organization_id='local-demo-company' AND member.user_id='local-demo-user'").run(now),
  ];
  if(changes.some(result=>Number(result.changes)!==1))throw new Error('LOCAL_DEMO_WRITE_UNCONFIRMED');
  db.exec('COMMIT');
} catch(error) {try{db.exec('ROLLBACK');}catch{}throw new Error('LOCAL_DEMO_CREATE_FAILED',{cause:error});}
finally {db.close();}
console.log(`Local-only demo account is ready.\nEmail: ${credentials.email}\nPassword: ${credentials.password}\nCredentials: ${credentialPath}\nRestart npm run dev, then open http://127.0.0.1:5173/login`);
