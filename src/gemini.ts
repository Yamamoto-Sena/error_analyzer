import { AnalysisResult, getOfficialDocLink, TokenUsage } from "./analyzer";
import { FALLBACK_MODEL_IDS, GeminiModelOption } from "./models";
import { maskSensitiveInfo } from "./sanitize";

// エラー画面のスクリーンショット等、Geminiに渡す画像データ（base64・MIMEタイプ）
export interface GeminiImagePart {
  mimeType: string;
  data: string; // base64エンコード済み（"data:image/...;base64,"のプレフィックスは含まない）
}

// 「修正案を適用しても直らなかった」検証時に、直前に提示していた修正案の内容。
// これを渡さないと、Geminiは「これは初見のログ」として解析してしまい、同じ修正案を
// 気づかず繰り返し提案してしまう（＝ユーザーが既に試して効かなかった案を再提示する）リスクがある。
export interface PreviousFixAttempt {
  summary: string;
  rootCause: string;
  fixType?: "code" | "task";
  diffCode?: string;
  taskSteps?: string[];
}

// Gemini API を呼び出す関数
export async function analyzeWithGemini(
  log: string,
  apiKey: string,
  modelName: string = "gemini-3.5-flash-lite",
  images: GeminiImagePart[] = [],
  previousAttempt?: PreviousFixAttempt
): Promise<AnalysisResult> {
  const hasImages = images.length > 0;
  // 外部API（Gemini）へ送信する直前に、ログ内のAPIキー・トークン・パスワード・
  // メールアドレス・パブリックIP等の機密情報らしき文字列をマスクする。
  // ローカルの解析（analyzer.ts）やUI表示には影響しない、送信専用の処理。
  const { sanitized: sanitizedLog, maskedCount: logMaskedCount } = maskSensitiveInfo(log);
  // 検証（再解析）呼び出しの場合のみ、直前に提示した修正案をプロンプトへ含める。
  // 「今回のログはその修正を適用した後に再実行して得られたもの」という前提を明示し、
  // 単純な繰り返し提案を防ぐ。
  // 注意: previousAttemptの各フィールドはGemini自身が前回生成した文章とはいえ、ログの引用や
  // ユーザー環境固有の文字列をそのまま含んでいる可能性があるため、logと同様に送信前マスキング
  // を通す（ここを素通りさせると「Geminiへの送信前に必ずマスクする」という前提が崩れる）。
  let previousAttemptMaskedCount = 0;
  const previousAttemptSection = previousAttempt
    ? (() => {
        const maskedSummary = maskSensitiveInfo(previousAttempt.summary);
        const maskedRootCause = maskSensitiveInfo(previousAttempt.rootCause);
        const maskedDiffCode = previousAttempt.diffCode ? maskSensitiveInfo(previousAttempt.diffCode) : undefined;
        const maskedTaskSteps = (previousAttempt.taskSteps ?? []).map((step) => maskSensitiveInfo(step));
        previousAttemptMaskedCount =
          maskedSummary.maskedCount +
          maskedRootCause.maskedCount +
          (maskedDiffCode?.maskedCount ?? 0) +
          maskedTaskSteps.reduce((sum, m) => sum + m.maskedCount, 0);
        return `
【直前に提示した修正案（検証のための参考情報）】
このログは、以下の修正案を適用したうえで同じ操作を再実行して得られたものです。もし今回の
ログが依然として同じ問題を示している場合、以下のいずれかが効かなかった・不十分だったことを
意味します。単純に同じ内容を繰り返し提案せず、「なぜ効果が無かった可能性があるか」（差分が
実際には正しく適用されていない可能性、副作用、根本原因の見立て自体が誤っていた可能性、等）
も考慮したうえで、代替案または追加で必要な対応を提示してください。
- 前回の要約: ${maskedSummary.sanitized}
- 前回の根本原因: ${maskedRootCause.sanitized}
- 前回の対応内容（${previousAttempt.fixType === "task" ? "手順" : "コード差分"}）: ${
          previousAttempt.fixType === "task"
            ? maskedTaskSteps.map((m) => m.sanitized).join(" / ") || "(記録なし)"
            : maskedDiffCode?.sanitized || "(記録なし)"
        }
`;
      })()
    : "";
  const maskedCount = logMaskedCount + previousAttemptMaskedCount;
  const prompt = `あなたは新人エンジニアを指導する親切で極めて優秀なシニアテックリードです。
以下の情報（エラーログ・スタックトレース、および/またはユーザーが自分の言葉で書いた症状・状況の説明）を深く読み解き、新人エンジニアが根本から理解・再発防止できるように、必ず指定されたJSONフォーマットのみで回答してください。Markdownのバッククォート（\`\`\`json）も含めず、純粋なJSONオブジェクトのみを出力してください。
明確な例外メッセージやスタックトレースがなく、ユーザーによる自然文の症状説明のみが与えられた場合でも、記述内容から最も可能性の高い原因・エラー種別を推測し、断定を避けつつも具体的な仮説として提示してください。
${previousAttemptSection}
【入力内容】
${sanitizedLog.trim() ? sanitizedLog : "(構造化されたログはありません。添付された画像や自然文の説明のみを参照して解析してください)"}

【入力内容に「エラーログ / スタックトレース」「エラー内容・症状の説明（ユーザー記述）」
「添付画像」のうち2つ以上が含まれている場合の判断手順】
まず、それらが本当に「同じ1つの問題」について書かれたものなのか、それとも「互いに無関係な
別々の問題」なのかを判定してください。この判定は非常に重要です。安易にすべてを1つの筋書きへ
まとめようとしないでください。

A. 同じ1つの問題についての、表現の違いや情報量の差（食い違いを含む）だと判断できる場合:
   次の優先順位で統合して解析してください。
   1. 「エラーログ / スタックトレース」（具体的な例外メッセージ・スタックトレース等、機械的に
      出力された一次情報）を最優先とします。
   2. 添付画像（エラー画面やターミナルのスクリーンショット）も同様に一次情報として扱い、ログが
      無い場合やログの内容と整合する場合は積極的に参照してください。ログと画像の内容が食い違う
      場合はログ側を優先してください。
   3. 「エラー内容・症状の説明（ユーザー記述）」は、あくまでユーザー自身の解釈・補足情報として
      参照し、ログ・画像と食い違う場合は最も優先度を下げてください。

B. 明らかに別々の問題・話題について書かれている（例: ログは起動時のポート競合、症状説明欄は
   まったく別の画面のUI不具合の話、など、同じ現象の言い換えとは考えられない）と判断できる場合:
   優先度が最も高い情報源（ログ＞画像＞症状説明の順）**のみ**に基づいて解析し、優先度が低い
   方の内容は rootCause・summary・diffCode・taskSteps・learningContent のどこにも一切
   反映させないでください（無理に関連付けて1つの筋書きに捏造しないこと）。

いずれの場合も、実際に2つ以上の入力があった場合は、出力JSONの"inputPriorityNote"に、実際に
どれを主たる解析対象として採用したか・矛盾または無関係な内容があったかを必ず一言で明記して
ください（例: 「エラーログの内容を優先し、症状説明欄は参考程度に留めました」「症状説明欄の
内容とログの内容が一致していなかったため、ログを優先しています」「症状説明欄の内容はログ欄
とは別の問題を指しているようだったため、解析には含めていません」「ログ・症状説明・画像の
内容は一致していたため、すべてを統合して解析しました」）。
入力が1種類しかない場合、"inputPriorityNote"は空文字列にしてください。
${
  hasImages
    ? `
【添付画像について】
このリクエストにはエラー画面やターミナルのスクリーンショット画像が添付されています。画像内に写っているエラーメッセージ・スタックトレースの文字を正確に読み取り、上記の優先順位に従って解析してください。
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

3.6. diffCodeは「ログから実際に確認できる行」だけで構成する（周辺コードの創作を禁止）:
   - スタックトレースには通常、例外が発生した「その1行」だけが引用され、関数定義や前後の変数代入行までは含まれていません。ログに実際には書かれていない関数名・引数名・周辺コードを、もっともらしく推測して diffCode のコンテキスト行や削除対象行に書き加えることは絶対にしないでください。見た目が自然でも実ファイルの内容と一致せず、ユーザー側での自動適用が必ず失敗します。
   - コンテキスト行（変更のない行）は、ログ中に実際に引用されている行のみを使用し、確認できない行は一切含めないでください。周辺情報が全く無い場合は、変更対象の1行だけを削除(-)・追加(+)で示す最小限のdiff（コンテキスト行0行）にしてください。
   - 十分なコード文脈が無く安全な差分を組み立てられない場合は、無理にdiffCodeを創作せず、diffCodeにはログから読み取れる該当行のみを示すか、fixTypeを"task"にしてtaskStepsで「該当ファイルの該当行を開き、Noneチェックを追加する」等の手順として案内してください。

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
  ],
  "inputPriorityNote": "ログ/症状説明/画像のうち2つ以上が入力されていた場合に、実際に何を優先して解析したか（無関係と判断して除外した情報源があればそれも）の一言説明。入力が1種類だけの場合は空文字列"
}`;

  const call = await callGeminiWithFallback(prompt, apiKey, modelName, images, (rawText) => JSON.parse(rawText));
  const parsed = call.data;
  const errorType = parsed.errorType || "Exception";

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
    modelUsed: call.modelUsed,
    // ユーザーが選択した本来のモデル名（modelUsedと食い違う＝自動フォールバックが発生した証拠）
    modelRequested: call.modelRequested,
    usedFallbackModel: call.usedFallbackModel,
    quotaExceededModels: call.quotaExceededModels,
    // 修正箇所に関連する公式ドキュメント（判別できた場合のみ）
    officialDocLink: getOfficialDocLink(errorType, log) ?? undefined,
    // 送信前にマスクした機密情報らしき箇所の件数（ユーザーへの透明性表示用）
    maskedSecretsCount: maskedCount > 0 ? maskedCount : undefined,
    tokenUsage: call.tokenUsage,
    // ログ/症状説明/画像のうち何を優先して解析したかの説明（App.tsx側で、実際に
    // 2つ以上の入力があった場合のみ表示する。1つしか無い場合はGemini側が空文字列
    // を返す想定だが、念のためここでも空文字列はundefined扱いにする）
    inputPriorityNote: typeof parsed.inputPriorityNote === "string" && parsed.inputPriorityNote.trim()
      ? parsed.inputPriorityNote.trim()
      : undefined,
  };
}

// callGeminiWithFallbackが1回の成功応答について返す情報（呼び出し側の出力スキーマに依存しない共通部分）。
interface GeminiCallResult<T> {
  /** parseResponseコールバックが返した、呼び出し側ごとに異なるパース済みデータ */
  data: T;
  /** Googleが返す実際のモデルバージョン（取得できない場合は実際にリクエストしたモデル名で代用） */
  modelUsed: string;
  /** ユーザーが選択した本来のモデル名（modelUsedと食い違う＝自動フォールバックが発生した証拠） */
  modelRequested: string;
  usedFallbackModel: boolean;
  /** RPD(1日あたりの上限)などのクォータ超過でスキップしたモデル名（発生時のみ） */
  quotaExceededModels?: string[];
  tokenUsage?: TokenUsage;
}

/**
 * プロンプト・画像を受け取り、候補モデルへの逐次リトライ/フォールバックを行う共通処理。
 * analyzeWithGemini・askFollowUpQuestion の両方から呼ばれる（150行規模のリトライ/フォールバック
 * ロジックの重複を避けるために抽出したもの。抽出前の挙動を完全に維持するため、レスポンス本文の
 * パース（parseResponse）も従来通りこのループの中で行い、パース失敗（不正なJSON等）も
 * ネットワークエラーと同様に「次の候補モデルへフォールバック」の対象にしている）。
 */
async function callGeminiWithFallback<T>(
  prompt: string,
  apiKey: string,
  modelName: string,
  images: GeminiImagePart[],
  parseResponse: (rawText: string) => T
): Promise<GeminiCallResult<T>> {
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

      // レスポンス本文のパース。呼び出し側ごとに出力スキーマが異なるためparseResponseに委譲する。
      // ここで例外が起きた場合（不正なJSON等）も、下のcatchで次の候補モデルへフォールバックする
      // （抽出前の挙動と同じ）。
      const cleanedText = text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
      const parsedData = parseResponse(cleanedText);

      return {
        data: parsedData,
        modelUsed: data.modelVersion || model,
        modelRequested: modelName,
        usedFallbackModel: model !== modelName,
        quotaExceededModels: quotaExceededModels.length > 0 ? [...quotaExceededModels] : undefined,
        tokenUsage,
      };
    } catch (err) {
      lastError = err as Error;
      // ネットワークやJSONパースのエラーならループを継続するかスロー
    }
  }

  throw lastError || new Error("Gemini API で利用可能なモデルが見つかりませんでした (404)。APIキーの権限をご確認ください。");
}

// 解析結果に対する自由記述の追加質問（フォローアップ）用のコンテキスト。PreviousFixAttemptと
// 似ているが、質問の対象を明確にするためerrorTypeを含める。
export interface FollowUpContext {
  errorType: string;
  summary: string;
  rootCause: string;
  fixType?: "code" | "task";
  diffCode?: string;
  taskSteps?: string[];
}

export interface FollowUpAnswer {
  answer: string;
  modelUsed: string;
  modelRequested: string;
  usedFallbackModel: boolean;
  quotaExceededModels?: string[];
  tokenUsage?: TokenUsage;
}

/**
 * 解析結果（rootCause/diffCode等）に対するユーザーの自由記述の追加質問にGeminiで回答する。
 * ローカル解析エンジン（analyzer.ts）は決定的な正規表現マッチングのみで自然言語理解の能力を
 * 持たないため、この関数はGemini APIキー必須（呼び出し側でapiKey未設定時はそもそも呼ばないこと。
 * 詳細はFollowUpPanel.tsxのコメントを参照）。
 *
 * トークン消費対策として、この関数は「元の解析結果＋今回の質問」のみを送信し、過去のフォローアップ
 * の往復履歴は含めない（呼び出し側のFollowUpPanel.tsxが往復履歴を溜めても、送信量は毎回ほぼ一定に
 * なる）。
 */
export async function askFollowUpQuestion(
  question: string,
  apiKey: string,
  modelName: string,
  context: FollowUpContext
): Promise<FollowUpAnswer> {
  // 質問文・解析結果の各文字列フィールドも、ログ本文と同じくGeminiへの送信前マスキングを通す
  // （sanitize.tsのmaskSensitiveInfoを再利用。ここを素通りさせると「Geminiへの送信前に必ず
  // マスクする」という要件4.11の前提が崩れる）。
  const maskedQuestion = maskSensitiveInfo(question);
  const maskedSummary = maskSensitiveInfo(context.summary);
  const maskedRootCause = maskSensitiveInfo(context.rootCause);
  const maskedDiffCode = context.diffCode ? maskSensitiveInfo(context.diffCode) : undefined;
  const maskedTaskSteps = (context.taskSteps ?? []).map((step) => maskSensitiveInfo(step));

  const prompt = `あなたは新人エンジニアを指導する親切で優秀なシニアテックリードです。
