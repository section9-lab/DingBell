import { useEffect,useRef,useState } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import type { CompanyModelView,CompanyModelCommand,CompanyModelCatalog,CompanyModelTestFailure } from '../../shared/company-model';
import { readCompanyModel,saveCompanyModel,testCompanyModel,listCompanyModels } from '../lib/company-model-api';
import { createModelExecutionDraft, modelExecutionFields, parseModelExecutionDraft } from '../lib/model-execution-form';
import { ErrorNotice } from './identity-shared';
import { Card,CardHeader,CardTitle,CardDescription,CardContent,CardFooter } from './ui/card';
import { Field,FieldLabel,FieldDescription } from './ui/field';
import { Input } from './ui/input';
import {NativeSelect,NativeSelectOption} from './ui/native-select';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter } from './ui/dialog';

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
  tool_call_missing:'供应商返回了响应，但没有完成要求的工具调用。此模型可能不支持当前工具调用方式。',
  tool_call_invalid:'供应商返回的工具调用格式不受支持，请核对模型的工具调用兼容性。',
  test_failed:'连接测试未通过，请联系部署管理员核查。',
};
// A fixed display-only sentinel, never a credential or a request-body value.
const savedKeyMask='****************';
function sameOrigin(baseUrl:string,savedUrl:string|null){try{return savedUrl!==null&&new URL(baseUrl.trim()).origin===new URL(savedUrl).origin;}catch{return false;}}
export function CompanyModelPanel({companyId}:{companyId:string}){
  const query=useQuery({queryKey:['company-model',companyId],queryFn:({signal})=>readCompanyModel(companyId,signal),retry:false,gcTime:0,refetchOnWindowFocus:false});
  if(!query.data||query.isError)return <Card><CardHeader><CardTitle>AI 模型</CardTitle></CardHeader><CardContent>{query.isPending?<p role="status" className="flex items-center gap-2"><Spinner/>正在读取模型配置…</p>:<ErrorNotice error={query.error}/>}<Button variant="outline" disabled={query.isFetching} onClick={()=>void query.refetch()}>读取模型配置</Button></CardContent></Card>;
  return <ModelForm key={`${companyId}:${query.data.version}`} data={query.data} fetching={query.isFetching} refresh={()=>query.refetch()}/>;
}
function ModelForm({data,fetching,refresh}:{data:CompanyModelView;fetching:boolean;refresh:()=>Promise<unknown>}){
  const client=useQueryClient();
  const [baseUrl,setBaseUrl]=useState(data.baseUrl??''),[model,setModel]=useState(data.model??''),[apiKey,setApiKey]=useState(''),[replacingKey,setReplacingKey]=useState(false);
  const keyInput=useRef<HTMLInputElement>(null);
  const savedKeyVisible=data.hasKey&&!replacingKey,savedKeyReusable=data.hasKey&&sameOrigin(baseUrl,data.baseUrl);
  const hasUsableKey=!!apiKey.trim()||savedKeyReusable&&!replacingKey;
  useEffect(()=>{if(replacingKey)keyInput.current?.focus();},[replacingKey]);
  const [autoReply,setAutoReply]=useState(data.execution?.autoReply??false);
  const [executionDraft,setExecutionDraft]=useState(()=>createModelExecutionDraft(data.execution));
  const [executionError,setExecutionError]=useState('');
  const [busy,setBusy]=useState(false),[testOpen,setTestOpen]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState<unknown>(),[message,setMessage]=useState('');
  const [catalog,setCatalog]=useState<CompanyModelCatalog|null>(null),[catalogSearch,setCatalogSearch]=useState(''),[catalogError,setCatalogError]=useState<unknown>(),[listing,setListing]=useState(false);
  const catalogRequest=useRef<AbortController|null>(null);
  useEffect(()=>()=>{catalogRequest.current?.abort();catalogRequest.current=null;},[]);
  function clearCatalog(){catalogRequest.current?.abort();catalogRequest.current=null;setListing(false);setCatalog(null);setCatalogSearch('');setCatalogError(undefined);}
  const visibleModels=catalog?.models.filter(id=>id.toLowerCase().includes(catalogSearch.trim().toLowerCase()))??[];
  const dirty=baseUrl!==(data.baseUrl??'')||model!==(data.model??'')||!!apiKey||replacingKey||autoReply!==(data.execution?.autoReply??false)
    ||JSON.stringify(executionDraft)!==JSON.stringify(createModelExecutionDraft(data.execution));
  const disabled=busy||fetching||uncertain||!data.encryptionConfigured;
  async function discover(){
    if(disabled||listing||!baseUrl.trim()||!hasUsableKey)return;
    const controller=new AbortController();catalogRequest.current=controller;setListing(true);setCatalogError(undefined);setCatalog(null);setCatalogSearch('');
    try{
      const result=await listCompanyModels(data.companyId,{expectedVersion:data.version,baseUrl:baseUrl.trim(),...(apiKey.trim()?{apiKey:apiKey.trim()}: {})},controller.signal);
      if(catalogRequest.current===controller)setCatalog(result);
    }catch(cause){if(catalogRequest.current===controller&&!controller.signal.aborted)setCatalogError(cause);}
    finally{if(catalogRequest.current===controller){catalogRequest.current=null;setListing(false);}}
  }
  async function save(){
    if(disabled||listing||!hasUsableKey)return;
    const parsed=parseModelExecutionDraft(executionDraft,autoReply);
    if(!parsed.success){setExecutionError(parsed.message);return;}
    const command:CompanyModelCommand={expectedVersion:data.version,baseUrl:baseUrl.trim(),model:model.trim(),
      ...(apiKey.trim()?{apiKey:apiKey.trim()}:{}),execution:parsed.execution};
    setBusy(true);setError(undefined);setExecutionError('');setMessage('');setApiKey('');setReplacingKey(false);
    try{const saved=await saveCompanyModel(data.companyId,command);client.setQueryData(['company-model',data.companyId],saved);void client.invalidateQueries({queryKey:['ai-budgets']});}
    catch(cause){setError(cause);setUncertain(true);}finally{setBusy(false);}
  }
  async function test(){
    if(disabled||listing||dirty)return;setTestOpen(false);setBusy(true);setError(undefined);setMessage('');
    try{const saved=await testCompanyModel(data.companyId,data.version);client.setQueryData(['company-model',data.companyId],saved);
      setMessage(saved.test?.status==='passed'?'连接测试通过，模型支持流式工具调用。':'');}
    catch(cause){setError(cause);setUncertain(true);}finally{setBusy(false);}
  }
  return <Card id="ai-model-settings"><CardHeader><CardTitle>AI 模型</CardTitle><CardDescription>公司所有店铺和客服会话共用一个模型，修改仅影响新发起的请求。</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5">
      {!data.encryptionConfigured&&<p role="alert" className="text-sm text-destructive">部署尚未配置凭证加密，请联系部署管理员配置服务端加密密钥。</p>}
      <form id="company-model-form" className="flex flex-col gap-4" onSubmit={event=>{event.preventDefault();void save();}} aria-busy={busy||listing}>
        <Field><FieldLabel htmlFor="company-model-url">API 地址（Base URL）</FieldLabel><Input id="company-model-url" type="url" value={baseUrl} placeholder="https://api.openai.com/v1" required maxLength={2048} disabled={disabled} onChange={event=>{clearCatalog();setBaseUrl(event.target.value);}}/><FieldDescription>OpenAI Chat Completions 兼容接口地址，不含 /chat/completions。</FieldDescription></Field>
        <Field><FieldLabel htmlFor="company-model-key">API Key</FieldLabel><div className="flex flex-wrap items-center gap-2"><Input ref={keyInput} id="company-model-key" type={savedKeyVisible?'text':'password'} value={savedKeyVisible?savedKeyMask:apiKey} readOnly={savedKeyVisible} autoComplete="off" placeholder={replacingKey?'输入新的模型供应商 API Key':'输入模型供应商 API Key'} required={!savedKeyVisible} maxLength={4096} disabled={disabled} className="min-w-0 flex-1 basis-60" aria-describedby="company-model-key-help" onChange={event=>{if(!savedKeyVisible){clearCatalog();setApiKey(event.target.value);}}}/>{data.hasKey&&<Button type="button" variant="outline" disabled={disabled} onClick={()=>{clearCatalog();setApiKey('');setReplacingKey(value=>!value);}}>{replacingKey?'取消更换':'更换 API Key'}</Button>}</div><FieldDescription id="company-model-key-help">{data.hasKey?'Key 已加密保存，星号仅表示保存状态，刷新或测试时会自动复用。':'保存后在服务端加密存储，不会回传浏览器。'}</FieldDescription>{data.hasKey&&!savedKeyReusable&&<p role="status" className="text-xs text-muted-foreground">已保存的 Key 属于原供应商，原 Key 不会被发往新域名；如需切换，请更换 API Key。</p>}</Field>
        <div className="flex flex-col gap-3">
          <div><Button type="button" variant="outline" disabled={disabled||listing||!baseUrl.trim()||!hasUsableKey} onClick={()=>void discover()}>{listing&&<Spinner/>}{listing?'正在获取模型列表…':'获取模型列表'}</Button></div>
          {catalogError!=null&&<ErrorNotice error={catalogError}/>}
          {catalog&&(catalog.models.length?<>
            {catalog.models.length>20&&<Field><FieldLabel htmlFor="company-model-search">搜索模型</FieldLabel><Input id="company-model-search" value={catalogSearch} disabled={disabled} placeholder="按模型名称筛选" onChange={event=>setCatalogSearch(event.target.value)}/></Field>}
            <Field><FieldLabel htmlFor="company-model-options">可用模型</FieldLabel><NativeSelect id="company-model-options" className="w-full min-w-0" value={visibleModels.includes(model)?model:''} disabled={disabled} onChange={event=>{if(event.target.value)setModel(event.target.value);}}><NativeSelectOption value="">请选择模型，或在下方手动填写</NativeSelectOption>{visibleModels.map(id=><NativeSelectOption key={id} value={id}>{id}</NativeSelectOption>)}</NativeSelect><FieldDescription>共 {catalog.models.length} 个模型{catalogSearch.trim()?`，匹配 ${visibleModels.length} 个`:''}；选择后填入 Model ID，不会自动保存。{catalog.truncated&&'列表较大，仅显示部分。'}</FieldDescription></Field>
          </>:<p role="status" className="text-sm text-muted-foreground">供应商未返回可用模型。请核对 Key 权限，或从供应商控制台复制 Model ID 手动填写。</p>)}
        </div>
        <Field><FieldLabel htmlFor="company-model-name">模型名称（Model ID）</FieldLabel><Input id="company-model-name" value={model} placeholder="供应商提供的模型 ID" required maxLength={256} disabled={disabled} onChange={event=>setModel(event.target.value)}/><FieldDescription>可手动填写；客服模型需支持流式输出与工具调用，保存后请测试连接。</FieldDescription></Field>
        <Field><FieldLabel htmlFor="company-model-reply">AI 回复方式</FieldLabel><NativeSelect id="company-model-reply" className="w-full" value={autoReply?'auto':'draft'} disabled={disabled} onChange={event=>setAutoReply(event.target.value==='auto')}><NativeSelectOption value="draft">只生成草稿，我在消息中心确认后发送</NativeSelectOption><NativeSelectOption value="auto">AI 直接回复买家</NativeSelectOption></NativeSelect><FieldDescription>仅对已开启 AI 托管且命中策略的会话自动回复；触发转人工等条件时不会发出。</FieldDescription></Field>
        <section className="grid gap-3" aria-label="AI 执行限制与价格"><h3 className="text-sm font-medium">执行限制与价格</h3>
          <p className="text-xs text-muted-foreground">可以全部留空，仅保存或测试模型连接。启用 AI 接待前需完整填写；未知价格不是免费，只有已核实免费的项目才填 0。价格由供应商提供，不从模型目录猜测。</p>
          <div className="grid gap-3 sm:grid-cols-2">{modelExecutionFields.map(field=><Field key={field.name}><FieldLabel htmlFor={`company-model-${field.name}`}>{field.label}</FieldLabel><Input id={`company-model-${field.name}`} inputMode={field.price?'decimal':'numeric'} autoComplete="off" value={executionDraft[field.name]} disabled={disabled} onChange={event=>{setExecutionDraft(value=>({...value,[field.name]:event.target.value}));setExecutionError('');}}/></Field>)}</div>
          {executionError&&<p role="alert" className="text-sm text-destructive">{executionError}</p>}
        </section>
      </form>
      <div className="flex flex-col gap-1 text-sm"><p>连接状态：{!data.version?'尚未配置':data.test?.status==='passed'?'测试通过':data.test?.status==='failed'?'测试失败':data.test?.status==='pending'?'上次测试结果待确认':'已保存，尚未测试'}{data.version?` · 第 ${data.version} 版`:''}</p>
        {!data.runtimeEnabled&&data.version>0&&<p className="text-xs text-muted-foreground">当前部署缺少 AI 运行绑定。</p>}
      </div>
      {data.test?.status==='failed'&&<div role="alert" className="flex flex-col gap-2 text-sm text-destructive"><p>{data.test.failureCode?testFailures[data.test.failureCode]:'上次连接测试失败，旧记录未保存具体原因。可手动重新测试以获取诊断结果。'}</p>{data.test.providerStatus!==null&&data.test.providerStatus!==undefined&&<p className="text-xs">供应商 HTTP 状态：{data.test.providerStatus}</p>}{data.test.failureCode==='forbidden'&&/^https:\/\/integrate\.api\.nvidia\.com(?:\/|$)/.test(data.baseUrl??'')&&<a href="https://build.nvidia.com/" target="_blank" rel="noopener noreferrer" className="w-fit underline underline-offset-4">打开 NVIDIA 平台，检查账号和 API Key 权限</a>}</div>}
      {error!=null&&<ErrorNotice error={error}/>}{message&&<p role="status" className="text-sm">{message}</p>}
      {uncertain&&<p role="alert" className="text-sm">请先读取已保存配置，核对结果后再操作；新输入的 Key 已清除，已保存的 Key 不受影响。</p>}
    </CardContent><CardFooter className="flex flex-wrap gap-2">
      <Button form="company-model-form" type="submit" disabled={disabled||listing||!dirty||!hasUsableKey}>{busy&&<Spinner/>}保存模型配置</Button>
      <Button variant="outline" disabled={disabled||listing||!data.version||dirty} onClick={()=>setTestOpen(true)}>测试已保存配置</Button>
      <Button variant="ghost" disabled={busy||listing||fetching} onClick={()=>{clearCatalog();setApiKey('');setReplacingKey(false);setUncertain(false);setError(undefined);setMessage('');void refresh();}}>读取已保存配置</Button>
    </CardFooter>
    <Dialog open={testOpen} onOpenChange={setTestOpen}><DialogContent><DialogHeader><DialogTitle>测试模型连接</DialogTitle><DialogDescription>将使用已保存的模型发送一次流式工具调用测试，可能产生少量供应商费用；每分钟最多一次。不使用客户消息，不向客户发送回复。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={()=>setTestOpen(false)}>取消</Button><Button disabled={disabled||dirty} onClick={()=>void test()}>确认测试连接</Button></DialogFooter></DialogContent></Dialog>
  </Card>;
}
