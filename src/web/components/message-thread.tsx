import { ArrowDown, ArrowLeft, Info, MessagesSquare } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import type { ConversationDetail, ConversationMessage } from '../lib/conversations-api';
import { useCompanySettings } from './company-settings-provider';
import { MessageContext, type MessageContextScope } from './message-context';
import { MessageImages } from './message-images';
import { Bubble, BubbleContent } from './ui/bubble';
import { Button } from './ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty';
import { Marker, MarkerContent } from './ui/marker';
import { Message, MessageContent, MessageFooter, MessageHeader } from './ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from './ui/message-scroller';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet';

export function MessageEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessagesSquare />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

type ContextProps = MessageContextScope & {
  conversation: ConversationDetail;
  messages: ConversationMessage[];
};
function ConversationContext({ conversation, messages, ...scope }: ContextProps) {
  return (
    <div className="p-5">
      <MessageContext
        {...scope}
        conversationId={conversation.id}
        storeId={conversation.store.id}
        messages={messages}
      />
    </div>
  );
}

export function MessageTimeline({
  companyId,
  conversationId,
  messages,
  pageKey,
}: {
  companyId: string;
  conversationId: string;
  messages: ConversationMessage[];
  pageKey: string;
}) {
  const { date: messageDate } = useCompanySettings();
  if (!messages.length)
    return (
      <MessageEmpty
        title="暂无已导入消息"
        description="会话已发现，消息历史可能仍在读取。稍后刷新查看。"
      />
    );
  return (
    <MessageScrollerProvider key={pageKey} autoScroll defaultScrollPosition="end">
      <MessageScroller>
        <MessageScrollerViewport aria-label="消息记录" role="region" tabIndex={0}>
          <MessageScrollerContent className="p-4 sm:p-6">
            <MessageScrollerItem messageId="page-marker">
              <Marker variant="separator">
                <MarkerContent>共 {messages.length} 条消息</MarkerContent>
              </Marker>
            </MessageScrollerItem>
            {messages.map((message) => {
              const outbound = message.direction === 'outbound';
              const sender = outbound
                ? '商家'
                : message.direction === 'inbound'
                  ? '买家'
                  : '未知发送者';
              // Fully lay out every message: content-visibility's intrinsic-size cache resets
              // across Activity hide/show and moves the reader.
              return (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  className="[content-visibility:visible]"
                >
                  <Message align={outbound ? 'end' : 'start'}>
                    <MessageContent>
                      <MessageHeader className="text-xs text-muted-foreground">
                        {sender}
                      </MessageHeader>
                      <Bubble
                        variant={outbound ? 'secondary' : 'outline'}
                        align={outbound ? 'end' : 'start'}
                      >
                        <BubbleContent>
                          {message.isImage ? (
                            <MessageImages
                              companyId={companyId}
                              conversationId={conversationId}
                              messageId={message.id}
                              content={message.content}
                            />
                          ) : message.content.length ? (
                            <p
                              dir="auto"
                              className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                            >
                              {message.content.join('\n')}
                            </p>
                          ) : (
                            <p>此消息没有可显示的文本。</p>
                          )}
                        </BubbleContent>
                      </Bubble>
                      <MessageFooter>
                        <time
                          dateTime={message.eventAt}
                          title={`导入时间：${messageDate(message.receivedAt)}；${message.ingestMode === 'backfill' ? '历史导入' : '增量导入'}`}
                        >
                          平台时间 {messageDate(message.eventAt)}
                        </time>
                        <span aria-hidden="true" className="px-1.5">
                          ·
                        </span>
                        <span
                          title="平台返回的 is_read 标记，只表示平台侧这条消息的已读状态，不代表本系统内的阅读记录"
                          className={message.isRead ? undefined : 'text-foreground'}
                        >
                          {message.isRead ? '平台已读' : '平台未读'}
                        </span>
                      </MessageFooter>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton aria-label="跳到最新消息">
          <ArrowDown />
          <span className="sr-only">跳到最新消息</span>
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

export function ConversationHeader({
  conversation,
  messages,
  back,
  ...scope
}: ContextProps & { back: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="返回会话列表"
        onClick={back}
        className="lg:hidden"
      >
        <ArrowLeft />
      </Button>
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-semibold" aria-label={`会话 ${conversation.platformThreadId}`}>
          买家咨询
        </h2>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {conversation.store.name} · Ozon
        </p>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger render={<Button variant="outline" size="icon-sm" aria-label="会话详情" />}>
          <Info />
        </SheetTrigger>
        <SheetContent className="w-full overflow-y-auto">
          <SheetHeader>
            <SheetTitle>会话详情</SheetTitle>
            <SheetDescription>查看商品与订单摘要。</SheetDescription>
          </SheetHeader>
          <ConversationContext {...scope} conversation={conversation} messages={messages} />
        </SheetContent>
      </Sheet>
    </header>
  );
}

export function ConversationAside({ conversation, messages, ...scope }: ContextProps) {
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia('(min-width: 1440px)').matches,
    () => false,
  );
  if (!wide) return null;
  return (
    <aside
      aria-label="会话上下文"
      className="hidden w-64 shrink-0 overflow-y-auto min-[1440px]:block"
    >
      <h2 className="px-5 pt-5 font-medium">会话详情</h2>
      <ConversationContext {...scope} conversation={conversation} messages={messages} />
    </aside>
  );
}

function subscribeWide(onChange: () => void) {
  const media = window.matchMedia('(min-width: 1440px)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
