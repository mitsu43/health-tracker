/**
 * Health Tracker — Cloudflare Worker
 *
 * ルーティング:
 *   GET  /              → public/index.html を配信
 *   GET  /api/data      → 全日次データ + 目標値を返す
 *   POST /api/day       → 1日分のチェック/バイタルを保存
 *   GET  /api/day/:date → 特定日のデータを返す
 *   POST /api/goals     → 目標値を保存
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // ── API ルーティング ──────────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      return handleAPI(request, url, method, env);
    }

    // ── 静的ファイル配信 ──────────────────────────────────────
    return env.ASSETS.fetch(request);
  },
};

// ─────────────────────────────────────────────────────────────
// API ハンドラ
// ─────────────────────────────────────────────────────────────
async function handleAPI(request, url, method, env) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    // GET /api/data — 全データ取得（初回ロード、デバイス間同期用）
    if (url.pathname === "/api/data" && method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT date, checks, vitals FROM daily_data ORDER BY date DESC LIMIT 365"
      ).all();

      const goalsRow = await env.DB.prepare(
        "SELECT data FROM goals WHERE id = 1"
      ).first();

      const db = {};
      for (const row of rows.results) {
        db[row.date] = {
          c: JSON.parse(row.checks || "{}"),
          v: JSON.parse(row.vitals || "{}"),
        };
      }

      return json({ db, goals: JSON.parse(goalsRow?.data || "{}") }, cors);
    }

    // POST /api/day — 1日分を保存
    if (url.pathname === "/api/day" && method === "POST") {
      const body = await request.json();
      const { date, checks, vitals } = body;

      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json({ error: "invalid date" }, cors, 400);
      }

      await env.DB.prepare(`
        INSERT INTO daily_data (date, checks, vitals, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(date) DO UPDATE SET
          checks = excluded.checks,
          vitals = excluded.vitals,
          updated_at = excluded.updated_at
      `).bind(
        date,
        JSON.stringify(checks || {}),
        JSON.stringify(vitals || {})
      ).run();

      return json({ ok: true }, cors);
    }

    // GET /api/day/:date — 特定日を取得
    const dayMatch = url.pathname.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (dayMatch && method === "GET") {
      const row = await env.DB.prepare(
        "SELECT checks, vitals FROM daily_data WHERE date = ?"
      ).bind(dayMatch[1]).first();

      if (!row) return json({ c: {}, v: {} }, cors);
      return json({
        c: JSON.parse(row.checks || "{}"),
        v: JSON.parse(row.vitals || "{}"),
      }, cors);
    }

    // POST /api/goals — 目標値を保存
    if (url.pathname === "/api/goals" && method === "POST") {
      const body = await request.json();
      await env.DB.prepare(`
        UPDATE goals SET data = ?, updated_at = datetime('now') WHERE id = 1
      `).bind(JSON.stringify(body)).run();
      return json({ ok: true }, cors);
    }

    return json({ error: "not found" }, cors, 404);

  } catch (err) {
    return json({ error: err.message }, cors, 500);
  }
}

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}
