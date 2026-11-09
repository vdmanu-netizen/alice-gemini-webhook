
const MODEL = "gemini-3.6-flash";

const FALLBACK =
  "Сейчас не удалось быстро получить ответ. Попробуйте задать вопрос ещё раз.";

// Временные ограничения
const SERPER_TIMEOUT = 1000;
const GEMINI_TIMEOUT = 3000;
const MAX_RESPONSE_TIME = 4200;

function send(res, status, obj) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.send(JSON.stringify(obj));
}

function getText(b) {
  const r = b.request || {};

  for (const v of [
    r.original_utterance,
    r.command,
    b.command,
    b.message,
    b.text
  ]) {
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }

  return Array.isArray(r.nlu?.tokens)
    ? r.nlu.tokens.join(" ")
    : "";
}

function getHistory(b) {
  const s = b.state?.session || b.session_state || {};

  return (Array.isArray(s.history) ? s.history : [])
    .filter(
      x =>
        x &&
        ["user", "model", "assistant"].includes(x.role) &&
        typeof x.text === "string"
    )
    .slice(-16)
    .map(x => ({
      role: x.role === "assistant" ? "model" : x.role,
      text: x.text.slice(0, 2500)
    }));
}

// Числа, записанные словами
const WORDS = {
  ноль: 0,
  один: 1,
  одна: 1,
  одно: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
  пятьдесят: 50,
  шестьдесят: 60,
  семьдесят: 70,
  восемьдесят: 80,
  девяносто: 90,
  сто: 100,
  двести: 200,
  триста: 300,
  четыреста: 400,
  пятьсот: 500,
  шестьсот: 600,
  семьсот: 700,
  восемьсот: 800,
  девятьсот: 900
};

function parseNumber(s) {
  let t = String(s).toLowerCase().replace(/ё/g, "е");

  const parts = t.split(
    /(?:будет|равно|составляет|получилось|результат[: ]*)/i
  );

  if (parts.length > 1) {
    t = parts[parts.length - 1];
  }

  const ds = t.match(/-?\d+(?:[.,]\d+)?/g);

  if (ds?.length) {
    return Number(ds[ds.length - 1].replace(",", "."));
  }

  let sum = 0;
  let found = false;

  for (const w of t.replace(/[.,!?;:()]/g, " ").split(/\s+/)) {
    if (Object.prototype.hasOwnProperty.call(WORDS, w)) {
      sum += WORDS[w];
      found = true;
    } else if (w.startsWith("тысяч")) {
      sum = (sum || 1) * 1000;
      found = true;
    } else if (w.startsWith("миллион")) {
      sum = (sum || 1) * 1000000;
      found = true;
    }
  }

  return found ? sum : null;
}

// Число в русские слова
const U = [
  "ноль", "один", "два", "три", "четыре",
  "пять", "шесть", "семь", "восемь", "девять",
  "десять", "одиннадцать", "двенадцать",
  "тринадцать", "четырнадцать", "пятнадцать",
  "шестнадцать", "семнадцать", "восемнадцать",
  "девятнадцать"
];

const T = [
  "", "", "двадцать", "тридцать", "сорок",
  "пятьдесят", "шестьдесят", "семьдесят",
  "восемьдесят", "девяносто"
];

const H = [
  "", "сто", "двести", "триста", "четыреста",
  "пятьсот", "шестьсот", "семьсот",
  "восемьсот", "девятьсот"
];

function small(n) {
  const a = [];

  if (n >= 100) {
    a.push(H[Math.floor(n / 100)]);
    n %= 100;
  }

  if (n < 20) {
    if (n || !a.length) a.push(U[n]);
  } else {
    a.push(T[Math.floor(n / 10)]);
    if (n % 10) a.push(U[n % 10]);
  }

  return a.join(" ");
}

function words(n) {
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    Math.abs(n) > 999999
  ) {
    return String(n);
  }

  if (n < 0) return "минус " + words(-n);
  if (n < 1000) return small(n);

  const k = Math.floor(n / 1000);
  const r = n % 1000;
  const z = k % 10;
  const zz = k % 100;

  const f =
    zz >= 11 && zz <= 14
      ? "тысяч"
      : z === 1
        ? "тысяча"
        : z >= 2 && z <= 4
          ? "тысячи"
          : "тысяч";

  return small(k) + " " + f + (r ? " " + small(r) : "");
}

