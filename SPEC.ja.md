# agent-koans 適合契約(Conformance Contract)

Version: 0.1.0-draft

> 本書は [SPEC.md](./SPEC.md) の参考訳です。規範(normative)となるのは英語版であり、
> 相違がある場合は英語版が優先されます。

agent-koans は、AIエージェント実装のためのフレームワーク非依存の適合スイートです。
エージェントの振る舞いのうち「実装側の半分」— 引数バリデーション、失敗リカバリ、
冪等な実行、コンテキスト管理、終端保証 — を、モデルを完全にモックした上で
決定的に検証します。モデルの能力は測りません。それはevalsの仕事です。

リリースされたスイートバージョンのすべてのkoanに合格した実装が「適合」です。
適合性の表明は必ずスイートバージョンを明示しなければなりません
(例: 「agent-koans 1.x / tool-reliability に適合」)。

MUST / MUST NOT / SHOULD / MAY は RFC 2119 の定義に従います。

## 1. アーキテクチャ

被テストエージェントはHTTPインターフェースの背後にあるブラックボックスです。
ハーネスはそれを両側から観測します:

```
ハーネス ──(1) POST /runs──────────▶ 被テストエージェント(ブラックボックス)
                                        │
   モックLLMサーバー ◀──(2) chat/completions──┤
   モックツールサーバー ◀──(3) invoke/{tool}──┘
```

1. ハーネスがタスクとツール定義を投入する。
2. エージェントは本物のモデルの代わりに **モックLLMサーバー**
   (OpenAI Chat Completions互換)と通信する。モックはkoan毎の台本に従って応答する。
3. エージェントはツールを **モックツールサーバー** に対して実行する。
   その応答も同様に台本化されている。

アサーションの大半は (2)(3) の**受信リクエスト**に対して実行されます。
リトライ回数、引数の忠実性、コンテキスト管理は、実装の内部に一切
触れずに検証されます。

## 2. 環境

ハーネスは以下の環境変数と共にエージェントプロセスを起動します:

| 変数              | 意味                                                          |
| ----------------- | ------------------------------------------------------------- |
| `PORT`            | エージェントがlistenしなければならない(MUST)ポート           |
| `OPENAI_BASE_URL` | モックLLMサーバーのベースURL(`/v1` プレフィックスを含む)     |
| `OPENAI_API_KEY`  | ダミーの認証情報。送信必須(MUST)だが検証はされない           |
| `KOAN_TOOLS_URL`  | モックツールサーバーのベースURL                                |

エージェントは、すべてのモデル呼び出しを `OPENAI_BASE_URL` へ、
すべてのツール実行を `KOAN_TOOLS_URL` へ向けなければなりません(MUST)。

## 3. エージェントHTTPインターフェース

### 3.1 `GET /health`

Readinessプローブ。runを受け付けられる状態になったら `200` を
返さなければなりません(MUST)。

### 3.2 `POST /runs`

タスクを投入します。

```json
{
  "task": { "prompt": "Get the current weather in Tokyo and report it." },
  "tools": [
    {
      "name": "get_weather",
      "description": "Look up current weather",
      "input_schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  ]
}
```

`tools` は空でも構いません(MAY)。`input_schema` はツール引数を記述する
JSON Schemaオブジェクトです。

レスポンス: `201` または `202`。ボディに `run_id`(string)を含むこと。

### 3.3 `GET /runs/{run_id}`

```json
{ "run_id": "r_1", "status": "completed", "output": "The weather in Tokyo is 31°C." }
```

`status` は以下のいずれかでなければなりません(MUST):

| status      | 意味                                                     |
| ----------- | -------------------------------------------------------- |
| `running`   | 非終端。runは進行中                                      |
| `completed` | 終端。`output` に最終回答を含むこと(MUST)              |
| `failed`    | 終端。`error` で理由を説明すべき(SHOULD)               |
| `aborted`   | 終端。キャンセルまたは断念                               |

**終端保証。** すべてのrunは有限時間内に必ず終端状態に到達しなければ
なりません(MUST)— ツールの失敗、モデルの誤動作、内部エラーの如何に
かかわらず。ハーネスのタイムアウトを過ぎても `running` のままのrunは
koanに不合格となります。

未知の `run_id` には `404` を返すべきです(SHOULD)。

## 4. モデルとのやりとり

エージェントは OpenAI Chat Completions API
(`POST {OPENAI_BASE_URL}/chat/completions`、非ストリーミング)でモデルと
通信します。モックLLMはkoanの台本から応答し、受信した各リクエストは
台本の次のエントリと照合されます。

要件:

- **R1 — ツール定義。** ツール付きで投入されたrunでは、すべてのモデル
  リクエストに全ツールのfunction定義を含めなければなりません(MUST)。
- **R2 — ツール結果。** ツール呼び出しの実行後、エージェントはモデルの
  tool callと一致する `tool_call_id` を持つ `role: "tool"` メッセージを
  追記し、更新された会話をモデルに送り返さなければなりません(MUST)。
- **R3 — エラー報告。** ツール呼び出しが失敗した場合 — ツールサーバーが
  ステータス400以上を返した、または引数がバリデーションに失敗した — その失敗を
  `error` という語(大文字小文字不問)を含む `role: "tool"` メッセージとして、
  利用可能な詳細(ステータスコード、エラーボディ、バリデーションメッセージ)
  と共にモデルへ報告しなければなりません(MUST)。
