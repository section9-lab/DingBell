/** Platform business timestamps, never local observation/sync timestamps. */
export const orderTimeSourceLabels = {
  order_date: '下单时间',
  created_at: '创建时间',
  in_process_at: '开始处理时间',
} as const;
export type OrderTimeSource = keyof typeof orderTimeSourceLabels;
