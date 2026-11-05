DROP TRIGGER message_update_immutable;--> statement-breakpoint
-- 消息仍然不可变，唯一例外是 'sent:' 占位行：这是本工作区发送成功后的本地回显，
-- 聊天同步拿到平台返回的同一条消息时，需要把真实平台 id 与平台权威字段补进这一行。
-- 平台来源的消息（非 sent: 前缀）继续被完全锁死。
CREATE TRIGGER message_update_immutable BEFORE UPDATE ON message
WHEN OLD.platform_message_id NOT LIKE 'sent:%' AND (
  OLD.id IS NOT NEW.id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.store_id IS NOT NEW.store_id
  OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.platform_message_id IS NOT NEW.platform_message_id
  OR OLD.content IS NOT NEW.content OR OLD.sender_id IS NOT NEW.sender_id OR OLD.sender_type IS NOT NEW.sender_type
  OR OLD.direction IS NOT NEW.direction OR OLD.event_at IS NOT NEW.event_at OR OLD.is_image IS NOT NEW.is_image
  OR OLD.ingest_mode IS NOT NEW.ingest_mode OR OLD.received_at IS NOT NEW.received_at)
BEGIN SELECT RAISE(ABORT,'MESSAGE_IMMUTABLE'); END;
