import * as v from 'valibot';
import { NOW_MS_WHOLE_SECONDS } from '../../platform/database/sql.ts';
import { replyPolicyConfigSchema, type ReplyPolicyConfig } from '../../shared/reply-policy.ts';

/**
 * Pre-installed reply policies.
 *
 * 一条策略只服务一个阶段，所以三个阶段各一条；优先级 60/50/40 让它们以后被编辑、扩大店铺
 * 范围时也不会撞上同优先级重叠校验。文案只写表达要求：事实与店铺政策属于知识库，编造与
 * 证据要求已由系统提示词强制（见 ai-runs/policy.ts）。
 */
type Preset = { id: string; config: Extract<ReplyPolicyConfig, { kind: 'automatic' }> };
export const presetPolicies: readonly Preset[] = [
  {
    id: '5f2b6c1d-4a3e-4b7c-8f10-2d9e4c6a7b31',
    config: {
      kind: 'automatic', name: '售前 · 商品咨询', storeIds: [], priority: 60, stage: 'presale',
      mode: 'automatic', language: 'customer', tone: 'concise',
      instructions: '1) 先用一句话直接回答消费者问的那一点，不要先寒暄、不要先复述问题。\n2) 最多再补两条必要信息（适用场景、注意事项），整段不超过三句话。\n3) 消费者提到型号、尺码或配件时，先在回复里复述你确认到的型号，再给结论。\n4) 资料不足时只问一个最关键的问题（型号或使用场景），不要一次问多个。\n5) 消费者没有主动询问时，不推荐替代商品、不引导加购。',
    },
  },
  {
    id: '8a4c7d2e-5b6f-4c8d-9a21-3e5f7b9c1d42',
    config: {
      kind: 'automatic', name: '售中 · 物流进度', storeIds: [], priority: 50, stage: 'order',
      mode: 'automatic', language: 'customer', tone: 'concise',
      instructions: '1) 回复顺序固定：先给这笔订单的当前状态，再给系统已确认的时间信息，最后一句说接下来会发生什么。\n2) 只描述系统给出的状态，不自行推断物流节点，也不承诺到达日期。\n3) 消费者问的是另一笔订单、或要求改地址或改收件人时，说明这里只能处理当前会话的这笔订单，建议在订单页自行查看或转人工。\n4) 系统没有给出快递单号和收件地址时，不主动报出。',
    },
  },
  {
    id: 'c1d3e5f7-6a2b-4c3d-8e4f-5a6b7c8d9e03',
    config: {
      kind: 'automatic', name: '售后 · 退换与使用', storeIds: [], priority: 40, stage: 'aftersale',
      mode: 'automatic', language: 'customer', tone: 'friendly',
      instructions: '1) 先用一句话表示理解，不复述消费者的抱怨细节，也不加感叹号。\n2) 给出消费者现在就能做的一步；这一步必须来自知识库，没有依据时直接说明需要人工确认。\n3) 涉及退款、补发、折扣或赔偿，只说需要人工确认，不给金额、时效或承诺。\n4) 同一问题被追问两次以上，或消费者明确表示不满升级，直接建议转人工，不再解释流程。',
    },
  },
];

for (const preset of presetPolicies) v.parse(replyPolicyConfigSchema, preset.config);

/**
 * 幂等种入预置策略：已启用策略已经覆盖某个阶段时跳过该阶段，同一 ID 重复调用不会新建。
 * 预置策略以「已发布 + 已启用」插入，发布快照由 reply_policy_insert_snapshot 触发器写入。
 */
export async function seedPresetPolicies(db: D1Database, organizationId: string, actorUserId: string, requestId: string) {
  const zone = (await db.prepare("SELECT COALESCE((SELECT time_zone FROM company_settings WHERE organization_id=?),'UTC') AS zone")
    .bind(organizationId).first<{ zone: string }>())?.zone ?? 'UTC';
  const created: string[] = [];
  for (const { id, config } of presetPolicies) {
    const row = await db.prepare(`INSERT INTO reply_policy
    (organization_id,id,kind,version,draft_revision,tested_revision,tested_time_zone,draft_base_revision,published_revision,
     enabled,published_by,published_at,published_request_id,published_time_zone,draft_config,updated_at)
    SELECT ?,?,'automatic',1,1,1,?,1,1,1,?,${NOW_MS_WHOLE_SECONDS},?,?,?,${NOW_MS_WHOLE_SECONDS}
    WHERE NOT EXISTS (SELECT 1 FROM reply_policy active JOIN policy_version current
      ON current.organization_id=active.organization_id AND current.policy_id=active.id AND current.revision=active.published_revision
      WHERE active.organization_id=? AND active.enabled=1 AND active.kind='automatic' AND json_extract(current.config,'$.stage')=?)
    ON CONFLICT(organization_id,id) DO NOTHING RETURNING id`)
      .bind(organizationId, id, zone, actorUserId, requestId, zone, JSON.stringify(config), organizationId, config.stage)
      .first<{ id: string }>();
    if (row) created.push(row.id);
  }
  return created;
}
