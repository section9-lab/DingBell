import {useState} from 'react';
import type {OrderHistoryCommand,PostingSource} from '../../shared/order-history';
import {changeOrderHistory,type FbsSyncState,type FboSyncState,type FbpSyncState} from '../lib/sync-api';
import type {StoreChange} from './store-dialogs';
import {useCompanySettings} from './company-settings-provider';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Field,FieldLabel,FieldDescription} from './ui/field';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from './ui/dialog';
function defaultSince(sync:FbsSyncState|FboSyncState|FbpSyncState){const date=new Date(sync.history?.requestedFrom??Date.now());if(!sync.history||sync.history.state==='complete')date.setUTCFullYear(date.getUTCFullYear()-1);return date.toISOString().slice(0,10)<'2000-01-01'?'2000-01-01':date.toISOString().slice(0,10);}
export function OrderHistoryPanel({companyId,storeId,source,sync,management,canEnable,configured,pending,change}:{companyId:string;storeId:string;source:PostingSource;sync:FbsSyncState|FboSyncState|FbpSyncState;management:boolean;canEnable:boolean;configured:boolean;pending:boolean;change:StoreChange}){
 const {date}=useCompanySettings(),history=sync.history,mode=source==='fbs_postings'?'FBS':source==='fbo_postings'?'FBO':'FBP';
 const [since,setSince]=useState(()=>defaultSince(sync)),[confirm,setConfirm]=useState<OrderHistoryCommand|null>(null);
 const max=sync.historyStart?new Date(Date.parse(sync.historyStart)-1).toISOString().slice(0,10):'';
 const alreadyCovered=history?.state==='complete'&&since>=history.coveredFrom.slice(0,10),alreadyRequested=history?.state==='active'&&since>=history.requestedFrom.slice(0,10);
 const canStart=management&&configured&&canEnable&&sync.enabled&&!!sync.historyStart&&since.length===10&&since>='2000-01-01'&&since<=(max||'0000')&&!alreadyCovered&&!alreadyRequested;
 return <section className="flex flex-col gap-3 rounded-lg border p-3" aria-label={`${mode} 历史回补`}>
  <h4 className="text-sm font-medium">历史订单回补</h4>
  <p className="text-xs text-muted-foreground">首次同步仅导入最近 30 天。这里可补更早的 {mode} 订单；默认最近一年，也可选择更早日期。按不超过 31 天的窗口分批读取，不打断近期订单刷新。</p>
  {history?<div className="flex flex-col gap-1 text-xs text-muted-foreground" role="status" aria-label={`${mode} 历史回补进度`}>
   <p>状态：{history.state==='complete'?'指定范围列表已完成':history.state==='cancelled'?'历史回补已停止':!sync.enabled?'历史回补已暂停':sync.lastError?'等待恢复或重试':'历史回补进行中'}</p>
   <p>请求范围：{date(history.requestedFrom)} — {date(history.requestedTo)}</p>
   <p>已读取 {history.pagesRead} 页 · {history.coveredFrom===history.requestedTo?'尚未完成历史窗口':`列表已覆盖 ${date(history.coveredFrom)} 至 ${date(history.requestedTo)}`}</p>
   {history.state==='active'&&<p>当前回补窗口：{date(history.windowSince)} — {date(history.windowTo)}</p>}
   <p>范围完成只表示列表已读取，包裹详情会继续补齐；是否能取得更早数据取决于平台保留和授权范围。</p>
  </div>:<p className="text-xs text-muted-foreground">尚未安排历史回补。历史导入不会发送通知或触发 AI 回复。</p>}
  {management&&<>
   <Field><FieldLabel htmlFor={`history-${source}-since`}>历史起始日期（UTC）</FieldLabel><Input id={`history-${source}-since`} type="date" min="2000-01-01" max={max} value={since} disabled={pending} onChange={event=>setSince(event.target.value)}/><FieldDescription>{alreadyCovered?'所选时间范围已完成，可选择更早日期继续。':alreadyRequested?'当前范围正在回补，可选更早起点扩大范围。':'从所选日期补到首次近期同步的起点，不会删除或重复创建已有包裹。'}</FieldDescription></Field>
   {!sync.enabled&&<p className="text-xs text-muted-foreground">请先启用 {mode} 包裹同步，再开始或继续历史回补。</p>}
   <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={pending||!canStart} onClick={()=>setConfirm({operation:'start',expectedEpoch:sync.epoch,expectedHistoryRevision:history?.commandRevision??0,since})}>{history?.state==='active'?'扩大历史范围':history?.state==='cancelled'?'继续历史回补':'同步历史订单'}</Button>{history?.state==='active'&&<Button variant="ghost" size="sm" disabled={pending} onClick={()=>setConfirm({operation:'cancel',expectedEpoch:sync.epoch,expectedHistoryRevision:history.commandRevision})}>停止历史回补</Button>}</div>
  </>}
  <Dialog open={confirm!==null} onOpenChange={open=>{if(!open&&!pending)setConfirm(null);}}><DialogContent><DialogHeader><DialogTitle>{confirm?.operation==='cancel'?'停止':'启动'} {mode} 历史回补</DialogTitle><DialogDescription>{confirm?.operation==='start'?`将从 ${confirm.since}（UTC）开始补齐更早的 ${mode} 订单，按窗口分批读取并保存断点。近期同步不受影响，也不会发送客户消息。供应商可能不提供部分更早数据。`:'只停止历史回补，近期订单与已有包裹详情仍会继续同步；已导入数据和断点保留。'}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={pending} onClick={()=>setConfirm(null)}>取消</Button><Button disabled={pending||confirm===null} onClick={()=>confirm&&void change(()=>changeOrderHistory(companyId,storeId,source,confirm))}>{confirm?.operation==='cancel'?'确认停止历史回补':'确认同步历史订单'}</Button></DialogFooter></DialogContent></Dialog>
 </section>;
}
