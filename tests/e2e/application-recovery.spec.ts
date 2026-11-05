import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {serveNode} from '../../src/platform/node/server.ts';

test('a missing lazy module shows a safe reload action instead of a raw application error',async({page})=>{
 const directory=await mkdtemp(join(tmpdir(),'dingbell-module-recovery-'));
 const runtime=await serveNode({dataDirectory:directory,migrationsDirectory:resolve('migrations'),assetsDirectory:resolve('dist/node/client'),port:0,hostname:'127.0.0.1',variables:{}});
 try{
  const address=runtime.server.address();if(!address||typeof address==='string')throw new Error('Missing test port');const baseURL=`http://127.0.0.1:${address.port}`;
  let writes=0;page.on('request',request=>{if(request.method()==='POST')writes++;});
  await page.route('**/assets/bootstrap-*.js',route=>route.abort('failed'));
  await page.goto(baseURL+'/setup');
  await expect(page.getByRole('heading',{name:'页面资源需要重新加载',exact:true})).toBeVisible();
  await expect(page.getByText('Unexpected Application Error!',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'重新加载页面',exact:true})).toBeVisible();expect(writes).toBe(0);
  await page.unroute('**/assets/bootstrap-*.js');await page.getByRole('button',{name:'重新加载页面',exact:true}).click();
  await expect(page.getByRole('heading',{name:'首次安装 DingBell',exact:true})).toBeVisible();expect(writes).toBe(0);
 }finally{await runtime.close();await rm(directory,{recursive:true,force:true});}
});
