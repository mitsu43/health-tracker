/**
 * Health Tracker — Cloudflare Worker
 *
 * ルーティング:
 *   GET  /              → public/index.html を配信
 *   GET  /api/data      → 全日次データ + 目標値を返す
 *   POST /api/day       → 1日分のチェック/バイタルを保存
 *   GET  /api/day/:date → 特定日のデータを返す
 *   POST /api/goals     → 目標値を保存
 *   POST /api/coach     → Geminiで伴走コメントを生成
 *   GET  /api/coach/logs → Gemini相談履歴を取得
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
        SELECT id, created_at, mode, question, answer
        FROM coach_logs
        ORDER BY id DESC
        LIMIT 50
      `).all();
      return json({ ok: true, logs: rows.results || [] }, cors);
    }

    // DELETE /api/coach/logs/:id — 相談履歴を削除
    const logDeleteMatch = url.pathname.match(/^\/api\/coach\/logs\/(\d+)$/);
    if (logDeleteMatch && method === "DELETE") {
      await env.DB.prepare("DELETE FROM coach_logs WHERE id = ?")
        .bind(Number(logDeleteMatch[1]))
        .run();
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

async function callGemini(env, mode, question, context) {
  const preferredModel = env.GEMINI_MODEL || "gemini-2.5-flash";
  const fallbackModels = [
    preferredModel,
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
  ].filter((model, index, all) => model && all.indexOf(model) === index);
  const isDailyReview = mode === "daily_review";
  const headingInstruction = isDailyReview
    ? "必ず次の見出しをこの順番で使ってください: 【今日の振り返り】/【足りなかったこと】/【明日の最小ミッション】/【時間帯別プラン】/【優先する数値】/【さぼってOK】。"
    : "必ず次の見出しをこの順番で使ってください: 【結論】/【今日の最小ミッション】/【目安】/【理由】。";
  const prompt = [
    "あなたは健康管理アプリの伴走コーチです。",
    "役割は、ユーザーの生活ログを整理し、最小限の努力で改善しやすい行動を提案することです。",
    "医師の診断、薬の判断、治療方針の断定はしません。",
    "異常値、強い症状、継続する不調がある場合は医療機関への相談を促してください。",
    "回答は日本語で、短すぎず、実際にその場で選べる具体案を出してください。",
    isDailyReview ? "" : "通常相談では全体を500字以内にし、最後まで完結してください。",
    "必ず複数行で回答してください。1行でまとめることは禁止です。",
    "Markdownの # や * は使わず、見出しは【今日の最小ミッション】のように全角カッコで書いてください。",
    headingInstruction,
    "各見出しの後は必ず改行し、各項目も1つずつ改行してください。1行だけで終わらせないでください。",
    isDailyReview ? "夜レビューでは各見出しを1〜2項目に絞り、全体を1000字以内で必ず最後の【さぼってOK】まで完結してください。" : "",
    isDailyReview ? "明日の最小ミッションは最大3つ、時間帯別プランは朝9時・昼12時・夕3時・夜の4つで短く書いてください。" : "",
    "外出、外食、観戦、飲み会、コンビニ、移動中の相談では、飲み物・食べ物・おやつ・帰宅後の注意を必ず含めてください。",
    "LDL、尿酸値、HbA1c、血圧、体重のうち、どれに効く行動かを必要に応じて明示してください。",
    "完璧主義を避け、優先順位をつけてください。できれば『最低限これだけ』を最初に1つ示してください。",
    "",
    `相談モード: ${mode}`,
    `ユーザーの相談: ${question}`,
    "",
    "直近データと目標値(JSON):",
    JSON.stringify(context).slice(0, isDailyReview ? 12000 : 5000),
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
          maxOutputTokens: isDailyReview ? 2400 : 1800,
        },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const candidate = data.candidates?.[0];
      const answer = candidate?.content?.parts?.map((p) => p.text || "").join("\n").trim()
        || "回答を生成できませんでした。";
      let formatted = formatCoachAnswer(answer, mode);
      const missingFinalHeading = isDailyReview
        ? !formatted.includes("【さぼってOK】")
        : !formatted.includes("【理由】");
      if (candidate?.finishReason === "MAX_TOKENS" || missingFinalHeading) {
        formatted += "\n\n（回答が長くなり途中で切れた可能性があります。もう一度押すと再生成できます。）";
      }
      return formatted;
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

function formatCoachAnswer(answer, mode = "today") {
  const defaultHeadings = [
    "結論",
    "今日の最小ミッション",
    "目安",
    "理由",
  ];
  const reviewHeadings = [
    "今日の振り返り",
    "足りなかったこと",
    "明日の最小ミッション",
    "時間帯別プラン",
    "優先する数値",
    "さぼってOK",
  ];
  const headings = mode === "daily_review" ? reviewHeadings : defaultHeadings;
  let text = String(answer || "").trim();

  for (const heading of headings) {
    text = text.replaceAll(`【${heading}】`, `\n\n【${heading}】\n`);
  }

  text = text
    .replace(/。(?=【)/g, "。\n\n")
    .replace(/。(?=[^\n])/g, "。\n")
    .replace(/([。！？])\s*(?=[0-9０-９一二三四五六七八九十]+[.．、])/g, "$1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const hasHeading = headings.some((heading) => text.includes(`【${heading}】`));
  if (!hasHeading && text.length > 80) {
    text = text.replace(/。/g, "。\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  return text;
}