以下は、あるエラーに対して既に提示した解析結果です。この内容を踏まえて、ユーザーからの追加質問に
日本語で簡潔かつ具体的に回答してください。必ず指定されたJSONフォーマットのみで回答し、Markdownの
バッククォート（\`\`\`json）は含めないでください。

【既に提示した解析結果】
- エラー種別: ${context.errorType}
- 要約: ${maskedSummary.sanitized}
- 根本原因: ${maskedRootCause.sanitized}
- 対応内容（${context.fixType === "task" ? "手順" : "コード差分"}）: ${
    context.fixType === "task"
      ? maskedTaskSteps.map((m) => m.sanitized).join(" / ") || "(記録なし)"
      : maskedDiffCode?.sanitized || "(記録なし)"
  }

【ユーザーからの追加質問】
${maskedQuestion.sanitized}

【出力フォーマット(JSON)】
{
  "answer": "質問への回答本文（日本語、簡潔かつ具体的に）"
}`;

  const call = await callGeminiWithFallback(prompt, apiKey, modelName, [], (rawText) => JSON.parse(rawText) as { answer?: unknown });
  const answer = typeof call.data.answer === "string" && call.data.answer.trim() ? call.data.answer.trim() : "回答を生成できませんでした。";

  return {
    answer,
    modelUsed: call.modelUsed,
    modelRequested: call.modelRequested,
    usedFallbackModel: call.usedFallbackModel,
    quotaExceededModels: call.quotaExceededModels,
    tokenUsage: call.tokenUsage,
  };
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
    // 画像/動画/音声の「生成」や、ロボット制御・リアルタイム対話など特殊用途に特化した
    // モデル（Imagen、Nano Banana (Pro)、Veo、TTS系、Robotics系、Live/Omni系等）は、
    // generateContentに対応していても、このアプリの用途（エラーログのテキスト解析。画像は
    // スクリーンショットの「読み取り」= 入力としてのみ使う、1回のリクエストで構造化JSON
    // 応答を受け取る）には適さないため選択肢から除外する。
    //
    // 加えて、実機診断（診断機能でgenerateContentを実際に叩いた結果）で判明した、
    // 課金プランやアカウントの新旧に関係なく「誰が呼んでも失敗する」モデルも除外する:
    //  - lyria系: 音楽生成専用
    //  - computer-use系: 画面操作エージェント専用
    //  - deep-research系 / antigravity系: generateContentではなくInteractions API専用
    //    （呼ぶと400 "This model only supports Interactions API"）
    //  - transcribe系: 音声書き起こし専用
    //  - gemini-2.5-flash / gemini-2.5-pro / gemini-2.5-flash-lite: 2026年時点でGoogle側が
    //    新規ユーザーへの提供を終了しており、一覧には出るが呼ぶと404になる
    //    （既存の古いプロジェクトのみ引き続き利用可）
    .filter(
      (m) =>
        !/image|imagen|nano.?banana|\bveo\b|text-to-speech|\btts\b|robotics|\blive\b|\bomni\b|lyria|computer-use|deep-research|antigravity|transcribe|gemini-2\.5-(flash|pro)(-lite)?\b/i.test(
          `${m.name} ${m.displayName ?? ""}`
        )
    )
    .map((m) => {
      // API上の名前は "models/gemini-3.5-flash-lite" 形式なのでプレフィックスを除去する
      const value = m.name!.replace(/^models\//, "");
      return { value, label: m.displayName ? `${m.displayName}` : value };
    });

  // 重複除去（同名モデルが複数バリアントで返る場合がある）
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)));
}

