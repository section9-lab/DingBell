CREATE TABLE `message_append` (
	`conversation_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`message_id` text NOT NULL,
	`sequence` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `sequence`),
	FOREIGN KEY (`message_id`,`organization_id`,`store_id`,`conversation_id`) REFERENCES `message`(`id`,`organization_id`,`store_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_append_sequence_valid" CHECK(typeof("message_append"."sequence")='integer' AND "message_append"."sequence" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_append_message_unique` ON `message_append` (`message_id`);--> statement-breakpoint
ALTER TABLE `conversation` ADD `message_sequence` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Preserve original message rows; only assign a deterministic initial append order.
INSERT INTO message_append(conversation_id,organization_id,store_id,message_id,sequence)
SELECT conversation_id,organization_id,store_id,id,
  ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY received_at,event_at,id)
FROM message;
--> statement-breakpoint
UPDATE conversation SET message_sequence=COALESCE((
  SELECT MAX(sequence) FROM message_append WHERE message_append.conversation_id=conversation.id
),0);
--> statement-breakpoint
CREATE TRIGGER conversation_message_sequence_insert BEFORE INSERT ON conversation
WHEN typeof(NEW.message_sequence)<>'integer' OR NEW.message_sequence<>0
BEGIN SELECT RAISE(ABORT,'MESSAGE_SEQUENCE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_message_sequence_update BEFORE UPDATE OF message_sequence ON conversation
WHEN typeof(OLD.message_sequence)<>'integer' OR typeof(NEW.message_sequence)<>'integer'
  OR OLD.message_sequence NOT BETWEEN 0 AND 9007199254740991 OR NEW.message_sequence NOT BETWEEN 0 AND 9007199254740991
  OR (NEW.message_sequence<>OLD.message_sequence AND NEW.message_sequence<>OLD.message_sequence+1)
BEGIN SELECT RAISE(ABORT,'MESSAGE_SEQUENCE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER message_append_insert_guard BEFORE INSERT ON message_append
WHEN EXISTS (SELECT 1 FROM message_append WHERE message_id=NEW.message_id OR (conversation_id=NEW.conversation_id AND sequence=NEW.sequence))
  OR NOT EXISTS (SELECT 1 FROM conversation JOIN message ON message.conversation_id=conversation.id
    AND message.organization_id=conversation.organization_id AND message.store_id=conversation.store_id
    WHERE message.id=NEW.message_id AND conversation.id=NEW.conversation_id AND conversation.organization_id=NEW.organization_id
      AND conversation.store_id=NEW.store_id AND conversation.message_sequence=NEW.sequence)
BEGIN SELECT RAISE(ABORT,'MESSAGE_APPEND_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER message_append_update_guard BEFORE UPDATE ON message_append
BEGIN SELECT RAISE(ABORT,'MESSAGE_APPEND_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER message_append_delete_guard BEFORE DELETE ON message_append
WHEN EXISTS (SELECT 1 FROM message WHERE id=OLD.message_id)
BEGIN SELECT RAISE(ABORT,'MESSAGE_APPEND_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER message_append_after_insert AFTER INSERT ON message
BEGIN
  UPDATE conversation SET message_sequence=message_sequence+1 WHERE id=NEW.conversation_id
    AND organization_id=NEW.organization_id AND store_id=NEW.store_id;
  INSERT INTO message_append(conversation_id,organization_id,store_id,message_id,sequence)
  SELECT NEW.conversation_id,NEW.organization_id,NEW.store_id,NEW.id,message_sequence FROM conversation
  WHERE id=NEW.conversation_id AND organization_id=NEW.organization_id AND store_id=NEW.store_id;
END;
