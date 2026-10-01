CREATE TABLE notes (id bigserial PRIMARY KEY, title text NOT NULL UNIQUE, tags text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
