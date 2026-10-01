CREATE TABLE IF NOT EXISTS memory_kins (
  id text PRIMARY KEY,
  discord_bot_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_contexts (
  kin_id text NOT NULL REFERENCES memory_kins(id),
  storyline text NOT NULL,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  PRIMARY KEY (kin_id, storyline, guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY,
  kin_id text NOT NULL,
  storyline text NOT NULL,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
  category text NOT NULL CHECK (category IN ('relationship', 'conflict', 'preference', 'promise', 'villa_event', 'challenge_outcome', 'personal_fact')),
  tags text[] NOT NULL DEFAULT '{}',
  importance integer NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (kin_id, storyline, guild_id, channel_id)
    REFERENCES memory_contexts (kin_id, storyline, guild_id, channel_id)
);

CREATE INDEX IF NOT EXISTS memories_scope_idx
  ON memories (kin_id, storyline, guild_id, channel_id, active);
