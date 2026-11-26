# 北陸観光アンケート API

`output_merge/` のCSV(富山・石川・福井の観光アンケート、126列)と、`fiscalyearly/` のCSV(福井県の過去データ)をSQLiteに取り込み、分析用に問い合わせるAPIサーバーです。Deno 2 と組み込みの `node:sqlite` で動きます。

## 使い方

```sh
deno task update   # 最新CSVを取得し、変更があれば data/survey.db を作り直す
deno task serve    # http://127.0.0.1:8000/(稼働中は毎日自動更新)
deno task import   # 手元のCSVだけから data/survey.db を作り直す(約6秒)
deno task test
```

ポートなどは `PORT=8080 HOST=0.0.0.0 deno task serve` で変更できます。認証はないため、既定では自分のPCからだけ接続できます。DBが作り直されると、サーバーは再起動なしで新しいデータに切り替わります。

## 毎日の自動更新

サーバーの稼働中は、毎日15時(JST)に上流の更新を確認します。上流の更新は6時予定ですが、実際の反映は9〜14時ごろになるためです。

- その日の更新がまだなければ3時間おき、失敗時は1時間おきに再確認します。
- 起動時やスリープ復帰時に確認が遅れていれば、すぐ(最大5分以内)に追いつきます。
- 統合CSVと福井県の過去データの両方を確認します。過去データ側だけ取得できないときは、手元のものを使って更新を続け、`last_update` の `warnings` に記録します。
- 変わったファイルだけを、コミットを固定して取得し、ハッシュを照合します。
- 次の場合は手元のCSVとDBを変えずにエラーを記録します: 取得失敗、ハッシュ不一致、列構成の変更、県別件数の5%を超える減少、ファイルの消失。件数の減少が正しいと確認できたら `deno task update --force` で反映できます。
- 結果は `/api/meta` の `last_update`(`ok` `error` `last_ok_at` `updated_at` など)で確認できます。
- 自動更新を止めるには `AUTO_UPDATE=0 deno task serve`。

サーバーを常時動かさない場合は、cronなどで `deno task update` を実行してください。

```
0 15 * * * cd /path/to/opendata-hokuriku-kanko && deno task update
```

## 一括ダウンロード

トップページから、全データをgzip圧縮したファイルをダウンロードできます(容量はトップページと `/api/meta` の `downloads` に表示)。

| パス | 内容 | 容量の目安 |
|---|---|---|
| `/download/survey.db.gz` | SQLiteデータベース(`survey` `comments` `import_info`) | 約33MB(展開後 約190MB) |
| `/download/survey.csv.gz` | `survey` テーブルのCSV(BOM付きUTF-8、派生列+元の126列) | 約21MB(展開後 約165MB) |

`gunzip survey.db.gz` などで展開して使います。DBを作り直すたび(`deno task import` / `deno task update` / 自動更新)に、`data/download/` に作り直されます(約9秒)。APIで全件を取得するより、こちらを使ってください。

## エンドポイント

どれも `format=csv` でCSV(BOM付き)になります(`/api/meta`、`/api/columns` を除く)。

| パス | 内容 | 固有パラメータ |
|---|---|---|
| `/api/meta` | 件数・期間・取り込み日時 | |
| `/api/columns` | 列の一覧、県別の有効回答数 | |
| `/api/columns/{列}` | 値の分布 | `limit` `offset` |
| `/api/responses` | 回答の抽出 | `fields` `sort` `limit`(既定100) `offset` |
| `/api/aggregate` | 集計 | `by` `metrics` `share_by` `sort` `limit` `offset` |
| `/api/flags` | 複数回答の選択率 | `group`(`purpose` `info_source` `transport_to` `transport_local`) `by` |
| `/api/comments` | 自由記述の検索 | `q`(空白区切りでAND) `field` `order` `limit` `offset` |
| `/api/sql` | 任意のSELECT(GET `?sql=` / POST) | `limit`(既定1000、最大100000) |

### 絞り込み(responses / aggregate / flags / comments / columns/{列} 共通)

- `列=値`。同じ列を繰り返すとOR、別の列はAND: `?gender=女&age_group=20代&age_group=30代`
- `列__gte` `__lte` `__gt` `__lt` `__ne` `__like`(部分一致) `__null=true|false`
- `from=2025-01-01&to=2025-12-31`(回答日)

列名は、下の派生列と元の日本語列名のどちらも使えます。不明なパラメータは400エラーです。

### 自由記述の並び順(`/api/comments`)

`order=newest` で回答日時の新しい順、`order=oldest`(既定)で古い順です。富山は回答時刻がないため、同じ日の中では最も早い時刻として並びます。

### 集計の指標(`metrics`、カンマ区切り)

`count` / `n:列`(有効回答数) / `distinct:列` / `avg:列` / `sum:列` / `min:列` / `max:列` / `top2:sat_trip`(満足度4以上の割合) / `rate:フラグ列` / `nps`

平均や割合には、分母となる有効回答数 `n_*` が付きます。`share_by=prefecture` を付けると県内の構成比、`share_by=`(空)で全体の構成比が `share` に入ります。

### 例

```
/api/aggregate?by=prefecture,answered_year&metrics=count,nps,avg:sat_trip
/api/aggregate?by=prefecture,residence_region&share_by=prefecture
/api/flags?group=purpose&by=age_group&prefecture=福井
/api/comments?q=駐車場&prefecture=石川&recommend__lte=5&order=newest
```

