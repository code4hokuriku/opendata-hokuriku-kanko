/** MCP(Model Context Protocol)サーバー。ツール呼び出しを既存のAPIへの内部リクエストに変換する。 */

type Handler = (req: Request) => Promise<Response>;
type Json = Record<string, unknown>;
interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: unknown;
  params?: Json;
}

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = {
  name: "hokuriku-kanko-survey",
  title: "北陸観光アンケート",
  version: "1.0.0",
};

const INSTRUCTIONS = `富山・石川・福井の観光アンケート(1行1回答)を分析するツールです。
まず survey_meta と list_columns で件数・期間・列を確認してください。
注意点:
- 期間が県で違う(福井 2022-04〜、石川 2023-09〜、富山 2025-04〜)。推移は by に prefecture を含めて県別に見る。
- 複数回答のフラグ列は、選択肢のない県でも0になっている。割合は flag_rates か metrics の rate:列 を使う(未設問の県を分母から除く)。run_sql で直接集計するときは list_columns の valid_prefectures で県を絞る。
- 完全重複の行は is_duplicate=1。除くには filters に {"is_duplicate": 0}。
- spend_*_yen はレンジの中央値による概算。富山は回答時刻なし。
- 回答者は無作為抽出ではないため、県間の差には調査方法の違いが含まれる。
- 結果を示すときは出典「北陸インバウンド観光DX・データコンソーシアム(CC BY)」を添える。`;

const FILTERS = {
  type: "object",
  description: "絞り込み。キーは列名(派生列か元の日本語列名)。" +
    "値を配列にするとOR、別のキーはAND。演算子は キー名に __gte __lte __gt __lt __ne __like(部分一致) " +
    '__null(true/false) を付ける。回答日は from / to(YYYY-MM-DD)。例: {"prefecture": "福井", ' +
    '"age_group": ["20代", "30代"], "recommend__lte": 6, "from": "2025-01-01"}',
  additionalProperties: {
    anyOf: [
      { type: ["string", "number", "boolean"] },
      { type: "array", items: { type: ["string", "number", "boolean"] } },
    ],
  },
};
const LIST = (description: string) => ({
  anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  description: description + "(配列かカンマ区切り)",
});
const INT = (description: string) => ({ type: "integer", minimum: 0, description });

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  path: (a: Json) => string;
  /** filters 以外で、そのままクエリに渡す引数 */
  params?: string[];
  method?: "POST";
}

const TOOLS: Tool[] = [
  {
    name: "survey_meta",
    title: "データの概要",
    description: "総件数、県別の件数と期間、自由記述の件数、最終更新、出典を返す。",
    inputSchema: { type: "object", properties: {} },
    path: () => "/api/meta",
  },
  {
    name: "list_columns",
    title: "列の一覧",
    description: "派生列(説明つき)と元の126列、県別の有効回答数、フラグ列の有効な県、" +
      "flag_groups、自由記述の field 名を返す。列名を確かめるときに使う。",
    inputSchema: { type: "object", properties: {} },
    path: () => "/api/columns",
  },
  {
    name: "column_values",
    title: "列の値の分布",
    description: "1つの列の値ごとの件数(多い順。数値の派生列は値の順)。",
    inputSchema: {
      type: "object",
      properties: {
        column: { type: "string", description: "列名" },
        filters: FILTERS,
        limit: INT("最大件数(既定200)"),
        offset: INT("読み飛ばす件数"),
      },
      required: ["column"],
    },
    path: (a) => "/api/columns/" + encodeURIComponent(String(a.column ?? "")),
    params: ["limit", "offset"],
  },
  {
    name: "aggregate",
    title: "集計",
    description: "by の列でグループ化して指標を計算する。指標: count / n:列(有効回答数) / " +
      "distinct:列 / avg:列 / sum:列 / min:列 / max:列 / top2:sat_*(満足度4以上の割合) / " +
      "rate:フラグ列 / nps。平均や割合には分母の n_* が付く。" +
      "share_by に by の列を指定するとその中での構成比、空文字で全体の構成比が share に入る。",
    inputSchema: {
      type: "object",
      properties: {
        by: LIST("グループ化する列。例: prefecture,answered_year"),
        metrics: LIST("指標(既定 count)。例: count,nps,avg:sat_trip"),
        share_by: LIST("構成比の分母とする列"),
        sort: LIST("並び順。先頭に - で降順。例: -count"),
        filters: FILTERS,
        limit: INT("最大行数(既定10000)"),
        offset: INT("読み飛ばす行数"),
      },
    },
    path: () => "/api/aggregate",
    params: ["by", "metrics", "share_by", "sort", "limit", "offset"],
  },
  {
    name: "flag_rates",
    title: "複数回答の選択率",
    description: "目的・情報源・交通手段などの複数回答について、選択肢ごとの選択率を返す" +
      "(選択肢のない県は分母から除く)。",
    inputSchema: {
      type: "object",
      properties: {
        group: {
          type: "string",
          enum: ["purpose", "info_source", "transport_to", "transport_local"],
          description: "purpose=目的, info_source=情報源, transport_to=来訪手段, " +
            "transport_local=県内の移動手段",
        },
        by: LIST("内訳の列。例: age_group"),
        filters: FILTERS,
      },
      required: ["group"],
    },
    path: () => "/api/flags",
    params: ["group", "by"],
  },
  {
    name: "search_comments",
    title: "自由記述の検索",
    description: "自由記述を検索し、回答者の属性(県・年代・おすすめ度など)と一緒に返す。",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "検索語。空白区切りでAND(大文字小文字を区別しない)" },
        field: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "自由記述の列名(list_columns の comment_fields)。複数なら配列",
        },
        order: { type: "string", enum: ["newest", "oldest"], description: "既定 oldest" },
        filters: FILTERS,
        limit: INT("最大件数(既定100)"),
        offset: INT("読み飛ばす件数"),
      },
    },
    path: () => "/api/comments",
    params: ["q", "field", "order", "limit", "offset"],
  },
  {
    name: "query_responses",
    title: "回答の抽出",
    description: "条件に合う回答を行のまま返す。fields で列を絞ること(省略すると全160列以上)。",
    inputSchema: {
      type: "object",
      properties: {
        fields: LIST("返す列。例: answered_at,residence,recommend,回答場所"),
        sort: LIST("並び順。先頭に - で降順"),
        filters: FILTERS,
        limit: INT("最大件数(既定100)"),
        offset: INT("読み飛ばす件数"),
      },
    },
    path: () => "/api/responses",
    params: ["fields", "sort", "limit", "offset"],
  },
  {
    name: "run_sql",
    title: "SQLの実行",
    description: "読み取り専用のSQLite(SELECT / WITH / VALUES / EXPLAIN)を30秒以内で実行する。" +
      "テーブル: survey(1行1回答。派生列+元の126列), comments(survey_id, field, text), " +
      'import_info。記号を含む列名は二重引用符で囲む(例: "対象県（富山/石川/福井）")。' +
      "フラグ列の0は未設問を含むので、valid_prefectures の県に絞って集計すること。",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        params: {
          anyOf: [{ type: "array" }, { type: "object" }],
          description: "? や :name にバインドする値",
        },
        limit: INT("最大行数(既定1000、最大100000)"),
      },
      required: ["sql"],
    },
    path: () => "/api/sql",
    params: ["limit"],
    method: "POST",
  },
];
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function append(q: URLSearchParams, key: string, v: unknown) {
  if (v === undefined || v === null) return;
  if (Array.isArray(v)) {
    for (const x of v) append(q, key, x);
    return;
  }
  if (typeof v === "object") throw new RpcError(-32602, `${key} の値が不正です`);
  q.append(key, String(v));
}

