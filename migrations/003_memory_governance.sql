ALTER TABLE memories DROP CONSTRAINT memories_status_check;
ALTER TABLE memories ADD CONSTRAINT memories_status_check CHECK (status IN ('active','inactive','pending','rejected','superseded','archived'));
ALTER TABLE memories ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE memories ADD COLUMN original_content text;
ALTER TABLE memories ADD COLUMN change_type text NOT NULL DEFAULT 'migration';
ALTER TABLE memories ADD COLUMN change_reason text;
ALTER TABLE memories ADD COLUMN archived_from text;

UPDATE memories SET original_content=content, metadata=jsonb_build_object(
  'visibility',CASE WHEN origin_kind='automatic' AND status='pending' THEN 'private' ELSE 'public' END,
  'knownByKinIds',jsonb_build_array(kin_id),'knownAt',created_at,
  'memoryType',CASE WHEN category IN ('villa_event','challenge_outcome') THEN 'event' ELSE 'fact' END,
  'statementType',CASE WHEN origin_kind='automatic' THEN 'reported_speech' ELSE 'claim' END,
  'sourceType',CASE WHEN origin_kind='automatic' THEN 'auto_extracted' ELSE 'manual' END,
  'domain','continuity','pinned',importance=5,'authoritative',false);
ALTER TABLE memories ALTER COLUMN original_content SET NOT NULL;

CREATE TABLE memory_revisions (
  id bigserial PRIMARY KEY, memory_id uuid NOT NULL REFERENCES memories(id),
  snapshot jsonb NOT NULL, actor_id text NOT NULL, operation text NOT NULL,
  reason text, recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_revisions_memory_idx ON memory_revisions(memory_id,id DESC);
CREATE TABLE memory_audit (
  id bigserial PRIMARY KEY, memory_id uuid REFERENCES memories(id),
  kin_id text NOT NULL, storyline text, guild_id text, context_id text, context_type text,
  operation text NOT NULL, actor_id text NOT NULL, reason text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memory_aliases (
  kin_id text NOT NULL REFERENCES memory_kins(id), storyline text NOT NULL, guild_id text NOT NULL,
  alias text NOT NULL, subject_id text NOT NULL, approved_by text NOT NULL,
  PRIMARY KEY(kin_id,storyline,guild_id,alias)
);
CREATE TABLE memory_binding_history (
  id bigserial PRIMARY KEY, kin_id text NOT NULL, old_bot_id text NOT NULL, new_bot_id text NOT NULL,
  actor_id text NOT NULL, reason text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION memory_metadata_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.original_content:=NEW.content;
    NEW.metadata:=jsonb_build_object('visibility','public','knownByKinIds',jsonb_build_array(NEW.kin_id),
      'knownAt',now(),'memoryType','fact','statementType','claim','sourceType','manual',
      'domain','continuity','pinned',false,'authoritative',false) || NEW.metadata;
  ELSE
    NEW.original_content:=OLD.original_content;
  END IF;
  IF NOT COALESCE(NEW.metadata->>'visibility'=ANY(ARRAY['public','private','confessional','production']),false)
    OR NOT COALESCE(NEW.metadata->>'memoryType'=ANY(ARRAY['event','state','fact','preference','relationship','belief']),false)
    OR NOT COALESCE(NEW.metadata->>'statementType'=ANY(ARRAY['fact','belief','suspicion','claim','interpretation','reported_speech']),false)
    OR NOT COALESCE(NEW.metadata->>'sourceType'=ANY(ARRAY['manual','auto_extracted','discord_import','kindroid_export','production_override']),false)
    OR NOT COALESCE(NEW.metadata->>'domain'=ANY(ARRAY['identity','continuity']),false)
    OR jsonb_typeof(NEW.metadata->'knownByKinIds') IS DISTINCT FROM 'array'
    OR (NEW.metadata->>'visibility'<>'production' AND NOT (NEW.metadata->'knownByKinIds' ? NEW.kin_id))
    OR jsonb_array_length(NEW.metadata->'knownByKinIds')>20
    OR jsonb_typeof(NEW.metadata->'pinned') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(NEW.metadata->'authoritative') IS DISTINCT FROM 'boolean'
    OR NEW.metadata->>'knownAt' IS NULL THEN
    RAISE EXCEPTION 'Invalid memory governance metadata';
  END IF;
  PERFORM (NEW.metadata->>'knownAt')::timestamptz;
  IF NEW.metadata->>'expiresAt' IS NOT NULL THEN
    PERFORM (NEW.metadata->>'expiresAt')::timestamptz;
    IF NEW.metadata->>'memoryType'='event' THEN RAISE EXCEPTION 'Historical events cannot expire'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_metadata_guard BEFORE INSERT OR UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION memory_metadata_guard();

CREATE FUNCTION memory_record_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO memory_revisions(memory_id,snapshot,actor_id,operation,reason)
    VALUES(NEW.id,to_jsonb(NEW),NEW.updated_by,NEW.change_type,NEW.change_reason);
  INSERT INTO memory_audit(memory_id,kin_id,storyline,guild_id,context_id,context_type,operation,actor_id,reason)
    VALUES(NEW.id,NEW.kin_id,NEW.storyline,NEW.guild_id,NEW.context_id,NEW.context_type,NEW.change_type,NEW.updated_by,NEW.change_reason);
  RETURN NEW;
END $$;
CREATE TRIGGER memory_record_revision AFTER INSERT OR UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION memory_record_revision();
INSERT INTO memory_revisions(memory_id,snapshot,actor_id,operation)
  SELECT id,to_jsonb(memories),updated_by,'migration' FROM memories;

CREATE FUNCTION memory_eligible(meta jsonb, kin text, visibility text, at_time timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT visibility <> 'production' AND meta->>'visibility' <> 'production'
    AND (meta->'knownByKinIds' ? kin) AND (meta->>'knownAt')::timestamptz <= at_time
    AND ((meta->>'expiresAt') IS NULL OR (meta->>'expiresAt')::timestamptz > at_time)
    AND (meta->>'visibility'='public' OR meta->>'visibility'=visibility)
$$;
CREATE INDEX memories_fact_key_idx ON memories(kin_id,storyline,guild_id,context_id,context_type,(metadata->>'factKey')) WHERE status='active';
