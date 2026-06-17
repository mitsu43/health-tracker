/**
 * Health Tracker — Cloudflare Worker
 *
 * ルーティング:
 *   GET  /              → public/index.html を配信
 *   GET  /api/data      → 全日次データ + 目標値を返す
 *   POST /api/day       → 1日分のチェック/バイタルを保存
 *   GET  /api/day/:date → 特定日のデータを返す
 *   POST /api/goals     → 目標値を保存
 *   POST /api/meal/analyze → Geminiで食事写真を解析
 *   POST /api/meal/comment → Geminiで食事ログにコメント
 *   POST /api/coach     → Geminiで伴走コメントを生成
 *   GET  /api/coach/logs → Gemini相談履歴を取得
 *   DELETE /api/coach/logs/:id → Gemini相談履歴を削除
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
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
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

    // POST /api/meal/analyze — Geminiによる食事写真解析
    if (url.pathname === "/api/meal/analyze" && method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return json({ error: "GEMINI_API_KEY is not configured" }, cors, 500);
      }

      const body = await request.json();
      const image = String(body.image || "");
      const slot = String(body.slot || "auto").slice(0, 20);
      const meal = await callGeminiMealImage(env, image, slot);
      return json({ ok: true, meal }, cors);
    }

    // POST /api/meal/comment — Geminiによる食事ログコメント
    if (url.pathname === "/api/meal/comment" && method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return json({ error: "GEMINI_API_KEY is not configured" }, cors, 500);
      }

      const body = await request.json();
      const comment = await callGeminiMealComment(env, body || {});
      return json({ ok: true, comment }, cors);
    }

    // POST /api/coach — Geminiによる伴走コメント
    if (url.pathname === "/api/coach" && method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return json({ error: "GEMINI_API_KEY is not configured" }, cors, 500);
      }

      const body = await request.json();
      const question = String(body.question || "").trim().slice(0, 1200);
      const mode = String(body.mode || "today").slice(0, 40);
      const context = body.context || {};

      if (!question) {
        return json({ error: "question is required" }, cors, 400);
      }

      const answer = await callGemini(env, mode, question, context);
      await env.DB.prepare(`
        INSERT INTO coach_logs (mode, question, answer, context, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).bind(
        mode,
        question,
        answer,
        JSON.stringify(context || {})
      ).run();
      return json({ ok: true, answer }, cors);
    }

    // GET /api/coach/logs — 相談履歴を取得
    if (url.pathname === "/api/coach/logs" && method === "GET") {
      const rows = await env.DB.prepare(`
        SELECT id, created_at, mode, question, answer, context
        FROM coach_logs
        ORDER BY id DESC
        LIMIT 50
      `).all();
      return json({ ok: true, logs: rows.results || [] }, cors);
    }

    const coachLogDeleteMatch = url.pathname.match(/^\/api\/coach\/logs\/(\d+)$/);
    if (coachLogDeleteMatch && method === "DELETE") {
      const result = await env.DB.prepare(
        "DELETE FROM coach_logs WHERE id = ?"
      ).bind(Number(coachLogDeleteMatch[1])).run();

      return json({ ok: true, deleted: result.meta?.changes || 0 }, cors);
    }

    return json({ error: "not found" }, cors, 404);

  } catch (err) {
    return json({ error: err.message }, cors, 500);
  }
}

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

function parseDataUrlImage(image) {
  const match = String(image || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error("invalid image data");
  return { mimeType: match[1], data: match[2] };
}

function parseJsonObject(text) {
  const raw = String(text || "").trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("meal analysis returned invalid JSON");
  }
}

async function callGeminiMealImage(env, image, slot) {
  const { mimeType, data } = parseDataUrlImage(image);
  if (data.length > 5_500_000) {
    throw new Error("image is too large");
  }

  const preferredModel = env.GEMINI_MODEL || "gemini-2.5-flash";
  const fallbackModels = [
    preferredModel,
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
  ].filter((model, index, all) => model && all.indexOf(model) === index);

  const prompt = [
    "あなたは健康管理アプリの食事写真解析アシスタントです。",
    "写真に写っている食事を日本語で短く整理し、必ずJSONだけを返してください。",
    "診断や厳密な栄養計算はせず、見えている範囲で推定してください。分からない食材は推定と明記してください。",
    "返すJSONのキーは breakfast, lunch, dinner, snack, drink, note, out, alcohol, fried, late, summary のみです。",
    "breakfast/lunch/dinner/snack/drink/note/summary は文字列、out/alcohol/fried/late は真偽値です。",
    "slot が breakfast/lunch/dinner/snack の場合、主な解析結果はそのキーに入れてください。slot が auto の場合は写真から自然に判断してください。",
    "血圧・尿酸値・LDL・HbA1cに関係しそうな注意点があれば note に短く含めてください。",
    `slot: ${slot || "auto"}`,
  ].join("\n");

  let lastError = "";
  for (const model of fallbackModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data } },
          ],
        }],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 700,
          responseMimeType: "application/json",
        },
      }),
    });

    if (res.ok) {
      const payload = await res.json();
      const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim() || "{}";
      const meal = parseJsonObject(text);
      return {
        breakfast: String(meal.breakfast || "").slice(0, 500),
        lunch: String(meal.lunch || "").slice(0, 500),
        dinner: String(meal.dinner || "").slice(0, 500),
        snack: String(meal.snack || "").slice(0, 500),
        drink: String(meal.drink || "").slice(0, 500),
        note: String(meal.note || "").slice(0, 700),
        summary: String(meal.summary || "").slice(0, 500),
        out: !!meal.out,
        alcohol: !!meal.alcohol,
        fried: !!meal.fried,
        late: !!meal.late,
      };
    }

    const errText = await res.text();
    lastError = `Gemini API error ${res.status} on ${model}: ${errText.slice(0, 300)}`;
    if (![429, 503].includes(res.status)) {
      throw new Error(lastError);
    }
  }

  throw new Error(lastError);
}

async function callGeminiMealComment(env, context) {
  const preferredModel = env.GEMINI_MODEL || "gemini-2.5-flash";
  const fallbackModels = [
    preferredModel,
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
  ].filter((model, index, all) => model && all.indexOf(model) === index);

  const slot = String(context.slot || "").slice(0, 40);
  const meal = String(context.meal || "").trim().slice(0, 1600);
  if (!meal) throw new Error("meal is required");

  const prompt = [
    "あなたは健康管理アプリの食事ログに短いコメントを出すアシスタントです。",
    "診断、治療判断、厳密な栄養計算はしません。見えている食事内容から、生活改善の観点で実用的にコメントしてください。",
    "出力は日本語で、次の3行だけにしてください。",
    "良い点: ...",
    "改善点: ...",
    "次回の一手: ...",
    "血圧、尿酸値、LDL、HbA1c、体重への影響が分かる場合だけ短く触れてください。",
    "slot が supplements の場合、効果を断定せず、服薬中の薬があるなら医師・薬剤師に確認する注意を必ず含めてください。",
    "",
    `対象: ${slot}`,
    `食事/サプリ: ${meal}`,
    "",
    "当日の他の記録と目標(JSON):",
    JSON.stringify(context).slice(0, 8000),
  ].join("\n");

  let lastError = "";
  for (const model of fallbackModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 500,
        },
      }),
    });

    if (res.ok) {
      const payload = await res.json();
      return payload.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim()
        || "コメントを作成できませんでした。";
    }

    const errText = await res.text();
    lastError = `Gemini API error ${res.status} on ${model}: ${errText.slice(0, 300)}`;
    if (![429, 503].includes(res.status)) {
      throw new Error(lastError);
    }
  }

  throw new Error(lastError);
}

async function callGemini(env, mode, question, context) {
  const preferredModel = env.GEMINI_MODEL || "gemini-2.5-flash";
  const fallbackModels = [
    preferredModel,
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
  ].filter((model, index, all) => model && all.indexOf(model) === index);
  const prompt = [
    "あなたは健康管理アプリの伴走コーチです。",
    "役割は、ユーザーの生活ログを整理し、最小限の努力で改善しやすい行動を提案することです。",
    "医師の診断、薬の判断、治療方針の断定はしません。",
    "異常値、強い症状、継続する不調がある場合は医療機関への相談を促してください。",
    "回答は日本語で、短すぎず、実際にその場で選べる具体案を出してください。",
    "Markdownの # や * は使わず、見出しは【今日の最小ミッション】のように全角カッコで書いてください。",
    "必ず次の見出しをこの順番で使ってください: 【今日の最小ミッション】/【選ぶとよいもの】/【避けるもの】/【さぼってOK】/【気をつけるサイン】/【理由】。",
    "各見出しには1〜3項目を書いてください。1行だけで終わらせないでください。",
    "外出、外食、観戦、飲み会、コンビニ、移動中の相談では、飲み物・食べ物・おやつ・帰宅後の注意を必ず含めてください。",
    "LDL、尿酸値、HbA1c、血圧、体重のうち、どれに効く行動かを必要に応じて明示してください。",
    "完璧主義を避け、優先順位をつけてください。できれば『最低限これだけ』を最初に1つ示してください。",
    "",
    `相談モード: ${mode}`,
    `ユーザーの相談: ${question}`,
    "",
    "直近データと目標値(JSON):",
    JSON.stringify(context).slice(0, 12000),
  ].join("\n");

  let lastError = "";
  for (const model of fallbackModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 1400,
        },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim()
        || "回答を生成できませんでした。";
    }

    const errText = await res.text();
    lastError = `Gemini API error ${res.status} on ${model}: ${errText.slice(0, 300)}`;

    // 503/429は混雑やレート制限なので次の軽量モデルを試す。
    if (![429, 503].includes(res.status)) {
      throw new Error(lastError);
    }
  }

  throw new Error(`${lastError}\nすべてのGemini候補モデルが混雑しています。数分置いて再試行してください。`);
}
