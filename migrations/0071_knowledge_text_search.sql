-- Rebuildable lexical index. SQLite FTS5 supplies Unicode-aware trigram matching
-- and BM25 ranking; the live publication joins remain the authorization boundary.
CREATE VIRTUAL TABLE knowledge_text_search USING fts5(
  organization_id UNINDEXED,
  document_id UNINDEXED,
  revision UNINDEXED,
  chunk_id UNINDEXED,
  title,
  body,
  tokenize='trigram'
);
--> statement-breakpoint
INSERT INTO knowledge_text_search(organization_id,document_id,revision,chunk_id,title,body)
  SELECT chunk.organization_id,chunk.document_id,chunk.revision,chunk.id,revision.title,chunk.body
  FROM knowledge_chunk chunk JOIN knowledge_revision revision
    ON revision.organization_id=chunk.organization_id AND revision.document_id=chunk.document_id
    AND revision.revision=chunk.revision;
--> statement-breakpoint
CREATE TRIGGER knowledge_text_search_insert AFTER INSERT ON knowledge_chunk
BEGIN
  INSERT INTO knowledge_text_search(organization_id,document_id,revision,chunk_id,title,body)
    SELECT NEW.organization_id,NEW.document_id,NEW.revision,NEW.id,revision.title,NEW.body
    FROM knowledge_revision revision WHERE revision.organization_id=NEW.organization_id
      AND revision.document_id=NEW.document_id AND revision.revision=NEW.revision;
END;
--> statement-breakpoint
CREATE TRIGGER knowledge_text_search_delete AFTER DELETE ON knowledge_chunk
BEGIN
  DELETE FROM knowledge_text_search WHERE organization_id=OLD.organization_id AND chunk_id=OLD.id;
END;
