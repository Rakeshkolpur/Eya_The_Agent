import type { Migration } from './sqlite';

/**
 * The memory database's schema, as numbered steps. A step is never edited once released: a change to the schema is a NEW step
 * (version N+1) that alters what is already there, so a database made by an older Eya is carried forward, not thrown away.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'memories, skills (routines), their triggers and steps, run history, and learning candidates',
    sql: `
      -- Preferences ("always save PDFs to Desktop") and facts ("Ravi is my brother's contact"). One row per (type, key).
      CREATE TABLE memories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        type       TEXT NOT NULL CHECK (type IN ('preference', 'fact')),
        key        TEXT NOT NULL,
        key_norm   TEXT NOT NULL,
        value      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (type, key_norm)
      );

      -- A skill (a "routine"): something Eya can do again without thinking it through. The workflow itself lives in skill_steps.
      CREATE TABLE skills (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description   TEXT NOT NULL DEFAULT '',
        enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        last_used_at  TEXT,
        use_count     INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0
      );

      -- What the user says to run a skill. trigger_norm is the phrase reduced to its plain form (see normalize.ts); unique, so
      -- one wording can never mean two routines, and indexed, so an exact match is a single lookup.
      CREATE TABLE skill_triggers (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id     INTEGER NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
        trigger_text TEXT NOT NULL,
        trigger_norm TEXT NOT NULL UNIQUE
      );
      CREATE INDEX idx_skill_triggers_skill ON skill_triggers (skill_id);

      -- The workflow: high-level actions run through Eya's own tools (never screen coordinates), each with an optional check.
      CREATE TABLE skill_steps (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id    INTEGER NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        action      TEXT NOT NULL,
        target      TEXT NOT NULL DEFAULT '',
        value       TEXT NOT NULL DEFAULT '',
        submit      INTEGER NOT NULL DEFAULT 0 CHECK (submit IN (0, 1)),
        verify_kind TEXT NOT NULL DEFAULT 'none',
        verify_text TEXT NOT NULL DEFAULT '',
        UNIQUE (skill_id, position)
      );

      -- A short history of runs, so a routine that keeps failing is visible. Pruned to the latest few per skill.
      CREATE TABLE skill_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id    INTEGER NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
        started_at  TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        failed_step INTEGER,
        detail      TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_skill_runs_skill ON skill_runs (skill_id, id);

      -- Repeated tasks Eya has done successfully the same way. Not conversations: a signature of the steps, how many times, the
      -- steps themselves, and the short phrasings the user used. Used only to offer "save this as a routine"; the user decides.
      CREATE TABLE task_candidates (
        signature    TEXT PRIMARY KEY,
        count        INTEGER NOT NULL,
        first_seen   TEXT NOT NULL,
        last_seen    TEXT NOT NULL,
        declined     INTEGER NOT NULL DEFAULT 0 CHECK (declined IN (0, 1)),
        common_words TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE task_candidate_steps (
        signature   TEXT NOT NULL REFERENCES task_candidates (signature) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        action      TEXT NOT NULL,
        target      TEXT NOT NULL DEFAULT '',
        value       TEXT NOT NULL DEFAULT '',
        submit      INTEGER NOT NULL DEFAULT 0,
        verify_kind TEXT NOT NULL DEFAULT 'none',
        verify_text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (signature, position)
      );
      CREATE TABLE task_candidate_phrases (
        signature   TEXT NOT NULL REFERENCES task_candidates (signature) ON DELETE CASCADE,
        phrase_norm TEXT NOT NULL,
        phrase_text TEXT NOT NULL,
        count       INTEGER NOT NULL,
        PRIMARY KEY (signature, phrase_norm)
      );
    `,
  },
  {
    version: 2,
    name: 'activity: a short, private list of what Eya did, for the Recent screen',
    sql: `
      -- Titles only: what was asked (never for chat apps or anything private) and a line of what came of it. Not a conversation log.
      CREATE TABLE activity (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        at      TEXT NOT NULL,
        kind    TEXT NOT NULL CHECK (kind IN ('action', 'file', 'web', 'chat')),
        title   TEXT NOT NULL,
        detail  TEXT NOT NULL DEFAULT '',
        ok      INTEGER NOT NULL,
        request TEXT NOT NULL DEFAULT '',
        site    TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_activity_at ON activity (at DESC);
      CREATE INDEX idx_activity_site ON activity (site) WHERE site <> '';
    `,
  },
  {
    version: 3,
    name: 'chat names: the names Eya learned from a chat app the user allowed, so she can find a chat without asking the model',
    sql: `
      -- NAMES ONLY, as the chat app shows them, and only after the user said yes (see contacts_meta). Never a message, a preview, a
      -- phone number or a picture. Erased when the user turns Chats off for that app, and the user can delete any or all of them.
      CREATE TABLE contacts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        app        TEXT NOT NULL,
        name       TEXT NOT NULL,
        name_norm  TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen  TEXT NOT NULL,
        use_count  INTEGER NOT NULL DEFAULT 0,
        last_used  TEXT,
        UNIQUE (app, name_norm)
      );
      CREATE INDEX idx_contacts_app ON contacts (app, use_count DESC);

      -- What the user calls someone ("mom" for "Amma"): kept only after they confirmed a send to that chat under that name.
      CREATE TABLE contact_aliases (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id  INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
        alias_norm  TEXT NOT NULL,
        alias_text  TEXT NOT NULL,
        UNIQUE (contact_id, alias_norm)
      );

      -- The user's choice about learning names (key 'learn': 'on' or 'off'); no row means they have not been asked.
      CREATE TABLE contacts_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