// 診断1件分の結果。
// - "ok": 実際にgenerateContentが成功した
// - "unavailable": 404/403等でこのAPIキーでは呼び出せない（一覧には出るが恒久的に使えない）
// - "quota": 429のうち日次/月次クォータ超過が明確なもの（プランのアップグレード等をしない限り使えない）
// - "rate_limited": 429/503のうち一時的な混雑・分あたり制限とみられるもの（後で再試行すれば使える可能性がある）
// - "error": 上記に当てはまらないその他のエラー
export type ModelDiagnosticStatus = "ok" | "unavailable" | "quota" | "rate_limited" | "error";

export interface ModelDiagnosticResult {
  value: string;
  label: string;
  status: ModelDiagnosticStatus;
  httpStatus?: number;
  message?: string;
}

const DIAGNOSTIC_TIMEOUT_MS = 20_000;
// モデル間の送信間隔。0にすると連続リクエストが分あたりレート制限に触れやすく、
// 「本来は使えるモデル」まで rate_limited と誤診断してしまうため、少し間隔を空ける。
const DIAGNOSTIC_INTERVAL_MS = 500;
// 429/503を一時的な混雑とみなして軽くリトライする回数（analyzeWithGeminiと同じ考え方）
const DIAGNOSTIC_RETRY_DELAYS_MS = [1000, 2000];