// Локальная арифметика — без обращения к Gemini
function arithmetic(text, h, b) {
  const q = text.toLowerCase().replace(/ё/g, "е");

  const ns = (b.request?.nlu?.entities || [])
    .filter(
      e =>
        e.type === "YANDEX.NUMBER" &&
        Number.isFinite(+e.value)
    )
    .map(e => +e.value);

  if (!ns.length) {
    const m = q.match(/-?\d+(?:[.,]\d+)?/g);

    if (m) {
      ns.push(...m.map(x => +x.replace(",", ".")));
    }
  }

  const mul = /умнож|произвед|\*/.test(q);
  const div = /раздели|делен|подел|\//.test(q);
  const add = /прибав|сложи|плюс|сумм|\+/.test(q);
  const sub = /вычти|отними|минус|разност/.test(q);

  if (
    !(mul || div || add || sub || /сколько будет/.test(q))
  ) {
    return null;
  }

  let a;
  let c;

  if (ns.length >= 2) {
    [a, c] = ns;
  } else if (
    ns.length === 1 &&
    h.length &&
    /результат|его|это|получ|теперь|еще|ещё/.test(q)
  ) {
    const prev = [...h]
      .reverse()
      .find(x => x.role === "model");

    const p = prev ? parseNumber(prev.text) : null;

    if (p !== null) {
      a = p;
      c = ns[0];
    }
  }

  if (a === undefined || c === undefined) {
    return null;
  }

  let v = mul
    ? a * c
    : div
      ? (c === 0 ? NaN : a / c)
      : sub
        ? a - c
        : a + c;

  if (c === 0 && div) {
    return "На ноль делить нельзя.";
  }

  if (!Number.isFinite(v) || Math.abs(v) > 1e12) {
    return null;
  }

  v = Number.isInteger(v)
    ? v
    : Number(v.toFixed(8));

  return (
    words(a) +
    " " +
    (mul
      ? "умножить на"
      : div
        ? "разделить на"
        : sub
          ? "минус"
          : "плюс") +
    " " +
    words(c) +
    " будет " +
    words(v) +
    "."
  );
}

// Компактная история для Яндекс Диалогов
function compact(h) {
  const a = h.slice(-16);

  while (
    a.length &&
    Buffer.byteLength(
      JSON.stringify({ history: a }),
      "utf8"
    ) > 900
  ) {
    if (a.length > 2) {
      a.shift();
    } else {
      a[0].text = a[0].text.slice(-250);
      break;
    }
  }

  return a;
}

async function timedFetch(url, opt, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);

  try {
    return await fetch(url, {
      ...opt,
      signal: c.signal
    });
  } finally {
    clearTimeout(t);
  }
}

// Поиск актуальной информации через Serper
async function search(q, key) {
  if (
    !key ||
    !/(найди|поищи|последн|сегодня|сейчас|новост|курс|погода|актуальн)/i.test(q)
  ) {
    return "";
  }

  try {
    const r = await timedFetch(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q,
          gl: "ru",
          hl: "ru",
          num: 5
        })
      },
      SERPER_TIMEOUT
    );

    if (!r.ok) {
      console.error("Serper HTTP error:", r.status);
      return "";
    }

    const d = await r.json();

    const items = (d.organic || [])
      .slice(0, 3)
      .map((x, i) => {
        const title = (x.title || "").replace(/\s+/g, " ").trim();
        const snippet = (x.snippet || "").replace(/\s+/g, " ").trim();

        if (!title && !snippet) return "";

        return `${i + 1}. ${title}. ${snippet}`;
      })
      .filter(Boolean);

    return items.join(" ").slice(0, 1800);

  } catch (e) {
    console.error(
      "Serper request failed:",
      e.message || String(e)
    );

    return "";
  }
}

  try {
    const r = await timedFetch(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q,
          gl: "ru",
          hl: "ru",
          num: 5
        })
      },
      SERPER_TIMEOUT
    );

    if (!r.ok) {
      console.error("Serper HTTP error:", r.status);
      return "";
    }

    const d = await r.json();

    const result = (d.organic || [])
      .slice(0, 5)
      .map(
        x =>
          (x.title || "") +
          " " +
          (x.snippet || "") +
          " " +
          (x.link || "")
      )
      .join("\n")
      .slice(0, 3500);

    return result;
  } catch (e) {
    console.error(
      "Serper request failed:",
      e.message || String(e)
    );

    return "";
  }
}

