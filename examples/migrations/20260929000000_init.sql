CREATE TABLE polls (
  id       bigserial PRIMARY KEY,
  title    text NOT NULL,
  option_a text NOT NULL,
  option_b text NOT NULL
);

CREATE TABLE votes (
  id      bigserial PRIMARY KEY,
  poll_id bigint NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
  choice  text NOT NULL CHECK (choice IN ('a', 'b'))
);
