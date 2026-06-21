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

    const studyLectureMatch = url.pathname.match(/^\/api\/study\/lecture\/(\d{1,3})$/);
    const studyAnalyzeMatch = url.pathname.match(/^\/api\/study\/lecture\/(\d{1,3})\/analyze$/);
    const studyYouTubeMatch = url.pathname.match(/^\/api\/study\/lecture\/(\d{1,3})\/youtube$/);

    if ((studyLectureMatch || studyAnalyzeMatch || studyYouTubeMatch) && !env.DB) {
      return json({ error: "DB is not configured" }, cors, 500);
    }

    if (studyLectureMatch && method === "GET") {
      await ensureStudyLectureTable(env);
      const lectureNumber = Number(studyLectureMatch[1]);
      const row = await env.DB.prepare(`
        SELECT lecture_number, title, transcript, exam_summary, updated_at
        FROM study_lecture_notes WHERE lecture_number = ?
      `).bind(lectureNumber).first();
      return json({
        ok: true,
        lecture: row || {
          lecture_number: lectureNumber,
          title: "",
          transcript: "",
          exam_summary: "",
          updated_at: null,
        },
      }, cors);
    }

    if (studyLectureMatch && method === "POST") {
      await ensureStudyLectureTable(env);
      const lectureNumber = Number(studyLectureMatch[1]);
      const body = await request.json();
      const title = String(body.title || "").slice(0, 300);
      const transcript = String(body.transcript || "").slice(0, 80000);
      const examSummary = String(body.examSummary || "").slice(0, 20000);
      await env.DB.prepare(`
        INSERT INTO study_lecture_notes
          (lecture_number, title, transcript, exam_summary, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(lecture_number) DO UPDATE SET
          title = excluded.title,
          transcript = excluded.transcript,
          exam_summary = excluded.exam_summary,
          updated_at = excluded.updated_at
      `).bind(lectureNumber, title, transcript, examSummary).run();
      return json({ ok: true }, cors);
    }

    if (studyAnalyzeMatch && method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return json({ error: "GEMINI_API_KEY is not configured" }, cors, 500);
      }
      await ensureStudyLectureTable(env);
      const lectureNumber = Number(studyAnalyzeMatch[1]);
      const body = await request.json();
      const title = String(body.title || `講義 ${lectureNumber}`).slice(0, 300);
      const transcript = String(body.transcript || "").trim().slice(0, 80000);
      if (!transcript) {
        return json({ error: "transcript is required" }, cors, 400);
      }
      const examSummary = await callGeminiStudySummary(env, lectureNumber, title, transcript);
      await env.DB.prepare(`
        INSERT INTO study_lecture_notes
          (lecture_number, title, transcript, exam_summary, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(lecture_number) DO UPDATE SET
          title = excluded.title,
          transcript = excluded.transcript,
          exam_summary = excluded.exam_summary,
          updated_at = excluded.updated_at
      `).bind(lectureNumber, title, transcript, examSummary).run();
      return json({ ok: true, examSummary }, cors);
    }

    if (studyYouTubeMatch && method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return json({ error: "GEMINI_API_KEY is not configured" }, cors, 500);
      }
      await ensureStudyLectureTable(env);
      const lectureNumber = Number(studyYouTubeMatch[1]);
      const body = await request.json();
      const youtubeUrl = String(body.youtubeUrl || "").trim().slice(0, 1000);
      if (!/^https:\/\/(www\.)?(youtube\.com\/watch\?|youtu\.be\/)/i.test(youtubeUrl)) {
        return json({ error: "public YouTube URL is required" }, cors, 400);
      }
      const result = await callGeminiYouTubeStudy(env, lectureNumber, youtubeUrl);
      await env.DB.prepare(`
        INSERT INTO study_lecture_notes
          (lecture_number, title, transcript, exam_summary, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(lecture_number) DO UPDATE SET
          title = excluded.title,
          transcript = excluded.transcript,
          exam_summary = excluded.exam_summary,
          updated_at = excluded.updated_at
      `).bind(
        lectureNumber,
        result.title || `L24総合講義 ${String(lectureNumber).padStart(3, "0")}`,
        result.timeline || "",
        result.examSummary || ""
      ).run();
      return json({ ok: true, ...result }, cors);
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
      const context = compactCoachContext(body.context || {});

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

async function ensureStudyLectureTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS study_lecture_notes (
      lecture_number INTEGER PRIMARY KEY,
      title TEXT DEFAULT '',
      transcript TEXT DEFAULT '',
      exam_summary TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
}

