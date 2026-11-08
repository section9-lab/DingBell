import { LoadingState } from './query-state';
import {useEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useForm} from 'react-hook-form';
import {valibotResolver} from '@hookform/resolvers/valibot';
import * as v from 'valibot';
import {Copy,RefreshCw} from 'lucide-react';
import {pushSources,type PushCommand} from '../../shared/ozon-push';
import {changePush,readPush,simulatePush} from '../lib/ozon-push-api';
import {ErrorNotice} from './identity-shared';
import {useCompanySettings} from './company-settings-provider';
import {Button} from './ui/button';
import {Badge} from './ui/badge';
import {Card,CardHeader,CardTitle,CardDescription,CardAction,CardContent} from './ui/card';
import {Alert,AlertTitle,AlertDescription} from './ui/alert';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from './ui/dialog';
import {Field,FieldLabel,FieldDescription,FieldError} from './ui/field';
import {Input} from './ui/input';
import {Textarea} from './ui/textarea';
import {NativeSelect,NativeSelectOption} from './ui/native-select';
import {Spinner} from './ui/spinner';
import {Table,TableHeader,TableHead,TableRow,TableBody,TableCell} from './ui/table';
const labels={unconfigured:'尚未配置',prepared:'等待切换',active:'Push 驱动',paused:'Push 已暂停'};
const states={pending:'待处理',processing:'处理中',retry:'等待重试',completed:'已完成',ignored:'已忽略',failed:'需处理'};
const sources={chat:'会话与消息',products:'商品',fbs_postings:'FBS 包裹',fbo_postings:'FBO 包裹',fbp_postings:'FBP 包裹'};
const eventNames:Record<string,string>={TYPE_NEW_MESSAGE:'新消息',TYPE_UPDATE_MESSAGE:'消息更新',TYPE_MESSAGE_READ:'已读状态',TYPE_CHAT_CLOSED:'会话关闭',TYPE_CREATE_OR_UPDATE_ITEM:'商品更新',TYPE_STOCKS_CHANGED:'库存变更',TYPE_PRICE_INDEX_CHANGED:'价格指数变更',TYPE_NEW_POSTING:'新包裹',TYPE_STATE_CHANGED:'包裹状态',TYPE_POSTING_CANCELLED:'包裹取消',TYPE_CUTOFF_DATE_CHANGED:'发货日期',TYPE_DELIVERY_DATE_CHANGED:'送达日期',MANUAL_RECONCILE:'人工回补',MANUAL_ITEM:'回补资料'};
const reasons:Record<string,string>={rate_limited:'平台限流，按许可时间重试',network_error:'网络异常，已安排重试',timed_out:'读取超时，已安排重试',invalid_credentials:'平台凭证失效，请更新并检查',credentials_unavailable:'凭证无法解密，请检查加密密钥',permission_denied:'平台读取权限不足',invalid_response:'平台响应未通过校验',chat_not_found:'尚未在平台聊天列表中找到该会话',message_not_found:'平台历史中尚未找到该消息',message_content_changed:'平台编辑与不可变消息冲突，保留原记录，需人工核对',cursor_stalled:'平台分页未推进，需检查',product_identity_unresolved:'SKU 无法唯一匹配商品，请先回补目录',product_details_missing:'平台未返回全部商品详情',product_listing_missing:'平台未返回全部商品库存标记',sync_authority_changed:'处理期间店铺授权或配置改变，资料未提交',push_processing_failed:'处理未完成，请核查后重试'};
const prepareSchema=v.object({sellerId:v.pipe(v.string(),v.trim(),v.regex(/^(?:|0|[1-9][0-9]{0,39})$/,'请填写通知中的数字 seller_id，或暂留空'))});
const simulationSchema=v.object({body:v.pipe(v.string(),v.minLength(2),v.maxLength(65536),v.check(text=>{try{const value:unknown=JSON.parse(text);return !!value&&typeof value==='object'&&!Array.isArray(value);}catch{return false;}},'请输入有效的 JSON 对象'))});

