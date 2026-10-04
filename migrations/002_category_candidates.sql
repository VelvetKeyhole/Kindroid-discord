-- Preserve existing records as exact-channel contexts.
ALTER TABLE memories DROP CONSTRAINT memories_kin_id_storyline_guild_id_channel_id_fkey;
ALTER TABLE memory_contexts RENAME COLUMN channel_id TO context_id;
ALTER TABLE memories RENAME COLUMN channel_id TO context_id;
ALTER TABLE memory_contexts ADD COLUMN context_type text NOT NULL DEFAULT 'channel'
  CHECK (context_type IN ('channel', 'category'));
ALTER TABLE memories ADD COLUMN context_type text NOT NULL DEFAULT 'channel'
  CHECK (context_type IN ('channel', 'category'));
ALTER TABLE memory_contexts DROP CONSTRAINT memory_contexts_pkey;
ALTER TABLE memory_contexts ADD PRIMARY KEY (kin_id, storyline, guild_id, context_id, context_type);
ALTER TABLE memories ADD FOREIGN KEY (kin_id, storyline, guild_id, context_id, context_type)
  REFERENCES memory_contexts (kin_id, storyline, guild_id, context_id, context_type);
ALTER TABLE memory_contexts ADD COLUMN auto_enabled boolean;

ALTER TABLE memories ADD COLUMN status text NOT NULL DEFAULT 'active';
UPDATE memories SET status = CASE WHEN active THEN 'active' ELSE 'inactive' END;
ALTER TABLE memories ADD CONSTRAINT memories_status_check
  CHECK (status IN ('active', 'inactive', 'pending', 'rejected', 'superseded'));
ALTER TABLE memories ADD CONSTRAINT memories_active_status_check CHECK (active = (status = 'active'));
ALTER TABLE memories ADD COLUMN origin_kind text NOT NULL DEFAULT 'manual' CHECK (origin_kind IN ('manual', 'automatic'));
ALTER TABLE memories ADD COLUMN candidate_importance integer CHECK (candidate_importance BETWEEN 1 AND 10);
ALTER TABLE memories ADD COLUMN confidence double precision CHECK (confidence BETWEEN 0 AND 1);
ALTER TABLE memories ADD COLUMN subjects text[] NOT NULL DEFAULT '{}' CHECK (cardinality(subjects) <= 10);
ALTER TABLE memories ADD COLUMN source_channel_id text;
UPDATE memories SET source_channel_id = context_id;
ALTER TABLE memories ADD COLUMN occurred_at timestamptz;
UPDATE memories SET occurred_at = created_at;
ALTER TABLE memories ADD COLUMN source_message_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_message_ids) <= 8);
ALTER TABLE memories ADD COLUMN fingerprint text;
ALTER TABLE memories ADD COLUMN reviewed_by text;
ALTER TABLE memories ADD COLUMN reviewed_at timestamptz;
ALTER TABLE memories ADD COLUMN supersedes_id uuid REFERENCES memories(id) ON DELETE SET NULL;
ALTER TABLE memories DROP CONSTRAINT memories_category_check;
ALTER TABLE memories ADD CONSTRAINT memories_category_check CHECK (category IN (
  'relationship', 'conflict', 'preference', 'promise', 'villa_event', 'challenge_outcome', 'personal_fact', 'emotional_shift'
));
DROP INDEX memories_scope_idx;
CREATE INDEX memories_scope_idx ON memories (kin_id, storyline, guild_id, context_id, context_type, status);
CREATE INDEX memories_dedup_idx ON memories (kin_id, storyline, guild_id, context_id, context_type, fingerprint);