async function callGeminiStudySummary(env, lectureNumber, title, transcript) {
  const preferredModel = env.GEMINI_MODEL || "gemini-2.5-flash";
  const models = [preferredModel, "gemini-2.5-flash-lite", "gemini-2.0-flash"]
    .filter((model, index, all) => model && all.indexOf(model) === index);
  const prompt = [
    "あなたは測量士補試験の受験指導者です。",
    `対象: L24測量士補 総合講義 ${String(lectureNumber).padStart(3, "0")} ${title}`,
    "下の講義字幕から、試験で問われる内容だけを抽出してください。",
    "講義全体の感想、導入、雑談、重複説明は省いてください。",
    "字幕にない事実を推測で追加しないでください。",
    "回答は日本語で、Markdown記号は使わず、必ず次の見出し順にしてください。",
    "【この講義で問われること】出題される論点を最大5項目。",
    "【必ず覚える数字・用語】定義、期限、数値、単位。なければ「なし」。",
    "【計算・公式】公式、使う条件、単位、典型的な計算手順。なければ「なし」。",
    "【ひっかけ】混同しやすい選択肢や誤りの見抜き方。",
    "【一問一答】本試験風の短い問題を3問と、その直後に答え。",
    "各項目は簡潔にし、復習時間5分以内で読める分量にしてください。",
    "",
    "講義字幕:",
    transcript,
  ].join("\n");
  let lastError = "";
  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 1800 },
      }),
    });
    if (response.ok) {
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim()
        || "試験ポイントを生成できませんでした。";
    }
    lastError = `Gemini API error ${response.status}: ${(await response.text()).slice(0, 300)}`;
    if (![429, 503].includes(response.status)) throw new Error(lastError);
  }
  throw new Error(lastError || "Gemini API request failed");
}

async function callGeminiYouTubeStudy(env, lectureNumber, youtubeUrl) {
  const preferredModel = env.GEMINI_MODEL || "gemini-2.5-flash";
  const models = [preferredModel, "gemini-2.5-flash-lite"]
    .filter((model, index, all) => model && all.indexOf(model) === index);
  const prompt = [
    "あなたは測量士補試験の受験指導者です。",
    `対象講義番号: ${String(lectureNumber).padStart(3, "0")}`,
    "この一般公開YouTube動画の音声と画面を確認してください。",
    "逐語的な全文書き起こしは作らず、学習用の時間帯別要約字幕を作ってください。",
    "出力は日本語で、必ず次の形式にしてください。",
    "【講義タイトル】",
    "動画から判断できる短い題名",
    "【タイムライン要約字幕】",
    "[MM:SS-MM:SS] その区間で説明している内容を1〜3文",
    "重要な論点ごとに区切り、雑談・挨拶・重複は省く。",
    "【この講義で問われること】",
    "本試験で問われる論点を最大5項目。",
    "【必ず覚える数字・用語】",
    "定義、数値、単位。なければ「なし」。",
    "【計算・公式】",
    "公式、条件、単位、解法手順。なければ「なし」。",
    "【ひっかけ】",
    "混同しやすい選択肢や誤りの見抜き方。",
    "【一問一答】",
    "本試験風の短い問題3問と答え。",
    "動画にない内容を推測で追加しない。",
  ].join("\n");
  let lastError = "";
  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { file_data: { file_uri: youtubeUrl } },
            { text: prompt },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 5000 },
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
      const title = extractStudySection(text, "講義タイトル");
      const timeline = extractStudySection(text, "タイムライン要約字幕");
      const examStart = text.indexOf("【この講義で問われること】");
      return {
        title: title || `L24総合講義 ${String(lectureNumber).padStart(3, "0")}`,
        timeline: timeline || text,
        examSummary: examStart >= 0 ? text.slice(examStart).trim() : text,
      };
    }
    lastError = `Gemini API error ${response.status}: ${(await response.text()).slice(0, 500)}`;
    if (![429, 503].includes(response.status)) throw new Error(lastError);
  }
  throw new Error(lastError || "YouTube video analysis failed");
}

function extractStudySection(text, heading) {
  const marker = `【${heading}】`;
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const contentStart = start + marker.length;
  const next = text.indexOf("【", contentStart);
  return text.slice(contentStart, next < 0 ? text.length : next).trim();
}

