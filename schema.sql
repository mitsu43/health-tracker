-- 日次データ（チェックリスト + バイタル数値）
CREATE TABLE IF NOT EXISTS daily_data (
  date        TEXT PRIMARY KEY,  -- YYYY-MM-DD
  checks      TEXT DEFAULT '{}', -- JSON: {routine_id: bool}
  vitals      TEXT DEFAULT '{}', -- JSON: {sbp, dbp, wt, steps, ...}
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- 目標値
CREATE TABLE IF NOT EXISTS goals (
  id          INTEGER PRIMARY KEY CHECK (id = 1), -- シングルトン行
  data        TEXT DEFAULT '{}', -- JSON: {wt, sbp, ldl, ...}
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- 初期目標行を挿入（なければ）
INSERT OR IGNORE INTO goals (id, data) VALUES (1, '{"wt":83,"sbp":125,"ldl":119,"ua":7.0,"hba1c":5.5,"steps":10000}');

-- Gemini相談履歴
CREATE TABLE IF NOT EXISTS coach_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT DEFAULT (datetime('now')),
  mode        TEXT DEFAULT 'today',
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  context     TEXT DEFAULT '{}'
);