- **R4 — 暗黙のリトライ禁止。** エージェントは失敗したツール呼び出しを
  自らリトライしてはなりません(MUST NOT)。リトライの判断はモデルに
  属します: エラーを報告し(R3)、モデルに判断させること。モデルの
  1つのtool callは最大1回のツールサーバー呼び出しに対応します。
- **R5 — 有界ループ。** エージェントはrunあたりのモデルステップ数に
  上限を設け、上限超過時にはrunを終端させなければなりません(MUST。
  終端保証)。

## 5. ツール実行

ツールはモックツールサーバーへの呼び出しとして実行されます:

```
POST {KOAN_TOOLS_URL}/invoke/{name}
Content-Type: application/json

{ "city": "Tokyo" }
```

リクエストボディはパース済みのツール引数です。ステータス400以上の
レスポンスはツールの失敗です(R3/R4参照)。成功した呼び出しの
レスポンスボディは、ツール結果のcontentとしてモデルから参照可能に
しなければなりません(MUST)。

- **R6 — 引数バリデーション。** ツールを実行する前に、エージェントは
  引数をそのツールの `input_schema` に対して検証しなければなりません
  (MUST)— 最低限、`required` プロパティと宣言されたプロパティの
  プリミティブ型。検証に失敗した場合、ツールサーバーを呼び出しては
  ならず(MUST NOT)、R3に従ってモデルへ報告すること。
- **R7 — 未知のツール。** runの `tools` に存在しないツール名を持つ
  tool callをツールサーバーへ到達させてはなりません(MUST NOT)。
  R3に従って報告すること。

## 6. koanファイル形式

koanは given / when / then 構造の宣言的YAMLファイルです。
キーは役者名(`model`、`tools`)で、動詞はエントリ側に置かれます。

```yaml
name: retry-on-transient-failure
description: >
  A transient 5xx must reach the model as a tool error, and the follow-up
  call must succeed without double-firing the tool.

given:                    # エージェントに与えられる世界
  task: "Get the current weather in Tokyo and report it."
  tools:
    - name: get_weather
      input_schema:
        type: object
        properties: { city: { type: string } }
        required: [city]

when:                     # モックの振る舞い(台本)
  model:                  # 順番に消費。モデルリクエスト1回につき1エントリ
    - call_tool: { name: get_weather, args: { city: "Tokyo" } }
    - expecting: tool_error         # N回目のリクエストのあるべき姿をアサート
      call_tool: { name: get_weather, args: { city: "Tokyo" } }
    - expecting: tool_result
      reply: "The weather in Tokyo is 31°C."
  tools:
    get_weather:          # 順番に消費。呼び出し1回につき1エントリ
      - respond: { status: 503, body: { error: "service_unavailable" } }
      - respond: { status: 200, body: { temp: 31 } }

then:                     # アサーション
  run:
    status: completed
    output: { contains: "31" }
  tools:
    get_weather:
      last_args: { equals: { city: "Tokyo" } }
```

`given.tools` のデフォルトは空リストであり、省略できます(MAY)。

### 6.1 `when.model` エントリ

モックLLMはN回目のリクエストにN番目のエントリで応答します。各エントリは
1つのアクション — `reply: <text>` または `call_tool: { name, args }` — と、
受信リクエストに対する任意の `expecting` アサーションを持ちます:

| `expecting`   | リクエストが示すべき状態                                    |
| ------------- | ----------------------------------------------------------- |
| `initial`     | まだツールとのやりとりがない(最後のメッセージはユーザータスク) |
| `tool_result` | 最後のメッセージが成功した `role: "tool"` の結果            |
| `tool_error`  | 最後のメッセージが `role: "tool"` のエラー報告(R3準拠)    |

台本の終端を超えたリクエスト、または `expecting` と矛盾するリクエストは
koanを不合格にします。

**台本の消費。** runは台本全体を消費しなければなりません — すべての
`when.model` エントリと、台本化されたすべてのツール応答を、過不足なく。
台本の長さ*そのもの*が呼び出し回数のアサーションであるため、回数を
`then` で明示的にアサートすることはありません。

### 6.2 `then` のmatcher

キーは名詞(役者のプロパティ)、matcherは構造化された値です。
語彙は**閉じたセット**であり、汎用クエリ言語は導入しません:

| matcher                 | 意味                                     |
| ----------------------- | ---------------------------------------- |
| スカラー値              | `equals` の省略形                        |
| `{ equals: <value> }`   | 深い等値比較                             |
| `{ contains: <str> }`   | 部分文字列マッチ                         |
| `{ matches: <regex> }`  | 正規表現マッチ                           |

意味的アサーション: `tools.<name>.last_args`、`expecting`、および
暗黙の台本消費ルール(§6.1)。新しい検証ニーズは汎用matcherではなく、
名前付きアサーションとしてここに追加されます。

## 7. バージョニング

スイートは全体として1つのバージョンを持ちます(semver):

- **major** — SPECの非互換変更、または既存koanの意味の変更
- **minor** — koanまたは章の追加。既存koanは不変
- **patch** — pass/failの結果に影響しない修正

公開済みのkoanはイミュータブルです: koanの契約線を変えたい場合は、
それをsupersedeする新しいkoanを追加し、旧koanをdeprecatedにします
(次のmajorで削除)。利用者はスイートバージョンを固定し、意図的に
アップグレードし、koanのバージョンを混在させるのではなく、既知の失敗を
理由付きのskiplistで管理すべきです(SHOULD)。