/**
 * プルダウン（listAvailableModelsが返す一覧）に表示されている各モデルへ、実際に
 * 最小限のgenerateContentリクエストを1回ずつ順番に送り、「一覧には出るが実際には
 * 呼び出せない」モデルを洗い出す診断機能。
 *
 * 注意: モデルの数だけAPI呼び出し（＝クォータ消費）が発生するため、一覧取得のたびに
 * 自動実行してはならず、ユーザーが診断ボタンを押した時だけ呼び出すこと。
 */
export async function diagnoseModels(
  apiKey: string,
  models: GeminiModelOption[],
  onProgress?: (doneCount: number, total: number, current: GeminiModelOption) => void
): Promise<ModelDiagnosticResult[]> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const results: ModelDiagnosticResult[] = [];

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    onProgress?.(i, models.length, model);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.value}:generateContent`;
    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DIAGNOSTIC_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: "OKとだけ一言で返答してください。" }] }],
            generationConfig: { maxOutputTokens: 8, temperature: 0 },
          }),
        });

        if (response.ok) {
          results.push({ value: model.value, label: model.label, status: "ok" });
          break;
        }

        const bodyText = await response.text().catch(() => "");
        let message = bodyText;
        try {
          message = JSON.parse(bodyText)?.error?.message || bodyText;
        } catch {
          // JSONでなければ本文をそのまま使う
        }

        if (response.status === 429 || response.status === 503) {
          const isDailyQuota =
            response.status === 429 &&
            /RESOURCE_EXHAUSTED|quota/i.test(bodyText) &&
            /per[\s_]?day|daily|PerDay/i.test(bodyText);

          if (isDailyQuota) {
            results.push({ value: model.value, label: model.label, status: "quota", httpStatus: response.status, message: message.slice(0, 300) });
            break;
          }

          if (attempt < DIAGNOSTIC_RETRY_DELAYS_MS.length) {
            await sleep(DIAGNOSTIC_RETRY_DELAYS_MS[attempt]);
            attempt++;
            continue;
          }

          results.push({ value: model.value, label: model.label, status: "rate_limited", httpStatus: response.status, message: message.slice(0, 300) });
          break;
        }

        if (response.status === 404 || response.status === 403) {
          results.push({ value: model.value, label: model.label, status: "unavailable", httpStatus: response.status, message: message.slice(0, 300) });
          break;
        }

        results.push({ value: model.value, label: model.label, status: "error", httpStatus: response.status, message: message.slice(0, 300) });
        break;
      } catch (err) {
        const isTimeout = err instanceof DOMException && err.name === "AbortError";
        results.push({
          value: model.value,
          label: model.label,
          status: "error",
          message: isTimeout ? `タイムアウトしました（${DIAGNOSTIC_TIMEOUT_MS / 1000}秒）` : (err as Error).message,
        });
        break;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (i < models.length - 1) await sleep(DIAGNOSTIC_INTERVAL_MS);
  }

  onProgress?.(models.length, models.length, models[models.length - 1]);
  return results;
}

