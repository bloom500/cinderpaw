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

-- Site visits and Download clicks per channel per UTC day (POST /visit).
-- Counts only: no address, no cookie, no page.
CREATE TABLE IF NOT EXISTS visit_day (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  step TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, step)
);

-- Answers to the in-app paid-extra question (POST /interest), per UTC day.
-- Counts only: the extra picked, the price tag shown, yes/maybe/no. No address, no id.
CREATE TABLE IF NOT EXISTS interest_day (
  day TEXT NOT NULL,
  extra TEXT NOT NULL,
  price TEXT NOT NULL,
  answer TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, extra, price, answer)
);
