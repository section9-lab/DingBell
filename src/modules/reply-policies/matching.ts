import * as v from 'valibot';
import {aiScopeSchema} from '../conversations/ai-state.ts';
import {policyStageSchema,replyPolicyConfigSchema,type PolicyStage} from '../../shared/reply-policy.ts';
import type {ControlScope} from '../conversations/control-types.ts';
/** Only new admission selects priority. A running reply retains its admitted policy snapshot. */
export async function selectReplyPolicy(db:D1Database,scope:ControlScope,stage:PolicyStage){
 v.parse(aiScopeSchema,scope);v.parse(policyStageSchema,stage);
 const rows=(await db.prepare(`SELECT p.id,p.published_revision AS revision,pv.config FROM conversation_control cc
  JOIN conversation c ON c.id=cc.conversation_id AND c.organization_id=cc.organization_id AND c.store_id=cc.store_id
  JOIN store s ON s.id=c.store_id AND s.organization_id=c.organization_id
  JOIN reply_policy p ON p.organization_id=c.organization_id AND p.enabled=1 AND p.kind='automatic'
  JOIN policy_version pv ON pv.organization_id=p.organization_id AND pv.policy_id=p.id AND pv.revision=p.published_revision AND pv.schema_version=1
  WHERE cc.controller_id=? AND cc.organization_id=? AND cc.store_id=? AND cc.conversation_id=?
  AND s.status IN ('verified','partial','attention') AND c.platform_type='BUYER_SELLER' AND c.platform_status='Opened'
  AND EXISTS (SELECT 1 FROM json_each(pv.config,'$.storeIds') WHERE value=c.store_id)
  AND EXISTS (SELECT 1 FROM json_each(pv.config,'$.stages') WHERE value=?)
  ORDER BY json_extract(pv.config,'$.priority') DESC,p.id LIMIT 2`).bind(scope.controllerId,scope.organizationId,scope.storeId,scope.conversationId,stage).all<{id:string;revision:number;config:string}>()).results;
 try{
  const policies=rows.map(row=>({...row,config:v.parse(replyPolicyConfigSchema,JSON.parse(row.config))})),first=policies[0];
  if(!first||first.config.kind!=='automatic'||!first.config.storeIds.includes(scope.storeId)||!first.config.stages.includes(stage)||policies[1]?.config.priority===first.config.priority)return null;
  return {...first,config:first.config};
 }catch{return null;}
}
