import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ImageOff } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { orderStatusLabel, orderStatusRaw } from '../../shared/order-status';
import { ApiError } from '../lib/api';
import { readMessageContext } from '../lib/conversation-context-api';
import type { ConversationMessage } from '../lib/conversations-api';
import { workspaceRoutes } from '../lib/routes';
import { ErrorNotice } from './identity-shared';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { NativeSelect, NativeSelectOption } from './ui/native-select';

export type MessageContextScope = {
  companyId: string;
  viewerMemberId?: string;
  onDenied: (error: ApiError) => void;
};
type Props = MessageContextScope & {
  conversationId: string;
  storeId: string;
  messages: ConversationMessage[];
};
function ContextProductImage({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? (
    <img
      src={src}
      alt={alt}
      className="size-16 shrink-0 rounded-md border object-contain"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      className="flex size-16 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"
      role="img"
      aria-label={`${alt}，暂无图片`}
    >
      <ImageOff className="size-5" />
    </span>
  );
}

export function MessageContext({ messages, ...scope }: Props) {
  const [selected, setSelected] = useState(''),
    label = useId();
  const reference = (message: ConversationMessage) =>
    JSON.stringify([message.orderNumber, message.sku]);
  const unique = new Map<string, ConversationMessage>();
  for (const message of [...messages].reverse())
    if (message.orderNumber || message.sku) {
      const key = reference(message);
      if (!unique.has(key)) unique.set(key, message);
    }
  const choices = [...unique.values()],
    source = unique.get(selected) ?? choices[0];
  return (
    <section aria-label="商品与订单" className="flex min-w-0 flex-col gap-3">
      <h3 className="font-medium">商品与订单</h3>
      {!source ? (
        <p className="text-xs text-muted-foreground">当前显示的消息没有商品或订单信息。</p>
      ) : (
        <>
          {choices.length > 1 && (
            <NativeSelect
              id={label}
              aria-label="消息上下文"
              className="w-full min-w-0"
              value={source.id}
              onChange={(event) => {
                const message = choices.find((value) => value.id === event.target.value);
                if (message) setSelected(reference(message));
              }}
            >
              {choices.map((message) => (
                <NativeSelectOption key={message.id} value={message.id}>
                  {[
                    message.orderNumber ? `订单 ${message.orderNumber}` : '仅商品',
                    message.sku ? `SKU ${message.sku}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          {scope.viewerMemberId ? (
            <ContextDetails
              key={`${scope.companyId}:${scope.viewerMemberId}:${scope.conversationId}:${source.id}`}
              {...scope}
              viewerMemberId={scope.viewerMemberId}
              source={source}
            />
          ) : (
            <p role="status" className="text-xs">
              正在确认访问权限…
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ContextDetails({
  companyId,
  conversationId,
  storeId,
  viewerMemberId,
  source,
  onDenied,
}: Omit<Props, 'messages'> & { viewerMemberId: string; source: ConversationMessage }) {
  const query = useQuery({
    queryKey: ['message-context', companyId, viewerMemberId, storeId, conversationId, source.id],
    queryFn: ({ signal }) =>
      readMessageContext(
        companyId,
        conversationId,
        source,
        { storeId, viewerMemberId },
        undefined,
        signal,
      ),
    gcTime: 0,
    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (
      query.error instanceof ApiError &&
      ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED'].includes(query.error.code)
    )
      onDenied(query.error);
  }, [query.error, onDenied]);
  if (query.isError)
    return (
      <div className="flex flex-col gap-2">
        <ErrorNotice error={query.error} />
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          重新读取商品与订单
        </Button>
      </div>
    );
  if (!query.data)
    return (
      <p role="status" className="text-xs">
        正在读取商品与订单…
      </p>
    );
  const { product, order } = query.data,
    item = product.item,
    orderProduct = order.previewProduct;
  const productName = item?.name ?? orderProduct?.name ?? null;
  const offerId = item?.offerId ?? orderProduct?.offerId ?? null;
  const sku = orderProduct?.sku ?? source.sku;
  const price =
    item?.price !== null && item?.price !== undefined
      ? `${item.price} ${item.currency ?? ''}`.trim()
      : null;
  const productHref = item
    ? `${workspaceRoutes.products}?store=${encodeURIComponent(storeId)}&product=${encodeURIComponent(item.id)}`
    : orderProduct?.productId
      ? `${workspaceRoutes.products}?store=${encodeURIComponent(storeId)}&product=${encodeURIComponent(orderProduct.productId)}`
      : null;
  const orderHref = (posting: { postingNumber: string; fulfillmentType: string }) =>
    `${workspaceRoutes.orders}?${new URLSearchParams({ store: storeId, posting: posting.postingNumber, type: posting.fulfillmentType })}`;
  const visiblePostings = order.postings.slice(0, 3);
  return (
    <div className="flex min-w-0 flex-col gap-3 text-xs [overflow-wrap:anywhere]">
      <div className="rounded-lg border bg-background p-3">
        {item || orderProduct ? (
          <div className="flex min-w-0 gap-3">
            <ContextProductImage
              src={item?.primaryImage ?? orderProduct?.primaryImage ?? null}
              alt={productName ?? `商品 ${offerId ?? source.sku ?? ''}`}
            />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="line-clamp-2 text-sm font-medium">
                {productName ?? '商品名称尚未提供'}
              </p>
              {(offerId || sku) && (
                <p className="truncate text-muted-foreground">
                  {offerId ? `货号 ${offerId}` : ''}
                  {offerId && sku ? ' · ' : ''}
                  {sku ? `SKU ${sku}` : ''}
                </p>
              )}
              {price && <p>{price}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {productHref && (
                  <Link className="font-medium underline-offset-4 hover:underline" to={productHref}>
                    查看商品
                  </Link>
                )}
                {!item && orderProduct && (
                  <Badge variant="outline" className="text-[10px]">
                    订单预览
                  </Badge>
                )}
                {item?.archived === true && (
                  <Badge variant="outline" className="text-[10px]">
                    已归档
                  </Badge>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground">
            {product.state === 'not_provided'
              ? source.orderNumber
                ? '当前快照没有匹配到商品'
                : '消息未携带商品或订单号'
              : product.state === 'ambiguous'
                ? '商品匹配不唯一'
                : '商品详情尚未导入'}
          </p>
        )}
      </div>

      <div className="rounded-lg border bg-background p-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-medium">订单</h4>
          {source.orderNumber && (
            <span className="truncate text-muted-foreground">{source.orderNumber}</span>
          )}
        </div>
        {order.state !== 'matched' ? (
          <p className="mt-2 text-muted-foreground">
            {order.state === 'not_provided'
              ? '这条消息没有携带订单号。'
              : order.state === 'ambiguous'
                ? '同一订单号对应多个订单，暂不展示包裹。'
                : '消息包含订单号，但当前 FBS / FBO / FBP 快照中未找到对应订单；它可能尚未进入同步范围。'}
          </p>
        ) : (
          <>
            {visiblePostings.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1.5">
                {visiblePostings.map((posting) => (
                  <Link
                    key={`${posting.fulfillmentType}:${posting.postingNumber}`}
                    to={orderHref(posting)}
                    aria-label={`查看包裹 ${posting.postingNumber} 的订单详情`}
                    className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs hover:bg-muted"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{posting.postingNumber}</span>
                      <span className="block truncate text-muted-foreground">
                        {posting.fulfillmentType.toUpperCase()} ·{' '}
                        <span title={orderStatusRaw(posting)}>
                          {orderStatusLabel(posting, '尚未提供')}
                        </span>
                        {posting.trackingNumber ? ` · ${posting.trackingNumber}` : ''}
                      </span>
                    </span>
                    <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
                  </Link>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-muted-foreground">暂无已导入的包裹。</p>
            )}
            {order.nextPosting && (
              <Link
                to={
                  source.orderNumber
                    ? `${workspaceRoutes.orders}?${new URLSearchParams({ store: storeId, order: source.orderNumber })}`
                    : `${workspaceRoutes.orders}?${new URLSearchParams({ store: storeId })}`
                }
                className="mt-2 inline-block text-muted-foreground underline-offset-4 hover:underline"
              >
                更多包裹在订单中心查看
              </Link>
            )}
          </>
        )}
      </div>
    </div>
  );
}
