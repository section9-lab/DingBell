import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowDown, Info, MessagesSquare, ImageOff } from 'lucide-react';
import type { ConversationDetail, ConversationMessage } from '../lib/conversations-api';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from './ui/sheet';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from './ui/empty';
import { Message, MessageContent, MessageHeader, MessageFooter } from './ui/message';
import { Bubble, BubbleContent } from './ui/bubble';
import { Marker, MarkerContent, MarkerIcon } from './ui/marker';
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton, useMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility } from './ui/message-scroller';

import { useCompanySettings } from './company-settings-provider';
import { MessageContext, type MessageContextScope } from './message-context';

export function MessageEmpty({ title, description }: { title: string; description: string }) {
  return <Empty><EmptyHeader><EmptyMedia variant="icon"><MessagesSquare /></EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>;
}

type ContextProps = MessageContextScope & { conversation: ConversationDetail; messages: ConversationMessage[] };
function ConversationContext({ conversation, messages, ...scope }: ContextProps) {
  const { date: messageDate, timeZone } = useCompanySettings();
  const { sync, store } = conversation;
  return <div className="flex flex-col gap-5 p-5 text-sm">
    <MessageContext {...scope} conversationId={conversation.id} storeId={store.id} messages={messages} />
    <Separator />
    <div className="flex flex-col gap-2"><h3 className="font-medium">会话来源</h3><p>{store.name} · Ozon</p>
      {(store.status === 'disconnected' || store.status === 'paused' || !sync.enabled || sync.lastError) && <p className="text-xs text-destructive">{store.status === 'disconnected' ? '店铺已断开，当前显示已导入历史。' : store.status === 'paused' ? '店铺同步已暂停。' : sync.lastError ? '上次同步失败，当前已停止，请在店铺管理中重试。' : !sync.enabled ? '会话同步尚未启用。' : '同步遇到异常，请在店铺管理查看。'}</p>}
    </div>
    <details className="rounded-md border px-3 py-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">技术与同步信息</summary>
      <dl className="mt-3 flex flex-col gap-3">
        <div><dt className="text-muted-foreground">平台会话 ID</dt><dd className="mt-1 break-all">{conversation.platformThreadId}</dd></div>
        <div><dt className="text-muted-foreground">平台类型 / 状态</dt><dd className="mt-1 break-all">{conversation.platformType} / {conversation.platformStatus}</dd></div>
        <div><dt className="text-muted-foreground">平台创建时间</dt><dd className="mt-1">{messageDate(conversation.platformCreatedAt)}</dd></div>
        <div><dt className="text-muted-foreground">首次导入时间</dt><dd className="mt-1">{messageDate(conversation.importedAt)}</dd></div>
        <div><dt className="text-muted-foreground">历史读取</dt><dd className="mt-1">{sync.backfillComplete === true ? '已完成' : sync.backfillComplete === false ? '仍在读取' : '范围尚未确认'}</dd></div>
        <div><dt className="text-muted-foreground">最近成功读取</dt><dd className="mt-1">{messageDate(sync.lastSuccessAt)}</dd></div>
      </dl>
      <p className="mt-3 text-muted-foreground">时间按公司时区 {timeZone} 显示。</p>
    </details>
  </div>;
}

type TimelinePosition = { anchorId: string | null; view: number; onPosition: (view: number, atEnd: boolean, anchorId: string | null) => void };
function ReadingPosition({ anchorId, view, onPosition }: TimelinePosition) {
  const initialAnchor = useRef(anchorId);
  const [restoring, setRestoring] = useState(!!anchorId);
  const { scrollToMessage } = useMessageScroller(), scrollable = useMessageScrollerScrollable(), visibility = useMessageScrollerVisibility();
  const visible = visibility.visibleMessageIds.filter(id => id !== 'page-marker'), visibleKey = visible.join(',');
  useLayoutEffect(() => {
    if (!restoring || !initialAnchor.current || !scrollToMessage(initialAnchor.current, { align: 'start', behavior: 'instant' })) return;
    const frame = requestAnimationFrame(() => setRestoring(false)); return () => cancelAnimationFrame(frame);
  }, [restoring, scrollToMessage, visibleKey]);
  useEffect(() => { if (!restoring && visible.length) onPosition(view, !scrollable.end, visible[0]); }, [restoring, visibleKey, scrollable.end, view, onPosition]);
  return null;
}

