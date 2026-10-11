import { fileURLToPath,URL } from 'node:url';
import { defineConfig } from 'vite';
import { createApplicationConfig } from '../../../vite.config.ts';
export default defineConfig(({command})=>{
  const config=createApplicationConfig(command,{envDir:fileURLToPath(new URL('.',import.meta.url)),cloudflare:{configPath:process.env.DINGBELL_SUPPORT_CONFIG!,persistState:{path:process.env.DINGBELL_SUPPORT_STATE!},remoteBindings:false,inspectorPort:false},configureWorker(config){
    config.secrets={required:[]};config.vars={AI_RECEPTION_ENABLED:process.env.DINGBELL_SUPPORT_ENABLED==='false'?'false':'true',
      OUTBOUND_ENABLED:process.env.DINGBELL_SUPPORT_OUTBOUND??'false',AI_OUTBOUND_ENABLED:process.env.DINGBELL_SUPPORT_AI_OUTBOUND??'false',
      STORE_CREDENTIAL_ACTIVE_KEY:'synthetic',STORE_CREDENTIAL_KEYS:JSON.stringify({synthetic:btoa('s'.repeat(32))}),
      NVAPI_KEY:'synthetic-never-real',TEST_GATE:process.env.DINGBELL_SUPPORT_GATE!,TEST_TOKEN:process.env.DINGBELL_SUPPORT_TOKEN!};
    config.d1_databases![0].database_id='support-local';config.d1_databases![0].database_name='support-local';
  }});
  config.resolve!.alias={...config.resolve!.alias,
    [fileURLToPath(new URL('../../../src/app.ts',import.meta.url))]:fileURLToPath(new URL('./app.ts',import.meta.url)),
  };
  config.plugins!.unshift({name:'support-runtime-transport',enforce:'pre',resolveId(source,importer){
    if(source==='../ozon/send.ts'&&importer?.endsWith('/src/modules/conversations/controller.ts')){
      console.info('SUPPORT_OZON_TRANSPORT_BOUND');return fileURLToPath(new URL('./ozon.ts',import.meta.url));
    }
    if(source==='../modules/ai-runs/knowledge.ts'&&importer?.endsWith('/src/agents/support.ts'))return fileURLToPath(new URL('./knowledge.ts',import.meta.url));
    if(source==='./provider-fetch.ts'&&importer?.endsWith('/src/modules/ai-runs/provider.ts')){
      console.info('SUPPORT_TRANSPORT_BOUND');
      return fileURLToPath(new URL('./fetch.ts',import.meta.url));
    }
  }});
  return config;
});
