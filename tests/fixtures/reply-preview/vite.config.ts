import { fileURLToPath,URL } from 'node:url';
import { defineConfig } from 'vite';
import { createApplicationConfig } from '../../../vite.config.ts';
export default defineConfig(({command})=>{
  const config=createApplicationConfig(command,{envDir:fileURLToPath(new URL('.',import.meta.url)),cloudflare:{configPath:process.env.DINGBELL_PREVIEW_CONFIG!,persistState:{path:process.env.DINGBELL_PREVIEW_STATE!},remoteBindings:false,inspectorPort:false},configureWorker(config){
    config.secrets={required:[]};config.vars={TRANSLATION_ENABLED:process.env.DINGBELL_PREVIEW_ENABLED==='false'?'false':'true',NVAPI_KEY:'synthetic-never-real',TEST_GATE:process.env.DINGBELL_PREVIEW_GATE!,TEST_TOKEN:process.env.DINGBELL_PREVIEW_TOKEN!};
    config.d1_databases![0].database_id='preview-local';config.d1_databases![0].database_name='preview-local';
  }});
  config.resolve!.alias={...config.resolve!.alias,
    [fileURLToPath(new URL('../../../src/app.ts',import.meta.url))]:fileURLToPath(new URL('./app.ts',import.meta.url)),
  };
  config.plugins!.unshift({name:'preview-test-transport',enforce:'pre',resolveId(source,importer){
    if(source==='./provider-fetch.ts'&&importer?.endsWith('/src/modules/translations/provider.ts')){
      console.info('PREVIEW_TEST_TRANSPORT_BOUND');
      return fileURLToPath(new URL('./fetch.ts',import.meta.url));
    }
  }});
  return config;
});