export function StorePushPanel({companyId,storeId,management,configured}:{companyId:string;storeId:string;management:boolean;configured:boolean}){
 const client=useQueryClient(),{date}=useCompanySettings(),key=['store-push',companyId,storeId];
 const query=useQuery({queryKey:key,queryFn:({signal})=>readPush(companyId,storeId,signal)});
 const [pending,setPending]=useState(false),busy=useRef(false),[error,setError]=useState<unknown>(null),[notice,setNotice]=useState(''),[callback,setCallback]=useState(''),[visible,setVisible]=useState(false);
 const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const [confirm,setConfirm]=useState<PushCommand|null>(null),[source,setSource]=useState<(typeof pushSources)[number]>('chat');
 const prepare=useForm({resolver:valibotResolver(prepareSchema),defaultValues:{sellerId:''}}),simulation=useForm({resolver:valibotResolver(simulationSchema),defaultValues:{body:'{\n  "message_type": "TYPE_PING",\n  "time": "'+new Date().toISOString()+'"\n}'}});
 useEffect(()=>{if(!management){setCallback('');setVisible(false);}},[management]);
 async function run(command:PushCommand){
  if(busy.current)return;busy.current=true;setPending(true);setError(null);setNotice('');
  try{const result=await changePush(companyId,storeId,command);if(!mounted.current)return;const {callbackUrl,...safe}=result.push;if(callbackUrl)setCallback(callbackUrl);
   // Callback credentials stay only in this manager component, never in the shared query cache.
   client.setQueryData(key,{push:safe});setConfirm(null);return callbackUrl;
  }catch(cause){setError(cause);void query.refetch();}finally{busy.current=false;setPending(false);}
 }
 if(query.isPending)return <LoadingState>正在读取 Push 状态…</LoadingState>;
 if(query.isError||!query.data)return <div><ErrorNotice error={query.error}/><Button variant="outline" onClick={()=>void query.refetch()}>重新读取 Push 状态</Button></div>;
 const view=query.data.push,revision=view.revision,active=view.mode==='active';
 async function copy(){try{const url=callback||await run({operation:'reveal',expectedRevision:revision});if(url){await navigator.clipboard.writeText(url);setNotice('回调地址已复制。地址含密钥，请仅填入 Ozon 通知配置。');}}catch{setNotice('浏览器未允许复制。请点击「显示地址」后手动复制。');}}
 async function simulate(body:string){const url=callback||await run({operation:'reveal',expectedRevision:revision});if(!url)return;busy.current=true;setPending(true);setError(null);try{await simulatePush(url,body);setNotice('本地模拟回调已接收。后台仍从 Ozon 核对资料，不会触发 AI 自动回复。');await query.refetch();}catch(cause){setError(cause);}finally{busy.current=false;setPending(false);}}
 return <Card role="region" aria-labelledby="store-push-title">
  <CardHeader><CardTitle><h3 id="store-push-title">Ozon Push 同步</h3></CardTitle><CardAction><Badge variant="outline">{labels[view.mode]}</Badge></CardAction><CardDescription>通知先持久化，再按变更对象读取平台事实。明确切换后停止周期扫描；页面通过实时连接刷新。</CardDescription></CardHeader>
  <CardContent className="flex flex-col gap-5">
   {error!=null&&<ErrorNotice error={error}/>} {notice&&<p role="status" className="text-sm">{notice}</p>}
   {view.localSimulationAllowed&&<Alert><AlertTitle>本地调试，不代表 Ozon 公网已接通</AlertTitle><AlertDescription>127.0.0.1 无法接收 Ozon 公网通知。可先验证本地协议与处理链；云端发布后仍需配置公开 HTTPS 地址及实际可订阅类型。</AlertDescription></Alert>}
   {!view.cutoverAt&&<p className="text-sm text-muted-foreground">当前仍保留原有同步。完成回调握手并确认切换前，不会中断已有店铺更新。</p>}
   {view.cutoverAt&&view.mode!=='active'&&<Alert><AlertTitle>已切换过 Push，目前没有自动读取</AlertTitle><AlertDescription>队列、资料与旧断点均保留。恢复 Push 后继续处理；不会偷偷退回周期扫描。</AlertDescription></Alert>}
   <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3"><div><dt className="text-muted-foreground">最近协议握手</dt><dd className="mt-1">{date(view.lastPingAt,'尚未收到')}</dd></div><div><dt className="text-muted-foreground">最近收到通知</dt><dd className="mt-1">{date(view.lastReceivedAt,'尚未收到')}</dd></div><div><dt className="text-muted-foreground">最近完成处理</dt><dd className="mt-1">{date(view.lastProcessedAt,'尚未完成')}</dd></div></dl>
   {view.localSimulationAllowed&&<p className="text-xs text-muted-foreground">最近本地模拟：{date(view.lastSimulationAt,'尚未模拟')}。模拟不计作正式回调送达证据。</p>}
   <p className="text-xs text-muted-foreground">seller_id 绑定：{view.sellerId??'未指定'} · 最近观测：{view.observedSellerId??'尚未收到'}。通知中的 seller_id 不自动视为 Client ID，也不用于选择本地店铺。</p>
   {view.reviewCount>0&&<Alert><AlertTitle>存在 {view.reviewCount} 个不可变消息冲突</AlertTitle><AlertDescription>原消息保留，相关会话的 AI 发送已被阻断。冲突页（含同页新消息）暂不提交；请先到平台核对完整对话再人工回复。本版本不直接改写已被引用的正文。</AlertDescription></Alert>}
   <dl className="grid grid-cols-3 gap-3 text-sm sm:grid-cols-6">{Object.entries(view.queue).map(([state,total])=><div key={state}><dt className="text-xs text-muted-foreground">{states[state as keyof typeof states]}</dt><dd className="mt-1 font-medium">{total}</dd></div>)}</dl>
   {management&&<>
    <form className="flex flex-wrap items-end gap-3" onSubmit={prepare.handleSubmit(({sellerId})=>{const command={operation:'prepare' as const,expectedRevision:revision,...(sellerId?{sellerId}:{})};if(view.mode==='unconfigured')void run(command);else setConfirm(command);})}>
     <Field className="min-w-52 flex-1"><FieldLabel htmlFor="push-seller-id">通知 seller_id（可选）</FieldLabel><Input id="push-seller-id" inputMode="numeric" autoComplete="off" {...prepare.register('sellerId')} aria-invalid={!!prepare.formState.errors.sellerId}/><FieldDescription>确认实际通知标识后填写；留空时仍使用每店铺独立的地址密钥隔离。</FieldDescription>{prepare.formState.errors.sellerId&&<FieldError>{prepare.formState.errors.sellerId.message}</FieldError>}</Field>
     <Button type="submit" variant="outline" disabled={pending||!configured}>{view.mode==='unconfigured'?'生成回调地址':'重新生成地址'}</Button>
    </form>
    {view.mode!=='unconfigured'&&<div className="flex flex-col gap-3"><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending} onClick={()=>void copy()}><Copy data-icon="inline-start"/>复制回调地址</Button><Button variant="ghost" disabled={pending} onClick={async()=>{if(!callback)await run({operation:'reveal',expectedRevision:revision});setVisible(value=>!value);}}>{visible?'隐藏地址':'显示地址'}</Button></div>{visible&&callback&&<Field><FieldLabel htmlFor="push-callback-url">回调地址（含密钥）</FieldLabel><Input id="push-callback-url" readOnly value={callback} onFocus={event=>event.currentTarget.select()}/></Field>}
     <div className="flex flex-wrap gap-2">{!active?<Button disabled={pending||!view.lastPingAt||!configured} onClick={()=>setConfirm({operation:'activate',expectedRevision:revision})}>{view.cutoverAt?'恢复 Push':'切换为 Push'}</Button>:<Button variant="outline" disabled={pending} onClick={()=>setConfirm({operation:'pause',expectedRevision:revision})}>暂停 Push 处理</Button>}{view.cutoverAt&&<Button variant="ghost" disabled={pending} onClick={()=>setConfirm({operation:'rollback',expectedRevision:revision})}>迁移回滚</Button>}</div>
    </div>}
    {view.localSimulationAllowed&&view.mode!=='unconfigured'&&<form className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={simulation.handleSubmit(({body})=>void simulate(body))}><h4 className="text-sm font-medium">本地 Push 模拟器</h4><Field><FieldLabel htmlFor="push-simulation-json">模拟通知 JSON</FieldLabel><Textarea id="push-simulation-json" className="min-h-36 font-mono text-xs" spellCheck={false} {...simulation.register('body')} aria-invalid={!!simulation.formState.errors.body}/>{simulation.formState.errors.body&&<FieldError>{simulation.formState.errors.body.message}</FieldError>}<FieldDescription>先发送 TYPE_PING 完成握手。测试业务事件时填写真实平台 ID；回调正文不会被当作买家消息。</FieldDescription></Field><Button className="w-fit" type="submit" variant="outline" disabled={pending}>发送本地模拟回调</Button></form>}
    {active&&<div className="flex flex-wrap items-end gap-3"><Field className="min-w-48"><FieldLabel htmlFor="push-recovery-source">人工回补来源</FieldLabel><NativeSelect id="push-recovery-source" value={source} onChange={event=>setSource(event.target.value as typeof source)}>{pushSources.map(value=><NativeSelectOption key={value} value={value}>{sources[value]}</NativeSelectOption>)}</NativeSelect><FieldDescription>需先在下方开启来源。聊天补历史；包裹默认最近 30 天，更早范围用历史导入。</FieldDescription></Field><Button variant="outline" disabled={pending} onClick={()=>setConfirm({operation:'reconcile',expectedRevision:revision,source,commandId:crypto.randomUUID()})}>执行一次回补</Button></div>}
   </>}
   <p className="text-xs leading-6 text-muted-foreground">接入范围：买家消息、消息状态、商品变更及已支持的 FBS 包裹事件，以实际 Ozon 店铺可订阅类型为准。FBO / FBP 不假定存在全覆盖推送，保留人工回补。商品推送不保证覆盖每个字段的变化。</p>
   {view.events.length>0&&<Table><TableHeader><TableRow><TableHead>事件</TableHead><TableHead>对象</TableHead><TableHead>状态</TableHead><TableHead>处理情况</TableHead>{management&&<TableHead className="text-right">操作</TableHead>}</TableRow></TableHeader><TableBody>{view.events.map(event=><TableRow key={event.id}><TableCell><p className="whitespace-nowrap text-xs">{eventNames[event.notificationType]??event.notificationType}{event.simulated?' · 模拟':''}</p><p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">{date(event.receivedAt)}</p></TableCell><TableCell className="max-w-44 break-all text-xs">{event.target||sources[event.source as keyof typeof sources]||'—'}</TableCell><TableCell className="whitespace-nowrap text-xs">{states[event.state]}</TableCell><TableCell className="max-w-64 text-xs">{event.lastError?(reasons[event.lastError]??`需核查：${event.lastError}`):event.state==='retry'?`下一次：${date(event.nextAttemptAt)}`:'—'}{event.attempts>0&&<p className="mt-1 text-muted-foreground">{event.state==='completed'?'曾失败':'失败'} {event.attempts} 次</p>}</TableCell>{management&&<TableCell className="text-right">{event.state==='failed'&&<Button size="sm" variant="outline" disabled={pending||!active} onClick={()=>void run({operation:'retry',expectedRevision:revision,eventId:event.id})}>重试</Button>}</TableCell>}</TableRow>)}</TableBody></Table>}
   <Button className="w-fit" variant="ghost" disabled={pending||query.isFetching} onClick={()=>void query.refetch()}><RefreshCw data-icon="inline-start"/>刷新 Push 状态</Button>
  </CardContent>
  <Dialog open={confirm!==null} onOpenChange={open=>{if(!open&&!pending)setConfirm(null);}}><DialogContent><DialogHeader><DialogTitle>{confirm?.operation==='activate'?'切换为 Push 驱动':confirm?.operation==='pause'?'暂停 Push 处理':confirm?.operation==='rollback'?'迁移回滚':confirm?.operation==='reconcile'?'执行一次人工回补':'重新生成回调地址'}</DialogTitle><DialogDescription>{confirm?.operation==='activate'?'切换后停止聊天、商品和包裹的周期扫描。只有收到通知或明确执行人工回补才会读取平台。本地未连接公网通知时，不会自动获知真实店铺变化。已有资料与旧断点保留。':confirm?.operation==='pause'?'停止队列处理，但继续持久化有效通知，已有资料不删除。不会自动恢复旧轮询。':confirm?.operation==='rollback'?'仅作为迁移故障回退：暂停 Push 处理并恢复旧扫描。不会删除通知或已有资料；重新验证后可再次切换。':confirm?.operation==='reconcile'?'执行一轮有限的读取与详情补充，完成后停止，不开启周期扫描。历史数据不会自动触发 AI 回复。':'旧地址将立即失效。已切换的店铺会暂停 Push，不会自动恢复轮询；需更新 Ozon 回调地址并重新完成握手。已经持久化的通知仍保留，恢复后继续处理。'}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={pending} onClick={()=>setConfirm(null)}>取消</Button><Button disabled={pending||!confirm} onClick={()=>confirm&&void run(confirm)}>{pending&&<Spinner/>}确认{confirm?.operation==='activate'?'切换':confirm?.operation==='reconcile'?'回补':''}</Button></DialogFooter></DialogContent></Dialog>
 </Card>;
}
