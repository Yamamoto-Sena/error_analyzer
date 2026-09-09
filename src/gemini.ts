import { AnalysisResult, getOfficialDocLink, TokenUsage } from "./analyzer";
import { FALLBACK_MODEL_IDS, GeminiModelOption } from "./models";
import { maskSensitiveInfo } from "./sanitize";

// エラー画面のスクリーンショット等、Geminiに渡す画像データ（base64・MIMEタイプ）
export interface GeminiImagePart {
  mimeType: string;
  data: string; // base64エンコード済み（"data:image/...;base64,"のプレフィックスは含まない）
}

// Gemini API を呼び出す関数
export async function analyzeWithGemini(
  log: string,
  apiKey: string,
  modelName: string = "gemini-3.5-flash-lite",
  images: GeminiImagePart[] = []
): Promise<AnalysisResult> {
  const hasImages = images.length > 0;
  // 外部API（Gemini）へ送信する直前に、ログ内のAPIキー・トークン・パスワード・
  // メールアドレス・パブリックIP等の機密情報らしき文字列をマスクする。
  // ローカルの解析（analyzer.ts）やUI表示には影響しない、送信専用の処理。
  const { sanitized: sanitizedLog, maskedCount } = maskSensitiveInfo(log);
  const prompt = `あなたは新人エンジニアを指導する親切で極めて優秀なシニアテックリードです。
以下の情報（エラーログ・スタックトレース、および/またはユーザーが自分の言葉で書いた症状・状況の説明）を深く読み解き、新人エンジニアが根本から理解・再発防止できるように、必ず指定されたJSONフォーマットのみで回答してください。Markdownのバッククォート（\`\`\`json）も含めず、純粋なJSONオブジェクトのみを出力してください。
明確な例外メッセージやスタックトレースがなく、ユーザーによる自然文の症状説明のみが与えられた場合でも、記述内容から最も可能性の高い原因・エラー種別を推測し、断定を避けつつも具体的な仮説として提示してください。

【入力内容】
${sanitizedLog.trim() ? sanitizedLog : "(構造化されたログはありません。添付された画像や自然文の説明のみを参照して解析してください)"}
${
  hasImages
    ? `
【添付画像について】
このリクエストにはエラー画面やターミナルのスクリーンショット画像が添付されています。画像内に写っているエラーメッセージ・スタックトレースの文字を正確に読み取り、上記の内容と同様のルールで解析してください。テキストと画像の内容が両方存在する場合は、両者を統合して矛盾なく判断してください。
`
    : ""
}

【極めて重要な解析ルール】
1. 発生箇所（filePath / lineNumber）の正確な特定:
   - Pythonの「Traceback (most recent call last):」では、**スタックの一番最後（最下部）に表示されているフレームが実際に例外を投げた直接の発生箇所**です。途中の呼び出し元（中間のフレーム）を誤って発生箇所にしないでください。
   - 例: 末尾が「File "/app/src/controllers/api_controller.py", line 15」であれば、発生箇所は「/app/src/controllers/api_controller.py」の「15行目」です。

2. 「何が起きたか」「根本原因」のデータ状態・因果関係の明記:
   - 「例外がスローされました」「エラーが発生しました」といった表面的な説明は厳禁です。
   - スタック全体のデータフロー（例: 「関数AがDBからデータ取得できず None を返却した → 呼び出し元の変数 response が None になった → 15行目で response.user_id を参照しようとして AttributeError が発生した」など）、**データの状態変化と因果関係**を初心者にも分かりやすく具体的に解説してください。

3. 開発環境やインフラエラーの判別:
   - ポート競合（Port already in use / EADDRINUSE）、ビルド失敗、TauriのbeforeDevCommandエラー等の場合は、プロセスの重複や設定不備を指摘し、diffCodeには実行すべきターミナルコマンド（taskkillやStop-Process等）を具体的に記載してください。

3.5. 修正手段が「コードの差分」か「手順・作業」かの判別（fixType）:
   - コードを1〜数行書き換えるだけで直せる場合（TypeError, SyntaxError, ReferenceError, AttributeError 等の多くのロジックバグ）は fixType を "code" とし、diffCode に Unified Diff 形式の修正前後を記載してください。
   - コードの変更ではなく、コマンド実行（依存パッケージのインストール、プロセスの強制終了等）、アプリやサーバーの再起動、LANケーブル/USBの抜き差し、設定ファイルのGUI操作、外部サービス側の障害対応待ちなど、**人手による手順の実施が解決策そのものである場合**は fixType を "task" とし、taskSteps に実施すべき手順を1つずつ具体的な文字列として配列で記載してください（各手順にコマンドが必要な場合はその文字列内に含めてください）。判断に迷う場合は "code" としてください。

4. 初心者の自立を促す「学習メモ」と「再発防止策」:
   - なぜこのバグが起きるのか（NoneType / Nullの性質、安全なアクセス構文など）の理論的背景を「learningContent」に書き、具体的な防止策（Nullチェック、型ヒント、Optional型の活用等）を提示してください。

【出力フォーマット（JSON）】
{
  "errorType": "エラー種別（例: AttributeError, TypeError, EADDRINUSE 等）",
  "summary": "何が起きているかの平易な要約（1〜2文）",
  "rootCause": "データの状態遷移を含めた根本原因の丁寧な解説（どこで何が起きてどの値が原因で落ちたか）",
  "filePath": "例外が発生した真のファイルパス（例: /app/src/controllers/api_controller.py）",
  "lineNumber": "発生行番号（例: 15行目）",
  "diffCode": "fixTypeが\\"code\\"の場合の修正前後のUnified Diff（--- a/... +++ b/... @@ ... @@ -修正前 +修正後）。\\"task\\"の場合も参考情報として実行コマンド等を記載してよい",
  "fixType": "\\"code\\"（コードの差分で直せる）または \\"task\\"（コマンド実行・再起動・ケーブル抜き差し等、手順による対応が必要）のいずれか",
  "taskSteps": ["fixTypeが\\"task\\"の場合に実施すべき具体的な手順を1つずつ配列で記載。\\"code\\"の場合は空配列 [] にする"],
  "learningTitle": "💡 新人エンジニア向け学習タイトル",
  "learningContent": "このエラーの背後にある言語仕様や技術的概念の解説",
  "preventionTips": [
    "再発防止のための具体的なアドバイス1",
    "再発防止のための具体的なアドバイス2",
    "再発防止のための具体的なアドバイス3"
  ]
}`;

  // Google AI Studio の公式有効モデル候補（指定モデルを最優先、次にsrc/models.tsで定義した
  // 現行の代表的モデルで自動試行。一覧はApp.tsxの表示用一覧と共通のファイルで一元管理している）
  const candidateModels = Array.from(new Set([modelName, ...FALLBACK_MODEL_IDS]));

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // 503(UNAVAILABLE) や 429のうち「一時的な混雑・レート制限」は、
  // 別モデルに切り替える前に同一モデルへ軽くリトライする
  const RETRY_DELAYS_MS = [1000, 2000];
  // ネットワークが応答不能になった場合でも解析ボタンが永久に固まらないよう、
  // 1回のfetchごとに上限を設けて必ず中断する
  const FETCH_TIMEOUT_MS = 45_000;

  // RPD(1日あたりの上限)などのクォータ超過でスキップしたモデルを記録（診断用）
  const quotaExceededModels: string[] = [];
  let lastError: Error | null = null;

  for (const model of candidateModels) {
    try {
      // APIキーはURLクエリではなく x-goog-api-key ヘッダーで送る
      // （devtoolsのネットワークログ等にキーがそのまま残ってしまうのを避けるため）
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      let response: Response;
      let errorBodyText: string | null = null;
      let attempt = 0;

      while (true) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: prompt },
                    ...images.map((img) => ({
                      inline_data: { mime_type: img.mimeType, data: img.data },
                    })),
                  ],
                },
              ],
              generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.2,
              },
            }),
          });
        } catch (fetchErr) {
          // タイムアウト(AbortError)の場合は、ネットワークがハングしたまま
          // 「解析中...」が固まり続けないよう、分かりやすいメッセージにして
          // 通常のエラーフロー（次候補モデルへの切り替え/最終エラー送出）に乗せる
          if (fetchErr instanceof DOMException && fetchErr.name === "AbortError") {
            throw new Error(
              `Gemini APIへの接続がタイムアウトしました（${FETCH_TIMEOUT_MS / 1000}秒経過）。ネットワーク状態をご確認のうえ、もう一度お試しください。`
            );
          }
          throw fetchErr;
        } finally {
          clearTimeout(timeoutId);
        }

        if (response.status === 429 || response.status === 503) {
          errorBodyText = await response.text();
          // "RESOURCE_EXHAUSTED" かつ 1日/月単位のクォータに言及している場合は
          // 待っても無駄なRPD超過とみなし、即座に次の候補モデルへ切り替える
          const isQuotaExceeded =
            response.status === 429 && /RESOURCE_EXHAUSTED|quota/i.test(errorBodyText) && /per[\s_]?day|daily|PerDay/i.test(errorBodyText);

          if (isQuotaExceeded) {
            quotaExceededModels.push(model);
            break;
          }

          // それ以外の429/503は一時的な混雑・レート制限とみなし軽くリトライ
          if (attempt < RETRY_DELAYS_MS.length) {
            await sleep(RETRY_DELAYS_MS[attempt]);
            attempt++;
            errorBodyText = null;
            continue;
          }
        }
        break;
      }

      if (response.status === 404) {
        // モデルが見つからない場合は次の候補を試行
        continue;
      }

      if (!response.ok) {
        const errorBody = errorBodyText ?? (await response.text());
        throw new Error(`Gemini API エラー (${response.status}): ${errorBody}`);
      }

      const data = await response.json();
      // 実際に応答したモデルを確認するためのログ（リクエストしたモデル名 vs 実際に返ってきたバージョン）
      console.log(`[Gemini] requested="${modelName}" tried="${model}" actualModelVersion="${data.modelVersion ?? "(不明)"}"`);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error("Gemini からの応答が空でした。");
      }

      // JSON パース
      const cleanedText = text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
      const parsed = JSON.parse(cleanedText);
      const errorType = parsed.errorType || "Exception";
      // トークン消費量（画面表示・セッション累計用）。Geminiが返さない場合もあるため、
      // 3つとも揃って初めて意味のある数値として扱う（片方だけ欠けると誤解を招くため）。
      const usage = data.usageMetadata;
      const tokenUsage: TokenUsage | undefined =
        typeof usage?.promptTokenCount === "number" &&
        typeof usage?.candidatesTokenCount === "number" &&
        typeof usage?.totalTokenCount === "number"
          ? {
              promptTokens: usage.promptTokenCount,
              responseTokens: usage.candidatesTokenCount,
              totalTokens: usage.totalTokenCount,
            }
          : undefined;
      return {
        errorType,
        summary: parsed.summary || "エラーが検出されました。",
        rootCause: parsed.rootCause || "詳細な原因を特定中。",
        filePath: parsed.filePath || "src/index.ts",
        lineNumber: parsed.lineNumber || "1行目",
        diffCode: parsed.diffCode || "--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n- old\n+ new",
        fixType: parsed.fixType === "task" ? "task" : "code",
        taskSteps: Array.isArray(parsed.taskSteps) ? parsed.taskSteps.filter((s: unknown) => typeof s === "string" && s.trim()) : [],
        learningTitle: parsed.learningTitle || "💡 学習ポイント",
        learningContent: parsed.learningContent || "エラーハンドリングを適切に行いましょう。",
        preventionTips: Array.isArray(parsed.preventionTips)
          ? parsed.preventionTips
          : ["入力値の検証を行う", "テストを実行する"],
        // Googleが返す実際のモデルバージョン（取得できない場合は実際にリクエストしたモデル名で代用）
        modelUsed: data.modelVersion || model,
        // ユーザーが選択した本来のモデル名（modelUsedと食い違う＝自動フォールバックが発生した証拠）
        modelRequested: modelName,
        usedFallbackModel: model !== modelName,
        quotaExceededModels: quotaExceededModels.length > 0 ? [...quotaExceededModels] : undefined,
        // 修正箇所に関連する公式ドキュメント（判別できた場合のみ）
        officialDocLink: getOfficialDocLink(errorType, log) ?? undefined,
        // 送信前にマスクした機密情報らしき箇所の件数（ユーザーへの透明性表示用）
        maskedSecretsCount: maskedCount > 0 ? maskedCount : undefined,
        tokenUsage,
      };
    } catch (err) {
      lastError = err as Error;
      // ネットワークやJSONパースのエラーならループを継続するかスロー
    }
  }

  throw lastError || new Error("Gemini API で利用可能なモデルが見つかりませんでした (404)。APIキーの権限をご確認ください。");
}

