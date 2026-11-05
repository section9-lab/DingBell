/** A detected immutable platform-fact conflict cannot silently authorize an AI response from stale text. */
export function noPushMessageReview(alias:'conversation'|'m'|'c'){
 const conversationId=alias==='m'?'m.conversation_id':`${alias}.id`;
 return `NOT EXISTS(SELECT 1 FROM ozon_push_event AS conflict WHERE conflict.organization_id=${alias}.organization_id AND conflict.store_id=${alias}.store_id AND conflict.requires_review=1
  AND json_extract(conflict.hint,'$.chatId')=(SELECT platform_thread_id FROM conversation AS thread WHERE thread.id=${conversationId} AND thread.organization_id=${alias}.organization_id AND thread.store_id=${alias}.store_id))`;
}

/** First-page Ozon history is authoritative even when timestamps tie or delivery is out of order. */
export function latestCanonicalInput(){
 const scope='head.organization_id=m.organization_id AND head.store_id=m.store_id AND head.conversation_id=m.conversation_id';
 return `(EXISTS(SELECT 1 FROM ozon_push_chat_head AS head WHERE ${scope} AND head.message_id=m.id)
  OR (NOT EXISTS(SELECT 1 FROM ozon_push_chat_head AS head WHERE ${scope})
   AND NOT EXISTS(SELECT 1 FROM message newer WHERE newer.organization_id=m.organization_id AND newer.store_id=m.store_id AND newer.conversation_id=m.conversation_id
    AND newer.direction='inbound' AND newer.ingest_mode='incremental' AND (newer.event_at>m.event_at OR (newer.event_at=m.event_at AND newer.id>m.id)))))`;
}
