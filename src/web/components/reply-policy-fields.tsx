import type { ReplyPolicyConfig } from '../../shared/reply-policy';
import type { StoreRecord } from '../lib/stores-api';
import { notificationVariables } from '../../shared/reply-policy';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Checkbox } from './ui/checkbox';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldSet, FieldLegend } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Textarea } from './ui/textarea';

export const stages={presale:'售前咨询',order:'售中订单查询',aftersale:'售后维护'};
export const events={order_placed:'订单创建',dispatched:'已发货',ready_for_pickup:'待取件',delivered:'已签收'};
export function defaultPolicy(kind:ReplyPolicyConfig['kind']):ReplyPolicyConfig {
  const common={name:'',storeIds:[],priority:50};
  return kind==='automatic'?{...common,kind,stages:['presale'],mode:'suggest',language:'customer',tone:'concise',instructions:''}:
    {...common,kind,event:'dispatched',delayMinutes:0,expiresAfterMinutes:1440,maxPerDay:1,quietHours:{start:'22:00',end:'08:00'},content:'您的订单 {{order_number}} 已发货，请耐心等待。'};
}
export function PolicyFields({config,stores,timeZone,onChange}:{config:ReplyPolicyConfig;stores:StoreRecord[];timeZone:string;onChange:(config:ReplyPolicyConfig)=>void}) {
  return <FieldGroup>
    <Field><FieldLabel htmlFor="policy-name">策略名称</FieldLabel><Input id="policy-name" value={config.name} maxLength={80} required onChange={e=>onChange({...config,name:e.target.value})} /></Field>
    <FieldSet><FieldLegend>适用店铺</FieldLegend><FieldDescription>明确选择此策略覆盖的店铺，最多 20 家。已选择 {config.storeIds.length} 家。</FieldDescription>
      <FieldGroup className="gap-2">{stores.map(store=><Field key={store.id} orientation="horizontal"><Checkbox id={`policy-store-${store.id}`} checked={config.storeIds.includes(store.id)} onCheckedChange={checked=>onChange({...config,storeIds:checked?[...config.storeIds,store.id]:config.storeIds.filter(id=>id!==store.id)})} /><FieldLabel htmlFor={`policy-store-${store.id}`}>{store.name}</FieldLabel></Field>)}</FieldGroup>
      {stores.length===0&&<p className="text-sm text-muted-foreground">请先在店铺管理中连接店铺。</p>}
    </FieldSet>
    <Field><FieldLabel htmlFor="policy-priority">优先级</FieldLabel><Input id="policy-priority" type="number" min={0} max={100} step={1} required value={config.priority} onChange={e=>onChange({...config,priority:e.target.valueAsNumber})} /><FieldDescription>0–100，数值越高越优先。同一店铺与业务阶段的自动回复策略不能有相同优先级。</FieldDescription></Field>
    {config.kind==='automatic'?<>
      <FieldSet><FieldLegend>业务阶段</FieldLegend><FieldGroup className="gap-2">{(Object.keys(stages) as (keyof typeof stages)[]).map(stage=><Field orientation="horizontal" key={stage}><Checkbox id={`policy-stage-${stage}`} checked={config.stages.includes(stage)} onCheckedChange={checked=>onChange({...config,stages:checked?[...config.stages,stage]:config.stages.filter(value=>value!==stage)})} /><FieldLabel htmlFor={`policy-stage-${stage}`}>{stages[stage]}</FieldLabel></Field>)}</FieldGroup></FieldSet>
      <Field><FieldLabel htmlFor="policy-mode">回复方式</FieldLabel><NativeSelect id="policy-mode" className="w-full" value={config.mode} onChange={e=>onChange({...config,mode:e.target.value as typeof config.mode})}><NativeSelectOption value="suggest">生成建议，人工确认发送</NativeSelectOption><NativeSelectOption value="automatic">在授权范围内自动回复</NativeSelectOption></NativeSelect><FieldDescription>自动回复仍受店铺权限、人工接管和预算限制。</FieldDescription></Field>
      <Field><FieldLabel htmlFor="policy-language">回复语言</FieldLabel><NativeSelect id="policy-language" className="w-full" value={config.language} onChange={e=>onChange({...config,language:e.target.value as typeof config.language})}>{Object.entries({customer:'跟随消费者语言',ru:'俄语','zh-CN':'简体中文',en:'英语'}).map(([value,label])=><NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="policy-tone">回复语气</FieldLabel><NativeSelect id="policy-tone" className="w-full" value={config.tone} onChange={e=>onChange({...config,tone:e.target.value as typeof config.tone})}>{Object.entries({concise:'简洁清晰',friendly:'亲切友好',formal:'正式礼貌'}).map(([value,label])=><NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="policy-instructions">补充说明</FieldLabel><Textarea id="policy-instructions" rows={4} maxLength={2000} value={config.instructions} onChange={e=>onChange({...config,instructions:e.target.value})} /><FieldDescription>可补充表达方式。商品事实与店铺政策应在知识库维护。</FieldDescription></Field>
      <Alert><AlertTitle>需要转人工的情况</AlertTitle><AlertDescription>缺少可靠依据、消费者要求人工，或退款与额外折扣需要商家决定时交给团队。补充说明不会授予 AI 新的操作权限。</AlertDescription></Alert>
    </>:<>
      <Field><FieldLabel htmlFor="policy-event">触发阶段</FieldLabel><NativeSelect id="policy-event" className="w-full" value={config.event} onChange={e=>onChange({...config,event:e.target.value as typeof config.event})}>{Object.entries(events).map(([value,label])=><NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect><FieldDescription>具体阶段是否可用，取决于店铺的履约方式与平台能力。</FieldDescription></Field>
      <Field><FieldLabel htmlFor="policy-delay">延迟发送（分钟）</FieldLabel><Input id="policy-delay" type="number" min={0} max={10080} required value={config.delayMinutes} onChange={e=>onChange({...config,delayMinutes:e.target.valueAsNumber})} /></Field>
      <Field><FieldLabel htmlFor="policy-expiry">事件有效期（分钟）</FieldLabel><Input id="policy-expiry" type="number" min={1} max={43200} required value={config.expiresAfterMinutes} onChange={e=>onChange({...config,expiresAfterMinutes:e.target.valueAsNumber})} /><FieldDescription>从事件发生时计算，必须长于延迟时间；到期后不再发送。</FieldDescription></Field>
      <Field><FieldLabel htmlFor="policy-cap">同一消费者每日通知上限</FieldLabel><Input id="policy-cap" type="number" min={1} max={3} required value={config.maxPerDay} onChange={e=>onChange({...config,maxPerDay:e.target.valueAsNumber})} /><FieldDescription>此规则每天最多发送 1–3 次，平台限制仍优先。</FieldDescription></Field>
      <FieldSet><FieldLegend>免打扰时间</FieldLegend><Field orientation="horizontal"><Checkbox id="policy-quiet" checked={config.quietHours!==null} onCheckedChange={checked=>onChange({...config,quietHours:checked?{start:'22:00',end:'08:00'}:null})} /><FieldLabel htmlFor="policy-quiet">启用免打扰</FieldLabel></Field>
        {config.quietHours&&<FieldGroup className="sm:flex-row"><Field><FieldLabel htmlFor="policy-quiet-start">开始时间</FieldLabel><Input id="policy-quiet-start" type="time" required value={config.quietHours.start} onChange={e=>onChange({...config,quietHours:{...config.quietHours!,start:e.target.value}})} /></Field><Field><FieldLabel htmlFor="policy-quiet-end">结束时间</FieldLabel><Input id="policy-quiet-end" type="time" required value={config.quietHours.end} onChange={e=>onChange({...config,quietHours:{...config.quietHours!,end:e.target.value}})} /></Field></FieldGroup>}
        <FieldDescription>发布时使用公司时区 {timeZone}。免打扰结束后，仍需检查事件是否过期。</FieldDescription>
      </FieldSet>
      <Field><FieldLabel htmlFor="policy-content">通知内容</FieldLabel><Textarea id="policy-content" rows={4} maxLength={1000} required value={config.content} onChange={e=>onChange({...config,content:e.target.value})} /><FieldDescription>支持：{notificationVariables.map(value=>`{{${value}}}`).join('、')}。变量缺失时不发送不完整消息。</FieldDescription></Field>
    </>}
  </FieldGroup>;
}
export function PolicySummary({config,stores}:{config:ReplyPolicyConfig;stores:StoreRecord[]}) {
  return <div className="flex flex-col gap-2 text-sm">
    <p className="font-medium break-words">{config.name}</p>
    <p className="break-words">店铺：{config.storeIds.map(id=>stores.find(store=>store.id===id)?.name??'未载入的店铺').join('、')} · 优先级 {config.priority}</p>
    {config.kind==='automatic'?<>
      <p>阶段：{config.stages.map(stage=>stages[stage]).join('、')}</p>
      <p>{config.mode==='suggest'?'人工确认发送':'授权范围内自动回复'} · {({customer:'跟随消费者语言',ru:'俄语','zh-CN':'简体中文',en:'英语'})[config.language]} · {({concise:'简洁清晰',friendly:'亲切友好',formal:'正式礼貌'})[config.tone]}</p>
      {config.instructions&&<p className="whitespace-pre-wrap break-words">{config.instructions}</p>}
    </>:<>
      <p>{events[config.event]} · 延迟 {config.delayMinutes} 分钟 · {config.expiresAfterMinutes} 分钟内有效 · 每日最多 {config.maxPerDay} 次</p>
      <p>{config.quietHours?`免打扰 ${config.quietHours.start}–${config.quietHours.end}`:'未设置免打扰'}</p>
      <p className="whitespace-pre-wrap break-words">{config.content}</p>
    </>}
  </div>;
}
