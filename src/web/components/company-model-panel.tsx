import { LoadingState } from './query-state';
import { useEffect,useRef,useState } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import type { CompanyModelView,CompanyModelCommand,CompanyModelCatalog,CompanyModelProvider,CompanyModelTestFailure,CompanyModelOAuthSession } from '../../shared/company-model';
import { readCompanyModel,saveCompanyModel,testCompanyModel,listCompanyModels,listCompanyModelProviders,startCompanyModelOAuth,readCompanyModelOAuth } from '../lib/company-model-api';
import { ErrorNotice } from './identity-shared';
import { Card,CardHeader,CardTitle,CardDescription,CardContent,CardFooter } from './ui/card';
import { Field,FieldLabel,FieldDescription } from './ui/field';
import { Input } from './ui/input';
import {NativeSelect,NativeSelectOption} from './ui/native-select';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter } from './ui/dialog';
import { providerModelOptions,type ModelOption } from '../lib/model-options';

const testFailures:Record<CompanyModelTestFailure,string>={
  credentials_unavailable:'无法打开已保存的 API Key，请联系部署管理员检查加密密钥，或更新 API Key。',
  url_rejected:'已保存的 API 地址不在当前部署允许范围内，请核对 Base URL 和域名白名单。',
  unauthorized:'供应商认证失败（HTTP 401）。请检查 API Key 是否正确或已过期。',
  forbidden:'供应商拒绝调用（HTTP 403）。请在供应商平台检查 API Key、账号及该模型的调用权限；能读取模型列表不代表有推理权限。也可能涉及供应商的账号或区域限制。',
  not_found:'供应商未找到推理接口或模型（HTTP 404）。请核对 Base URL、完整 Model ID，以及模型是否仍开放。',
  request_rejected:'供应商拒绝了测试请求。地址或模型可能不支持当前流式工具调用参数，请联系部署管理员核查。',
  rate_limited:'供应商限制了调用频率或额度（HTTP 429）。请检查供应商额度，稍后再手动测试。',
  provider_unavailable:'供应商服务暂时不可用，请稍后再手动测试。',
  redirect_refused:'供应商返回了跳转地址。为保护 API Key，系统未跟随跳转，请核对最终的 HTTPS Base URL。',
  timed_out:'连接测试超过 10 秒。可能是模型排队或响应较慢，不代表 API Key 一定错误。',
  network_error:'测试连接中断或无法连接供应商，请检查服务器网络后再试。',
  invalid_response:'供应商未返回完整、有效的流式响应，请核对 OpenAI Chat Completions 兼容性。',
  output_limit:'测试输出被供应商提前截断，尚未完成工具调用；不代表 API Key 一定错误。',
  tool_call_missing:'供应商返回了响应，但没有返回工具调用。请确认该模型支持工具调用；若为推理模型，请换用其他模型后重试。',
  tool_call_invalid:'供应商返回的工具调用格式不受支持，请核对模型的工具调用兼容性。',
  test_failed:'连接测试未通过，请联系部署管理员核查。',
};
// A fixed display-only sentinel, never a credential or a request-body value.
const savedKeyMask='****************';
const executableApi='openai-completions';
type AuthMode='api_key'|'oauth';
function sameOrigin(baseUrl:string,savedUrl:string|null){try{return savedUrl!==null&&!!baseUrl&&new URL(baseUrl).origin===new URL(savedUrl).origin;}catch{return false;}}
export function CompanyModelPanel({companyId}:{companyId:string}){
  const query=useQuery({queryKey:['company-model',companyId],queryFn:({signal})=>readCompanyModel(companyId,signal),gcTime:0,refetchOnWindowFocus:false});
  // The provider catalog is bundled with the deployment; it never depends on a company key.
  const providers=useQuery({queryKey:['company-model-providers',companyId],queryFn:({signal})=>listCompanyModelProviders(companyId,signal),gcTime:Infinity,staleTime:Infinity,refetchOnWindowFocus:false});
  if(!query.data||query.isError)return <Card><CardHeader><CardTitle>AI 模型</CardTitle></CardHeader><CardContent>{query.isPending?<LoadingState>正在读取模型配置…</LoadingState>:<ErrorNotice error={query.error}/>}<Button variant="outline" disabled={query.isFetching} onClick={()=>void query.refetch()}>读取模型配置</Button></CardContent></Card>;
  return <ModelForm key={`${companyId}:${query.data.version}`} data={query.data} providers={providers.data?.providers??[]} providersLoading={providers.isPending}
    providersError={providers.isError?providers.error:undefined} fetching={query.isFetching} refresh={()=>query.refetch()}/>;
}
function ModelForm({data,providers,providersLoading,providersError,fetching,refresh}:{data:CompanyModelView;providers:CompanyModelProvider[];providersLoading:boolean;providersError?:unknown;fetching:boolean;refresh:()=>Promise<unknown>}){
  const client=useQueryClient();
  const selectable=providers.filter(entry=>entry.supported);
  const [provider,setProvider]=useState(data.provider??'custom');
  const isCustom=provider==='custom';
  const providerEntry=selectable.find(entry=>entry.id===provider);
  const [baseUrl,setBaseUrl]=useState(data.baseUrl??''),[model,setModel]=useState(data.model??''),[apiKey,setApiKey]=useState(''),[replacingKey,setReplacingKey]=useState(false);
  const keyInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(replacingKey)keyInput.current?.focus();},[replacingKey]);

  const [authChoice,setAuthChoice]=useState<AuthMode|null>(null);
  const savedForProvider=data.provider===provider;
  const canOAuth=!isCustom&&provider==='kimi-coding'&&!!providerEntry?.authKinds.includes('oauth');
  const canKey=isCustom||!providerEntry||providerEntry.authKinds.includes('api_key');
  const savedAuthMode:AuthMode=(data.authType??'api_key')==='oauth'?'oauth':'api_key';
  const defaultAuthMode:AuthMode=savedForProvider?savedAuthMode:canOAuth?'oauth':'api_key';
  const authMode:AuthMode=isCustom?'api_key':(authChoice??((canOAuth||canKey)?defaultAuthMode:'api_key'));
  const effectiveAuthMode:AuthMode=isCustom?'api_key':authMode;

  const [busy,setBusy]=useState(false),[testOpen,setTestOpen]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState<unknown>(),[message,setMessage]=useState('');
  const [oauthSession,setOauthSession]=useState<CompanyModelOAuthSession|null>(null),[oauthBusy,setOauthBusy]=useState(false),[oauthError,setOauthError]=useState<unknown>();
  const oauthConnected=effectiveAuthMode==='oauth'&&(oauthSession?.status==='complete'||(savedForProvider&&savedAuthMode==='oauth'&&data.hasKey&&data.credentialExpiresAt!==null));
  const oauthPending=oauthSession?.status==='pending',oauthFailed=oauthSession?.status==='failed'||oauthSession?.status==='expired';
  const oauthNeedsSave=oauthSession?.status==='complete'&&!(savedForProvider&&savedAuthMode==='oauth'&&data.model===model);

  const [catalog,setCatalog]=useState<CompanyModelCatalog|null>(null),[catalogError,setCatalogError]=useState<unknown>(),[listing,setListing]=useState(false);
  const catalogRequest=useRef<AbortController|null>(null);
  useEffect(()=>()=>{catalogRequest.current?.abort();catalogRequest.current=null;},[]);

  const defaultModels=(providerEntry?.models??[]).filter(entry=>entry.api===executableApi);
  const modelOptions:ModelOption[]=isCustom?(catalog?.models??[]).map(id=>({id,label:id})):providerModelOptions(defaultModels);
  const modelUnavailable=!isCustom&&!!model&&!defaultModels.some(entry=>entry.id===model);
  const selectedModel=isCustom?null:defaultModels.find(entry=>entry.id===model);
  const effectiveBaseUrl=isCustom?baseUrl.trim():selectedModel?.baseUrl??defaultModels[0]?.baseUrl??data.baseUrl??'';
  const savedKeyVisible=effectiveAuthMode==='api_key'&&savedForProvider&&savedAuthMode==='api_key'&&data.hasKey&&!replacingKey;
  const savedKeyReusable=savedKeyVisible&&sameOrigin(effectiveBaseUrl,data.baseUrl);
  const hasUsableKey=!!apiKey.trim()||savedKeyReusable;
  const hasUsableCredential=effectiveAuthMode==='oauth'?oauthConnected:hasUsableKey;
  const authModeChanged=!isCustom&&savedForProvider&&effectiveAuthMode!==savedAuthMode;
  const dirty=provider!==(data.provider??'custom')||model!==(data.model??'')||(isCustom&&baseUrl!==(data.baseUrl??''))||!!apiKey||replacingKey||oauthNeedsSave||authModeChanged;
  const disabled=busy||fetching||uncertain||providersLoading||!data.encryptionConfigured;

  function clearCatalog(){catalogRequest.current?.abort();catalogRequest.current=null;setListing(false);setCatalog(null);setCatalogError(undefined);}
  useEffect(()=>{
    if(!isCustom){clearCatalog();return;}
    if(disabled||!baseUrl.trim()||!hasUsableKey){clearCatalog();return;}
    const controller=new AbortController();
    const timer=setTimeout(()=>{void (async()=>{
      catalogRequest.current=controller;setListing(true);setCatalogError(undefined);
      try{
        const result=await listCompanyModels(data.companyId,{expectedVersion:data.version,baseUrl:baseUrl.trim(),...(apiKey.trim()?{apiKey:apiKey.trim()}:{})},controller.signal);
        if(catalogRequest.current===controller)setCatalog(result);
      }catch(cause){if(catalogRequest.current===controller&&!controller.signal.aborted)setCatalogError(cause);}
      finally{if(catalogRequest.current===controller){catalogRequest.current=null;setListing(false);}}
    })();},500);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[isCustom,baseUrl,apiKey,hasUsableKey,data.companyId,data.version,disabled]);

  function changeProvider(next:string){
    setProvider(next);setAuthChoice(null);setOauthSession(null);setOauthError(undefined);setApiKey('');setReplacingKey(false);setModel('');clearCatalog();
    setBaseUrl(next==='custom'?'':selectable.find(entry=>entry.id===next)?.models.find(entry=>entry.api===executableApi)?.baseUrl??'');
  }
  function changeAuthMode(next:AuthMode){setAuthChoice(next);setOauthSession(null);setOauthError(undefined);setApiKey('');setReplacingKey(false);}
  async function startOAuth(){
    if(disabled||oauthBusy||!canOAuth)return;
    setOauthBusy(true);setOauthError(undefined);setOauthSession(null);
    try{setOauthSession(await startCompanyModelOAuth(data.companyId,{provider:'kimi-coding'}));}
    catch(cause){setOauthError(cause);}finally{setOauthBusy(false);}
  }
  useEffect(()=>{
    if(!oauthSession||oauthSession.status!=='pending')return;
    let cancelled=false;
    const timer=setInterval(()=>{void (async()=>{
      try{const next=await readCompanyModelOAuth(data.companyId,oauthSession.sessionId);if(cancelled)return;setOauthSession(next);if(next.status==='complete')void refresh();}
      catch(cause){if(!cancelled)setOauthError(cause);}
    })();},Math.max(1500,oauthSession.intervalSeconds*1000));
    return ()=>{cancelled=true;clearInterval(timer);};
  },[data.companyId,oauthSession?.sessionId,oauthSession?.status,oauthSession?.intervalSeconds]);
  async function save(){
    if(disabled||listing||!hasUsableCredential||!model.trim()||modelUnavailable)return;
    const command:CompanyModelCommand={expectedVersion:data.version,provider,model:model.trim(),authType:effectiveAuthMode,
      ...(isCustom?{baseUrl:baseUrl.trim()}:{}),
      ...(effectiveAuthMode==='api_key'&&apiKey.trim()?{apiKey:apiKey.trim()}:{}),execution:data.execution};
    setBusy(true);setError(undefined);setMessage('');setApiKey('');setReplacingKey(false);
    try{const saved=await saveCompanyModel(data.companyId,command);client.setQueryData(['company-model',data.companyId],saved);void client.invalidateQueries({queryKey:['ai-budgets']});}
    catch(cause){setError(cause);setUncertain(true);}finally{setBusy(false);}
  }
  async function test(){
    if(disabled||listing||dirty)return;setTestOpen(false);setBusy(true);setError(undefined);setMessage('');
    try{const saved=await testCompanyModel(data.companyId,data.version);client.setQueryData(['company-model',data.companyId],saved);
      setMessage(saved.test?.status==='passed'?'连接测试通过，模型支持流式工具调用。':'');}
    catch(cause){setError(cause);setUncertain(true);}finally{setBusy(false);}
  }
  const providerDescription=isCustom?'自定义网关需要手动填写接口地址和模型；系统会自动尝试读取模型列表。':'来自内嵌 Pi 供应商目录；选择后只需认证并选择模型，无需填写地址。';
  return <Card id="ai-model-settings"><CardHeader><CardTitle>AI 模型</CardTitle><CardDescription>公司所有店铺和客服会话共用一个模型，修改仅影响新发起的请求。</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5">
      {!data.encryptionConfigured&&<p role="alert" className="text-sm text-destructive">部署尚未配置凭证加密，请联系部署管理员配置服务端加密密钥。</p>}
      {providersError!=null&&<ErrorNotice error={providersError}/>}
      <form id="company-model-form" className="flex flex-col gap-4" onSubmit={event=>{event.preventDefault();void save();}} aria-busy={busy||listing}>
        <Field><FieldLabel htmlFor="company-model-provider">供应商</FieldLabel><NativeSelect id="company-model-provider" className="w-full min-w-0" value={provider} disabled={disabled} onChange={event=>changeProvider(event.target.value)}><NativeSelectOption value="custom">自定义（OpenAI 兼容接口）</NativeSelectOption>{selectable.map(entry=><NativeSelectOption key={entry.id} value={entry.id}>{entry.name}</NativeSelectOption>)}</NativeSelect><FieldDescription>{providerDescription}</FieldDescription></Field>

        {!isCustom&&canOAuth&&canKey&&<Field><FieldLabel>认证方式</FieldLabel><div className="flex flex-wrap gap-2"><Button type="button" variant={effectiveAuthMode==='oauth'?'default':'outline'} disabled={disabled} onClick={()=>changeAuthMode('oauth')}>订阅登录</Button><Button type="button" variant={effectiveAuthMode==='api_key'?'default':'outline'} disabled={disabled} onClick={()=>changeAuthMode('api_key')}>API Key</Button></div><FieldDescription>订阅登录使用供应商账号授权；API Key 使用供应商控制台生成的密钥。</FieldDescription></Field>}

        {isCustom&&<Field><FieldLabel htmlFor="company-model-url">API 地址（Base URL）</FieldLabel><Input id="company-model-url" type="url" value={baseUrl} placeholder="https://api.openai.com/v1" required maxLength={2048} disabled={disabled} onChange={event=>{clearCatalog();setBaseUrl(event.target.value);}}/><FieldDescription>OpenAI Chat Completions 兼容接口地址，不含 /chat/completions。</FieldDescription></Field>}

        {effectiveAuthMode==='oauth'&&canOAuth&&<div className="flex flex-col gap-2 rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-medium">Kimi Code 订阅登录</p><p className="text-xs text-muted-foreground">在浏览器完成授权，token 只加密保存在服务端，不会回传浏览器。</p></div><Button type="button" variant="outline" disabled={disabled||oauthBusy} onClick={()=>void startOAuth()}>{oauthBusy&&<Spinner/>}{oauthPending?'等待授权…':oauthConnected?'重新登录':'开始登录'}</Button></div>
          {oauthSession&&<div className="flex flex-col gap-2 text-sm"><p role="status">在浏览器打开：<a className="underline underline-offset-4" href={oauthSession.verificationUri} target="_blank" rel="noopener noreferrer">{oauthSession.verificationUri}</a></p><p>输入代码：<code className="rounded bg-muted px-1.5 py-0.5 text-base font-semibold">{oauthSession.userCode}</code></p>{oauthPending&&<p className="text-xs text-muted-foreground">完成后本页会自动更新，无需刷新。</p>}{oauthFailed&&<p role="alert" className="text-xs text-destructive">登录未完成，请重新发起。</p>}</div>}
          {oauthError!=null&&<ErrorNotice error={oauthError}/>}
          {oauthConnected&&<p role="status" className="text-xs text-muted-foreground">{oauthNeedsSave?'已登录。保存模型配置后生效。':'已通过订阅登录。'}{data.credentialExpiresAt?` 登录有效期至 ${new Date(data.credentialExpiresAt).toLocaleString()}。`:''}</p>}
        </div>}

        {effectiveAuthMode==='api_key'&&<Field><FieldLabel htmlFor="company-model-key">API Key</FieldLabel><div className="flex flex-wrap items-center gap-2"><Input ref={keyInput} id="company-model-key" type={savedKeyVisible?'text':'password'} value={savedKeyVisible?savedKeyMask:apiKey} readOnly={savedKeyVisible} autoComplete="off" placeholder={replacingKey?'输入新的模型供应商 API Key':'输入模型供应商 API Key'} required={!savedKeyVisible} maxLength={4096} disabled={disabled} className="min-w-0 flex-1 basis-60" aria-describedby="company-model-key-help" onChange={event=>{if(!savedKeyVisible){clearCatalog();setApiKey(event.target.value);}}}/>{(savedKeyVisible||replacingKey)&&<Button type="button" variant="outline" disabled={disabled} onClick={()=>{clearCatalog();setApiKey('');setReplacingKey(value=>!value);}}>{replacingKey?'取消更换':'更换 API Key'}</Button>}</div><FieldDescription id="company-model-key-help">{savedKeyVisible?'Key 已加密保存，星号仅表示保存状态，刷新或测试时会自动复用。':'保存后在服务端加密存储，不会回传浏览器。'}</FieldDescription>{savedKeyVisible&&!savedKeyReusable&&<p role="status" className="text-xs text-muted-foreground">已保存的 Key 属于原供应商，原 Key 不会被发往新地址；如需切换，请更换 API Key。</p>}</Field>}

        <Field><FieldLabel htmlFor="company-model-options">模型</FieldLabel>
          <NativeSelect id="company-model-options" className="w-full min-w-0" value={model} disabled={disabled||listing||(!isCustom&&defaultModels.length===0)} onChange={event=>setModel(event.target.value)}>
            <NativeSelectOption value="">{providersLoading?'正在读取供应商目录…':listing?'正在自动获取模型列表…':modelOptions.length?'请选择模型':'当前没有可用模型'}</NativeSelectOption>
            {modelOptions.map(option=><NativeSelectOption key={option.id} value={option.id}>{option.label}</NativeSelectOption>)}
            {modelUnavailable&&<NativeSelectOption value={model}>{model}（不在当前目录）</NativeSelectOption>}
          </NativeSelect>
          <FieldDescription>{isCustom?'选择自动获取的模型，或在下方手动填写 Model ID。':'来自内嵌 Pi 供应商目录；选择后保存即可使用，不需要手动填写 Model ID。'}</FieldDescription>
        </Field>
        {isCustom&&<Field><FieldLabel htmlFor="company-model-name">模型名称（Model ID）</FieldLabel><Input id="company-model-name" value={model} placeholder="供应商提供的 Model ID" required maxLength={256} disabled={disabled} onChange={event=>setModel(event.target.value)}/><FieldDescription>如果自动获取列表失败，可直接填写供应商提供的 Model ID。</FieldDescription></Field>}
        {isCustom&&listing&&<p role="status" className="text-xs text-muted-foreground">正在自动获取模型列表…</p>}
        {isCustom&&catalogError!=null&&<ErrorNotice error={catalogError}/>}
        {isCustom&&catalog&&!catalogError&&catalog.models.length===0&&<p role="status" className="text-sm text-muted-foreground">供应商未返回可用模型。请核对 Key 权限，或从供应商控制台复制 Model ID 手动填写。</p>}
        {modelUnavailable&&<p role="alert" className="text-sm text-destructive">已保存的模型不在当前供应商目录中，请重新选择模型。</p>}
        <p className="text-xs text-muted-foreground">AI 托管命中已发布策略后会直接回复买家，不再生成需要人工确认的草稿；触发转人工条件时仍不会发送。</p>
      </form>
      <div className="flex flex-col gap-1 text-sm"><p>连接状态：{!data.version?'尚未配置':data.test?.status==='passed'?'测试通过':data.test?.status==='failed'?'测试失败':data.test?.status==='pending'?'上次测试结果待确认':'已保存，尚未测试'}{data.version?` · 第 ${data.version} 版`:''}</p>
        {!data.runtimeEnabled&&data.version>0&&<p className="text-xs text-muted-foreground">当前部署缺少 AI 运行绑定。</p>}
      </div>
      {data.test?.status==='failed'&&<div role="alert" className="flex flex-col gap-2 text-sm text-destructive"><p>{data.test.failureCode?testFailures[data.test.failureCode]:'上次连接测试失败，旧记录未保存具体原因。可手动重新测试以获取诊断结果。'}</p>{data.test.providerStatus!==null&&data.test.providerStatus!==undefined&&<p className="text-xs">供应商 HTTP 状态：{data.test.providerStatus}</p>}
        {data.test.failureCode==='tool_call_missing'&&data.provider==='opencode-go'&&/^deepseek/i.test(data.model??'')&&<p className="text-xs">OpenCode Go 的 DeepSeek 模型存在已知的工具调用兼容问题。请先重新测试；若仍失败，建议改选 GLM-5.3-Flash、Kimi K3 等模型。</p>}
        {data.test.failureCode==='forbidden'&&/^https:\/\/integrate\.api\.nvidia\.com(?:\/|$)/.test(data.baseUrl??'')&&<a href="https://build.nvidia.com/" target="_blank" rel="noopener noreferrer" className="w-fit underline underline-offset-4">打开 NVIDIA 平台，检查账号和 API Key 权限</a>}</div>}
      {error!=null&&<ErrorNotice error={error}/>}{message&&<p role="status" className="text-sm">{message}</p>}
      {uncertain&&<p role="alert" className="text-sm">请先读取已保存配置，核对结果后再操作；新输入的 Key 已清除，已保存的 Key 不受影响。</p>}
    </CardContent><CardFooter className="flex flex-wrap gap-2">
      <Button form="company-model-form" type="submit" disabled={disabled||listing||!dirty||!hasUsableCredential||!model.trim()||modelUnavailable}>{busy&&<Spinner/>}保存模型配置</Button>
      <Button variant="outline" disabled={disabled||listing||!data.version||dirty} onClick={()=>setTestOpen(true)}>测试已保存配置</Button>
      <Button variant="ghost" disabled={busy||listing||fetching} onClick={()=>{clearCatalog();setApiKey('');setReplacingKey(false);setUncertain(false);setError(undefined);setMessage('');void refresh();}}>读取已保存配置</Button>
    </CardFooter>
    <Dialog open={testOpen} onOpenChange={setTestOpen}><DialogContent><DialogHeader><DialogTitle>测试模型连接</DialogTitle><DialogDescription>将使用已保存的模型发送一次流式工具调用测试，可能产生少量供应商费用；每分钟最多一次。不使用客户消息，不向客户发送回复。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={()=>setTestOpen(false)}>取消</Button><Button disabled={disabled||dirty} onClick={()=>void test()}>确认测试连接</Button></DialogFooter></DialogContent></Dialog>
  </Card>;
}