```sh
curl http://127.0.0.1:8000/api/sql -H 'content-type: application/json' \
  -d '{"sql": "SELECT 回答場所, count(*) n FROM survey WHERE prefecture = ? GROUP BY 1 ORDER BY n DESC", "params": ["福井"]}'
```

SQLは読み取り専用の子プロセスで実行し、30秒で打ち切ります。記号(`/` や `( )`)を含む列名は `"対象県（富山/石川/福井）"` のように二重引用符で囲みます。

## MCP

Claude などのAIアシスタントから、MCP(Model Context Protocol)のツールとして使えます。ツールは上のエンドポイントと同じ内容です。

| ツール | 対応するAPI |
|---|---|
| `survey_meta` | `/api/meta` |
| `list_columns` | `/api/columns` |
| `column_values` | `/api/columns/{列}` |
| `aggregate` | `/api/aggregate` |
| `flag_rates` | `/api/flags` |
| `search_comments` | `/api/comments` |
| `query_responses` | `/api/responses` |
| `run_sql` | `/api/sql` |

絞り込みは `filters` にオブジェクトで渡します(例: `{"prefecture": "福井", "age_group": ["20代", "30代"], "recommend__lte": 6}`)。

**stdio**(サーバーを動かさずに使う。Claude Desktop など):

```sh
claude mcp add hokuriku-kanko -- deno task --config /path/to/opendata-hokuriku-kanko/deno.json mcp
```

```json
{
  "mcpServers": {
    "hokuriku-kanko": {
      "command": "deno",
      "args": ["task", "--config", "/path/to/opendata-hokuriku-kanko/deno.json", "mcp"]
    }
  }
}
```

**HTTP**(`deno task serve` の稼働中、`/mcp` で受け付けます):

```sh
claude mcp add --transport http hokuriku-kanko http://127.0.0.1:8000/mcp
```

別オリジンのブラウザからの `/mcp` へのリクエストは拒否します。

## テーブル

- `survey`: 1行1回答。派生列(`prefecture` `answered_date` `age_group` `income_group` `nights_total` `sat_*` `recommend` `spend_*_yen` など。説明は `/api/columns`)+ 元の126列。元の列は空欄をNULLにした以外は変更していません(福井の2022年度は変換後の値)。
- `comments`: 自由記述8列を縦持ちにしたもの(`survey_id`, `field`, `text`)。
- `import_info`: 取り込み情報。

## データの注意点

- **期間が県で違う**: 福井 2022-04〜、石川 2023-09〜、富山 2025-04〜。3県合計の推移は構成の変化を含むため、`by=prefecture` を推奨します。
- **福井の2022年度**: 統合CSVにない2022-04-28〜2023-03-10の18,726件を、年度別CSVから同じ126列に変換して加えています(`source_file=fukui_fiscalyearly_2022.csv`。除くには `source_file__ne=fukui_fiscalyearly_2022.csv`)。
  - 変換規則は統合CSVと同じです(2023年度以降の福井89,065件を同じ規則で変換し、改行の除去などの差を除いて全件一致することを確認済み)。会員IDも同じく `000000` に置き換えています。
  - 2023-03-11〜2023-04-27は、どちらのデータにも福井の回答がありません。
  - 「満足度(商品・サービス)」の設問がなく、`sat_service` はNULLです。
  - 回答エリアの名称が2023年度以降と違うもの(例: あわら温泉 エリア)があります。
  - 統合CSVに同じ期間の福井データが入った場合は、二重計上を避けて過去データを使いません。
- **福井の自由記述**: 「不便さの内容」「施設に求めるもの」「福井県に求めるもの」などは、統合CSVに入っていないため、過去データでも取り込んでいません。
- **フラグの0は「未設問」を含む**: 県ごとに選択肢が違いますが、元データは一律0です。`rate` と `/api/flags` は、選択肢のない県を分母から除きます(どの県を使うかは `/api/columns` の `valid_prefectures`。県別の立ち方を見て `src/columns.ts` で手動定義)。SQLで直接集計するときは各自で除外してください。
- **除外したフラグ**: 「デジタルニュース」(富山の回答にはあるがフラグが全件0)と「ラブライブのスタンプラリー」。「その他の目的」は石川・富山で「その他スポーツ」と同数のため福井のみ有効ですが、福井も「その他スポーツ」の選択者482件に1が立っています。
- **石川の「年代」列は生年**: `age` / `age_group` は回答年との差で算出(最大1歳の誤差)。
- **世帯年収**: 富山は区分が粗いため `income_group` は共通4区分。富山の旧選択肢「300～500万円」は新表記と同じ300〜599万円とみなしています。
- **金額**: `spend_*_yen` はレンジの中央値で、10万円以上は100,000円とした概算です。
- **富山の回答日は日付のみ**で、`answered_hour` はNULLです。
- **完全重複が23行**: 残したまま `is_duplicate=1` を付けています。除くには `is_duplicate=0`。
- 回答者は無作為抽出ではないため、県間の差には調査方法の違いが含まれます。

## データ出典

- https://github.com/hokuriku-inbound-kanko/opendata/ (北陸インバウンド観光DX・データコンソーシアム、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/))
  - 原データ: 富山県(CC BY)、石川県(CC BY 2.1 JP)、福井観光協会「FTAS」(CC BY 4.0)
- https://github.com/code4fukui/fukui-kanko-survey/tree/master/fiscalyearly (福井県観光データ分析システム「FTAS」、提供: 福井観光連盟。ライセンスは上記リポジトリの帰属表示でCC BY 4.0)

`output_merge/` と `fiscalyearly/` のCSVは、それぞれ上記リポジトリの同名フォルダから取得したものです。