/**
 * Google AI Studio が現在そのAPIキーで実際に利用可能なモデル一覧を動的に取得する。
 * src/models.ts のハードコードされた一覧は、Google側のラインナップ変更（新モデル追加・
 * 旧モデル廃止）に追従できないという弱点があるため、可能な場合はこちらを優先して使う。
 * 呼び出し側は失敗時（オフライン・キー未設定・権限不足等）に models.ts の
 * AVAILABLE_MODELS へフォールバックすること。
 */
export async function listAvailableModels(apiKey: string): Promise<GeminiModelOption[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  let response: Response;
  try {
    response = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      method: "GET",
      headers: { "x-goog-api-key": apiKey },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`モデル一覧の取得に失敗しました (${response.status})`);
  }

  const data = await response.json();
  const models: unknown[] = Array.isArray(data.models) ? data.models : [];

  const options: GeminiModelOption[] = models
    .map((m) => m as { name?: string; displayName?: string; supportedGenerationMethods?: string[] })
    // このアプリはテキスト生成(generateContent)のみを使うため、対応していないモデル
    // （embedding専用モデル等）は選択肢から除外する
    .filter((m) => m.name && m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => {
      // API上の名前は "models/gemini-3.5-flash-lite" 形式なのでプレフィックスを除去する
      const value = m.name!.replace(/^models\//, "");
      return { value, label: m.displayName ? `${m.displayName}` : value };
    });

  // 重複除去（同名モデルが複数バリアントで返る場合がある）
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)));
}

