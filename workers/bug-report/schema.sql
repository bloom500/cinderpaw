-- Usage summaries, one row per (monthly code, UTC day, provider, model).
-- A resend for the same code+day deletes and rewrites, never adds.
CREATE TABLE IF NOT EXISTS usage_day (
  code TEXT NOT NULL,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  app TEXT NOT NULL,
  os TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (code, day, provider, model)
);
CREATE INDEX IF NOT EXISTS usage_day_month ON usage_day(month);
