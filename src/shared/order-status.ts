// Ozon posting statuses as returned by the read APIs. The web layer only ever shows the
// Chinese label; the raw platform value stays available for support and hover hints.
const statusLabels: Record<string, string> = {
  acceptance_in_progress: '正在验收',
  arbitration: '平台仲裁中',
  awaiting_approve: '等待平台确认',
  awaiting_deliver: '等待装运',
  awaiting_packaging: '等待打包',
  awaiting_registration: '等待登记',
  awaiting_verification: '已创建',
  cancelled: '已取消',
  cancelled_from_split_pending: '拆分中待取消',
  client_arbitration: '买家仲裁中',
  delivered: '已送达',
  delivering: '配送中',
  driver_pickup: '司机已取件',
  not_accepted: '分拣中心未接收',
  sent_by_seller: '卖家已发货',
};

const substatusLabels: Record<string, string> = {
  posting_acceptance_in_progress: '正在验收',
  posting_awaiting_passport_data: '等待证件资料',
  posting_awaiting_registration: '等待登记',
  posting_canceled: '已取消',
  posting_conditionally_delivered: '临时送达',
  posting_created: '已创建',
  posting_delivered: '已送达',
  posting_driver_pick_up: '司机已取件',
  posting_in_arbitration: '仲裁中',
  posting_in_carriage: '运输途中',
  posting_in_client_arbitration: '买家仲裁中',
  posting_in_courier_service: '快递员配送中',
  posting_in_pickup_point: '已在取货点',
  posting_not_in_carriage: '未在运输中',
  posting_not_in_sort_center: '分拣中心未收到',
  posting_on_way_to_city: '发往城市途中',
  posting_on_way_to_pickup_point: '发往取货点',
  posting_received: '已签收',
  posting_registered: '已登记',
  posting_registration_error: '登记失败',
  posting_returned_to_warehouse: '退回仓库',
  posting_split_pending: '拆分处理中',
  posting_transferred_to_courier_service: '已转交快递',
  posting_transferring_to_delivery: '转交配送',
  sent_by_seller: '卖家已发货',
};

// FBP details return a numeric status plus a substatus name; the codes below were read from
// 601 synced FBP parcels where both always agreed. An unseen code falls back to the substatus,
// so a new code still shows readable Chinese instead of a bare number.
const statusCodeLabels: Record<string, string> = {
  '300': '等待打包',
  '380': '已送达',
  '390': '已取消',
  '3050': '配送中',
  '3090': '配送中',
  '3308': '等待装运',
};

export type PostingStatusInput = { status: string | null | undefined; statusIsCode?: boolean | null; substatus?: string | null | undefined };

function normalize(value: string) { return value.trim().toLowerCase(); }
// Numeric statuses are FBP codes even when the stored row predates the statusIsCode flag.
function isCode(status: string, statusIsCode: boolean) { return statusIsCode || /^\d+$/.test(status); }
// null means "no Chinese wording for this value", so callers can decide whether to show it raw.
function substatusText(substatus: string | null | undefined): string | null {
  const raw = substatus?.trim();
  if (!raw) return null;
  const key = normalize(raw);
  return substatusLabels[key] ?? statusLabels[key] ?? null;
}

/** Platform status in Chinese; a numeric FBP code resolves through the code table, then the substatus. */
export function orderStatusLabel(posting: PostingStatusInput, fallback = '等待详情'): string {
  const raw = posting.status?.trim();
  if (!raw) return fallback;
  if (!isCode(raw, posting.statusIsCode === true)) return statusLabels[normalize(raw)] ?? raw;
  return statusCodeLabels[raw] ?? substatusText(posting.substatus) ?? `未识别状态（平台码 ${raw}）`;
}

/** Platform substatus in Chinese; an FBP substatus shares the plain status vocabulary. */
export function orderSubstatusLabel(substatus: string | null | undefined): string | null {
  const raw = substatus?.trim();
  if (!raw) return null;
  return substatusText(raw) ?? raw;
}

/** Original platform value, used as a hover hint so operators can cross-check Ozon. */
export function orderStatusRaw(posting: PostingStatusInput): string | undefined {
  const raw = posting.status?.trim();
  if (!raw) return undefined;
  if (!isCode(raw, posting.statusIsCode === true)) return raw;
  const substatus = posting.substatus?.trim();
  return substatus ? `平台状态码 ${raw} · 子状态 ${substatus}` : `平台状态码 ${raw}`;
}