async function callTool(api: Handler, name: string, args: Json) {
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new RpcError(-32602, `不明なツールです: ${name}`);
  const q = new URLSearchParams();
  for (const k of tool.params ?? []) {
    const v = args[k];
    // by / metrics などは配列ならカンマ区切りにまとめる(share_by の空指定も保つ)
    append(q, k, Array.isArray(v) && k !== "field" ? v.join(",") : v);
  }
  const filters = args.filters ?? {};
  if (typeof filters !== "object" || Array.isArray(filters)) {
    throw new RpcError(-32602, "filters はオブジェクトで指定してください");
  }
  for (const [k, v] of Object.entries(filters as Json)) {
    if (k === "format" || (tool.params ?? []).includes(k)) {
      throw new RpcError(-32602, `filters に ${k} は指定できません`);
    }
    append(q, k, v);
  }
  const url = `http://mcp.internal${tool.path(args)}?${q}`;
  const req = tool.method === "POST"
    ? new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: args.sql, params: args.params ?? [] }),
    })
    : new Request(url);
  const res = await api(req);
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error ?? text;
    } catch { /* そのまま返す */ }
    return { content: [{ type: "text", text: `エラー(${res.status}): ${msg}` }], isError: true };
  }
  return { content: [{ type: "text", text }] };
}

/** JSON-RPCメッセージ1つを処理する。通知には null を返す。 */
export async function handleMessage(api: Handler, msg: RpcMessage): Promise<Json | null> {
  const isRequest = msg && typeof msg === "object" && "id" in msg && msg.id !== null;
  const reply = (body: Json) => ({ jsonrpc: "2.0", id: msg.id, ...body });
  try {
    if (
      !msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string"
    ) {
      throw new RpcError(-32600, "Invalid Request");
    }
    if (!isRequest) return null; // notifications/initialized など
    const p = msg.params ?? {};
    switch (msg.method) {
      case "initialize": {
        const v = String(p.protocolVersion ?? "");
        return reply({
          result: {
            protocolVersion: VERSIONS.includes(v) ? v : VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
        });
      }
      case "ping":
        return reply({ result: {} });
      case "tools/list":
        return reply({
          result: {
            tools: TOOLS.map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { readOnlyHint: true, openWorldHint: false },
            })),
          },
        });
      case "tools/call": {
        const args = p.arguments ?? {};
        if (typeof args !== "object" || Array.isArray(args)) {
          throw new RpcError(-32602, "arguments はオブジェクトで指定してください");
        }
        return reply({ result: await callTool(api, String(p.name), args as Json) });
      }
      default:
        throw new RpcError(-32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    if (!isRequest && !(e instanceof RpcError && e.code === -32600)) return null;
    const code = e instanceof RpcError ? e.code : -32603;
    if (code === -32603) console.error(e);
    return {
      jsonrpc: "2.0",
      id: msg?.id ?? null,
      error: { code, message: code === -32603 ? "Internal error" : (e as Error).message },
    };
  }
}

/** Streamable HTTP トランスポート(ステートレス、SSEなし) */
export async function handleMcpHttp(api: Handler, req: Request): Promise<Response> {
  // DNSリバインディング対策: ブラウザからの別オリジンは拒否する
  const origin = req.headers.get("origin");
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === new URL(req.url).host;
    } catch { /* 不正なOrigin */ }
    if (!ok) return rpcResponse({ error: "Forbidden origin" }, 403);
  }
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return rpcResponse({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMessage(api, m)))).filter((x) => x);
    return out.length ? rpcResponse(out) : new Response(null, { status: 202 });
  }
  const out = await handleMessage(api, body as RpcMessage);
  return out ? rpcResponse(out) : new Response(null, { status: 202 });
}

function rpcResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