function compactCoachContext(value, depth = 0) {
  if (depth > 10 || value == null) return value;
  if (typeof value === "string") {
    if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) {
      return "[画像データは履歴保存から除外]";
    }
    return value.slice(0, 4000);
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => compactCoachContext(item, depth + 1));
  }

  const compact = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(image|imageData|image_data|base64)$/i.test(key)) continue;
    compact[key] = compactCoachContext(item, depth + 1);
  }
  return compact;
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
  const isDailyTotal = slot === "daily_total";

  const commonPrompt = [
    "あなたは健康管理アプリの食事ログに短いコメントを出すアシスタントです。",
    "診断、治療判断、厳密な栄養計算はしません。見えている食事内容から、生活改善の観点で実用的にコメントしてください。",
    "良い/悪いを断定しすぎず、食事ログから分かる範囲で説明してください。ただし「悪い点」見出しは必ず出してください。",
    "slot が supplements の場合、効果を断定せず、服薬中の薬があるなら医師・薬剤師に確認する注意を必ず含めてください。",
  ];
  const dailyPrompt = [
    "これは1日トータル評価です。短いコメントではなく、朝食・昼食・夕食・間食・飲み物・サプリを横断して詳しく評価してください。",
    "出力は日本語で、必ず以下の7見出しを順番どおりにすべて表示してください。見出しを省略しないでください。",
    "【1日の総評】3〜5文。食事全体の傾向と最優先課題をまとめる。",
    "【良い点】最低4項目。各項目で具体的な食品名を挙げ、それが血圧・尿酸値・LDL・HbA1c・Hb/Ht・体重・筋力維持のどれにどう役立つかを書く。",
    "【悪い点・惜しい点】最低4項目。大きな悪い点がなくても、量・頻度・塩分・糖質・脂質・たんぱく質・食物繊維・食事時間・飲酒・サプリ重複の観点から惜しい点を具体化する。",
    "【1日で不足しそうなもの】最低4項目。栄養素だけでなく、補える食品例と目安量を併記する。推測の場合は「記録上は」と明記する。",
    "【摂りすぎ・重複の確認】食品とサプリを合算し、重複や過量の可能性を確認する。判断できなければ、製品量や成分表示の確認事項を書く。",
    "【明日補うなら】朝・昼・夜・間食ごとに、追加または置き換えを1つずつ具体的に書く。",
    "【優先順位】第1〜第3優先を示し、最後に「最低限これだけ」を1つ書く。",
    "全体は1200〜2000字を目安にし、同じ表現の繰り返しを避けて最後まで完結させてください。",
    "サプリより食品で補える場合は食品を優先してください。鉄サプリなどの開始を自己判断で勧めず、服薬との併用は医師・薬剤師への確認を促してください。",
  ];
  const singlePrompt = [
    "出力は日本語で、必ず次の4項目をこの見出し名のまま表示してください。各項目は1〜2文、120〜180字程度で、理由を具体的に書いてください。",
    "良い点: 具体的な食材・食べ方・量・タイミングと健康上の意味を書く。",
    "悪い点: 悪い点が少ない場合も「惜しい点」を必ず具体的に書く。",
    "不足・補充したいもの: 不足しそうな栄養・食品群と食品例を書く。",
    "次回の一手: 現実的な置き換えや追加を1つ書く。",
    "全体を700字以内に収め、最後まで完結させてください。",
  ];
  const prompt = [
    ...commonPrompt,
    ...(isDailyTotal ? dailyPrompt : singlePrompt),
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
          temperature: isDailyTotal ? 0.3 : 0.25,
          maxOutputTokens: isDailyTotal ? 4000 : 1800,
        },
      }),
    });

    if (res.ok) {
      const payload = await res.json();
      let comment = payload.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim()
        || "コメントを作成できませんでした。";
      if (isDailyTotal && dailyMealCommentNeedsExpansion(comment)) {
        comment = await expandDailyMealComment(env, model, prompt, comment);
      }
      return comment;
    }

    const errText = await res.text();
    lastError = `Gemini API error ${res.status} on ${model}: ${errText.slice(0, 300)}`;
    if (![429, 503].includes(res.status)) {
      throw new Error(lastError);
    }
  }

  throw new Error(lastError);
}

function dailyMealCommentNeedsExpansion(comment) {
  const required = [
    "【1日の総評】",
    "【良い点】",
    "【悪い点・惜しい点】",
    "【1日で不足しそうなもの】",
    "【摂りすぎ・重複の確認】",
    "【明日補うなら】",
    "【優先順位】",
  ];
  return String(comment || "").length < 1000
    || required.some((heading) => !String(comment || "").includes(heading));
}

async function expandDailyMealComment(env, model, originalPrompt, draft) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const rewritePrompt = [
    originalPrompt,
    "",
    "以下は最初の回答ですが、短い、または必須見出しが不足しています。",
    "内容を捨てずに具体例と理由を補い、指定した7見出しをすべて含む1200〜2000字の完成版へ書き直してください。",
    "完成版だけを出力してください。",
    "",
    "最初の回答:",
    draft,
  ].join("\n");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: rewritePrompt }] }],
      generationConfig: { temperature: 0.25, maxOutputTokens: 4500 },
    }),
  });
  if (!response.ok) return draft;
  const payload = await response.json();
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || draft;
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
    "LDL、尿酸値、HbA1c、血圧、Hb、Ht、体重のうち、どれに関係する行動かを必要に応じて明示してください。",
    "HbまたはHtが低い場合、鉄不足と断定せず、鉄・たんぱく質・ビタミンB12・葉酸などの食事確認と、低値が続く場合の医療機関での原因確認を促してください。鉄サプリの自己判断開始は勧めないでください。",
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
