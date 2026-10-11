import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowDown, Info, MessagesSquare, ImageOff } from 'lucide-react';
import type { ConversationDetail, ConversationMessage } from '../lib/conversations-api';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
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
    <div className="flex flex-col gap-2"><h3 className="font-medium">会话来源</h3><p>{store.name} · Ozon</p><dl className="flex flex-col gap-3 text-xs">
      <div><dt className="text-muted-foreground">平台会话 ID</dt><dd className="mt-1 break-all">{conversation.platformThreadId}</dd></div>
      <div><dt className="text-muted-foreground">平台原始类型 / 状态</dt><dd className="mt-1 break-all">{conversation.platformType} / {conversation.platformStatus}</dd></div>
      <div><dt className="text-muted-foreground">平台创建时间</dt><dd className="mt-1">{messageDate(conversation.platformCreatedAt)}</dd></div>
      <div><dt className="text-muted-foreground">首次导入时间</dt><dd className="mt-1">{messageDate(conversation.importedAt)}</dd></div>
    </dl></div>
    <Separator />
    <div className="flex flex-col gap-2"><h3 className="font-medium">同步范围</h3><p className="text-xs text-muted-foreground">{store.status === 'disconnected' ? '店铺已断开连接，保留已导入历史。' : store.status === 'paused' ? '店铺已暂停，保留已导入历史。' : sync.enabled ? '会话同步已启用。' : '会话同步未启用。'}</p>
      <p className="text-xs">{sync.backfillComplete === true ? '本次历史分页已读完' : sync.backfillComplete === false ? '历史消息仍在补拉' : '历史范围尚未确认'}</p>
      <p className="text-xs text-muted-foreground">最近成功读取：{messageDate(sync.lastSuccessAt)}</p>
      {sync.lastError && <p className="text-xs text-destructive">同步遇到异常，请在店铺管理查看原因。</p>}
      <p className="text-xs text-muted-foreground">这里只显示已导入记录；时间按公司时区 {timeZone} 显示。新记录持续补读，翻阅历史时可通过提示查看更新。</p>
    </div>
    <Separator />
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
    <MessageScroller>
      <ReadingPosition anchorId={anchorId} view={view} onPosition={onPosition} />
      <MessageScrollerViewport aria-label="消息记录" role="region" tabIndex={0}>
        <MessageScrollerContent className="p-4 sm:p-6">
          <MessageScrollerItem messageId="page-marker"><Marker variant="separator"><MarkerContent>平台原文 · 当前页 {messages.length} 条</MarkerContent></Marker></MessageScrollerItem>
          {messages.map(message => {
            const outbound = message.direction === 'outbound';
            const sender = outbound ? '商家' : message.direction === 'inbound' ? '买家' : '未知发送者';
            return <MessageScrollerItem key={message.id} messageId={message.id}>
              <Message align={outbound ? 'end' : 'start'}>
                <MessageContent>
                  <MessageHeader>{sender}</MessageHeader>
                  <Bubble variant={outbound ? 'secondary' : 'muted'} align={outbound ? 'end' : 'start'}>
                    <BubbleContent>
                      {message.isImage ? <Marker><MarkerIcon><ImageOff /></MarkerIcon><MarkerContent>图片消息暂不展示</MarkerContent></Marker> : message.content.length ? <p dir="auto" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content.join('\n')}</p> : <p>此消息没有可显示的文本。</p>}
                    </BubbleContent>
                  </Bubble>
                  <MessageFooter><div className="flex flex-col gap-1"><time dateTime={message.eventAt}>平台时间 {messageDate(message.eventAt)}</time><span title={`平台消息 ID：${message.platformMessageId}；发送者：${message.senderId ?? '未知'}（${message.senderType}）`}>导入 {messageDate(message.receivedAt)} · {message.ingestMode === 'backfill' ? '历史导入' : '增量导入'}</span></div></MessageFooter>
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
  return <header className="flex shrink-0 items-center gap-3 border-b p-4">
    <Button variant="ghost" size="icon-sm" aria-label="返回会话列表" onClick={back} className="md:hidden"><ArrowLeft /></Button>
    <div className="min-w-0 flex-1"><h2 className="truncate font-semibold" title={`会话 ${conversation.platformThreadId}`}>会话 {conversation.platformThreadId}</h2><p className="mt-1 truncate text-xs text-muted-foreground">{conversation.store.name} · Ozon · 使用平台原文</p></div>
    <Badge variant="outline" className="hidden sm:inline-flex">平台原文</Badge>
    <Sheet open={open} onOpenChange={setOpen}><SheetTrigger render={<Button variant="outline" size="icon-sm" aria-label="会话详情" />}><Info /></SheetTrigger><SheetContent className="w-full overflow-y-auto"><SheetHeader><SheetTitle>会话详情</SheetTitle><SheetDescription>查看商品、订单包裹、消息来源与同步范围。</SheetDescription></SheetHeader><ConversationContext {...scope} conversation={conversation} messages={messages} /></SheetContent></Sheet>
  </header>;
}

export function ConversationAside({ conversation, messages, ...scope }: ContextProps) {
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia('(min-width: 1440px)').matches, () => false);
  if (!wide) return null;
  return <aside aria-label="会话上下文" className="hidden w-68 shrink-0 overflow-y-auto border-l bg-muted/20 min-[1440px]:block"><h2 className="px-5 pt-5 font-medium">会话详情</h2><ConversationContext {...scope} conversation={conversation} messages={messages} /></aside>;
}

function subscribeWide(onChange: () => void) {
  const media = window.matchMedia('(min-width: 1440px)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
