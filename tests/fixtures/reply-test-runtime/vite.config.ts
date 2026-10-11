import { fileURLToPath,URL } from 'node:url';
import { defineConfig } from 'vite';
import { createApplicationConfig } from '../../../vite.config.ts';
export default defineConfig(({command})=>{
  const config=createApplicationConfig(command,{envDir:fileURLToPath(new URL('.',import.meta.url)),cloudflare:{configPath:process.env.DINGBELL_REPLY_TEST_CONFIG!,persistState:{path:process.env.DINGBELL_REPLY_TEST_STATE!},remoteBindings:false,inspectorPort:false},configureWorker(config){
    config.secrets={required:[]};config.vars={REPLY_TEST_ENABLED:process.env.DINGBELL_REPLY_TEST_ENABLED==='false'?'false':'true',NVAPI_KEY:'synthetic-never-real',TEST_GATE:process.env.DINGBELL_REPLY_TEST_GATE!,TEST_TOKEN:process.env.DINGBELL_REPLY_TEST_TOKEN!};
    config.d1_databases![0].database_id='reply-test-local';config.d1_databases![0].database_name='reply-test-local';
  }});
  config.resolve!.alias={...config.resolve!.alias,
    [fileURLToPath(new URL('../../../src/app.ts',import.meta.url))]:fileURLToPath(new URL('./app.ts',import.meta.url)),
  };
  config.plugins!.unshift({name:'reply-test-runtime-transport',enforce:'pre',resolveId(source,importer){
    if(source==='./provider-fetch.ts'&&importer?.endsWith('/src/modules/reply-tests/provider.ts')){
      console.info('REPLY_TEST_TRANSPORT_BOUND');
      return fileURLToPath(new URL('./fetch.ts',import.meta.url));
    }
  }});
  return config;
});