export function MessageTimeline({ messages, pageKey, earlier, anchorId, view, onPosition }: { messages: ConversationMessage[]; pageKey: string; earlier: boolean } & TimelinePosition) {
  const { date: messageDate } = useCompanySettings();
  if (!messages.length) return <MessageEmpty title="暂无已导入消息" description="会话已发现，消息历史可能仍在读取。稍后刷新查看。" />;
  return <MessageScrollerProvider key={pageKey} autoScroll={!earlier} defaultScrollPosition={earlier ? 'start' : 'end'}>
    <MessageScroller className="bg-muted/20">
      <ReadingPosition anchorId={anchorId} view={view} onPosition={onPosition} />
      <MessageScrollerViewport aria-label="消息记录" role="region" tabIndex={0}>
        <MessageScrollerContent className="p-4 sm:p-6">
          <MessageScrollerItem messageId="page-marker"><Marker variant="separator"><MarkerContent>当前页 {messages.length} 条消息</MarkerContent></Marker></MessageScrollerItem>
          {messages.map(message => {
            const outbound = message.direction === 'outbound';
            const sender = outbound ? '商家' : message.direction === 'inbound' ? '买家' : '未知发送者';
            return <MessageScrollerItem key={message.id} messageId={message.id}>
              <Message align={outbound ? 'end' : 'start'}>
                <MessageContent>
                  <MessageHeader className="text-xs text-muted-foreground">{sender}</MessageHeader>
                  <Bubble variant={outbound ? 'secondary' : 'outline'} align={outbound ? 'end' : 'start'}>
                    <BubbleContent>
                      {message.isImage ? <Marker><MarkerIcon><ImageOff /></MarkerIcon><MarkerContent>图片消息暂不展示</MarkerContent></Marker> : message.content.length ? <p dir="auto" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content.join('\n')}</p> : <p>此消息没有可显示的文本。</p>}
                    </BubbleContent>
                  </Bubble>
                  <MessageFooter><time dateTime={message.eventAt} title={`导入时间：${messageDate(message.receivedAt)}；${message.ingestMode === 'backfill' ? '历史导入' : '增量导入'}`}>平台时间 {messageDate(message.eventAt)}</time></MessageFooter>
                </MessageContent>
              </Message>
            </MessageScrollerItem>;
          })}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton aria-label="跳到本页末尾"><ArrowDown /><span className="sr-only">跳到本页末尾</span></MessageScrollerButton>
    </MessageScroller>
  </MessageScrollerProvider>;
}

export function ConversationHeader({ conversation, messages, back, ...scope }: ContextProps & { back: () => void }) {
  const [open, setOpen] = useState(false);
  return <header className="flex shrink-0 items-center gap-3 border-b bg-background px-4 py-3">
    <Button variant="ghost" size="icon-sm" aria-label="返回会话列表" onClick={back} className="lg:hidden"><ArrowLeft /></Button>
    <div className="min-w-0 flex-1"><h2 className="truncate font-semibold" aria-label={`会话 ${conversation.platformThreadId}`}>买家咨询</h2><p className="mt-1 truncate text-xs text-muted-foreground">{conversation.store.name} · Ozon</p></div>
    <Sheet open={open} onOpenChange={setOpen}><SheetTrigger render={<Button variant="outline" size="icon-sm" aria-label="会话详情" />}><Info /></SheetTrigger><SheetContent className="w-full overflow-y-auto"><SheetHeader><SheetTitle>会话详情</SheetTitle><SheetDescription>查看商品、订单包裹、消息来源与同步范围。</SheetDescription></SheetHeader><ConversationContext {...scope} conversation={conversation} messages={messages} /></SheetContent></Sheet>
  </header>;
}

export function ConversationAside({ conversation, messages, ...scope }: ContextProps) {
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia('(min-width: 1440px)').matches, () => false);
  if (!wide) return null;
  return <aside aria-label="会话上下文" className="hidden w-64 shrink-0 overflow-y-auto border-l bg-background min-[1440px]:block"><h2 className="px-5 pt-5 font-medium">会话详情</h2><ConversationContext {...scope} conversation={conversation} messages={messages} /></aside>;
}

function subscribeWide(onChange: () => void) {
  const media = window.matchMedia('(min-width: 1440px)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
