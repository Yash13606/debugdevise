-- Hold-expiry reminders (sent once) and a waitlist for sold-out events.
ALTER TABLE holds ADD COLUMN reminded BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE waitlist (
  event_id    TEXT NOT NULL REFERENCES events(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  BIGINT NOT NULL,
  notified_at BIGINT,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX idx_waitlist_open ON waitlist(event_id, created_at) WHERE notified_at IS NULL;