// Извлечение текста из ответа Interactions API
function output(d) {
  if (
    typeof d.output_text === "string" &&
    d.output_text.trim()
  ) {
    return d.output_text.trim();
  }

  const a = [];

  for (const s of d.steps || []) {
    if (s.type === "model_output") {
      for (const c of s.content || []) {
        if (c.type === "text" && c.text) {
          a.push(c.text);
        }
      }
    }
  }

  return a.join("\n").trim();
}

// Запрос к Gemini
async function gemini(q, h, key, ctx) {
  const transcript = h
    .map(
      x =>
        (x.role === "user" ? "Пользователь" : "Ассистент") +
        ": " +
        x.text
    )
    .join("\n");

  const input =
    (transcript
      ? "Предыдущий диалог:\n" + transcript + "\n"
      : "") +
    "Вопрос: " +
    q +
    (ctx ? "\nКонтекст поиска:\n" + ctx : "");

  const r = await timedFetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        input,
        system_instruction:
          "Ты — голосовой помощник Алисы. " +
          "Отвечай кратко, естественно, точно и на русском языке. " +
          "Учитывай предыдущий диалог. " +
          "Если предоставлен контекст поиска, используй его для актуальных сведений. " +
          "Не выдумывай факты и даты.",
        generation_config: {
          thinking_level: "low"
        },
        store: false
      })
    },
    GEMINI_TIMEOUT
  );

  if (!r.ok) {
    const details = (await r.text()).slice(0, 500);

    console.error(
      "Gemini HTTP error:",
      r.status,
      details
    );

    throw Error("Gemini HTTP " + r.status);
  }

  const data = await r.json();
  const answer = output(data);

  if (!answer) {
    throw Error("Gemini returned empty output");
  }

  return answer;
}

// Основной обработчик Яндекс Алисы
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return send(res, 405, {
      error: "Method Not Allowed. Use POST."
    });
  }

  const start = Date.now();

  try {
    const b =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const q = getText(b);
    const h = getHistory(b);

    if (!q) {
      const a = "Я вас слушаю. Что вы хотите узнать?";

      return send(res, 200, {
        version: "1.0",
        response: {
          text: a,
          tts: a,
          end_session: false
        },
        session_state: {
          history: compact([
            ...h,
            { role: "model", text: a }
          ])
        }
      });
    }

    // Сначала локальная арифметика
    let a = arithmetic(q, h, b);

    // Если это не вычисление — обращаемся к Gemini
// Если это не вычисление — используем поиск или Gemini
if (!a && process.env.GEMINI_API_KEY) {
  let ctx = "";

  const needsSearch =
    /(найди|поищи|последн|сегодня|сейчас|новост|курс|погода|актуальн)/i.test(q);

  // Сначала пробуем получить актуальные сведения
  if (needsSearch && process.env.SERPER_API_KEY) {
    ctx = await search(
      q,
      process.env.SERPER_API_KEY
    );
  }

  // Если поиск дал результаты — сразу отвечаем ими.
  // Не тратим время на дополнительный запрос к Gemini.
  if (ctx) {
    a = ctx;
  } else {
    // Если поиск не сработал — используем Gemini
    const elapsed = Date.now() - start;

    if (elapsed < MAX_RESPONSE_TIME - 200) {
      try {
        a = await gemini(
          q,
          h,
          process.env.GEMINI_API_KEY,
          ""
        );
      } catch (e) {
        console.error(
          "Gemini request failed:",
          e.message || String(e)
        );
      }
    } else {
      console.error(
        "Gemini skipped: insufficient time",
        elapsed
      );
    }
  }
}

    if (!a) {
      a = FALLBACK;
    }

    a = a
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 900);

    return send(res, 200, {
      version: "1.0",
      response: {
        text: a,
        tts: a,
        end_session: false
      },
      session_state: {
        history: compact([
          ...h,
          { role: "user", text: q },
          { role: "model", text: a }
        ])
      }
    });

  } catch (e) {
    console.error(
      "Webhook error:",
      e.stack || e.message || String(e)
    );

    return send(res, 200, {
      version: "1.0",
      response: {
        text: FALLBACK,
        tts: FALLBACK,
        end_session: false
      },
      session_state: {
        history: [
          { role: "model", text: FALLBACK }
        ]
      }
    });
  }
}

