import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type WatchStartResult = "started" | "already-running" | "failed";

interface UseWatchConnectionOptions {
  startCommand: string;
  stopCommand: string;
  /** 実行状態を問い合わせるTauriコマンド名。マウント時の状態同期と、start失敗時の
   *  「実は既にRust側で動いていた」の再確認（自己修復）に使う。 */
  isRunningCommand: string;
  /** 監視の実行状態が変化するたびに呼ばれる。ヘッダーボタン等、モーダルの外に
   *  「今、監視中かどうか」を表示するために使う（モーダルを閉じていても分かるように）。 */
  onRunningChange?: (isRunning: boolean) => void;
  /** stop成功時にisRunningを即座にfalseへ更新するかどうか（既定true）。
   *  ターミナル監視のように、実際の終了確定を別のイベント（terminal-exit）で
   *  受け取る場合はfalseを指定し、呼び出し側がそのイベントでsetIsRunningする。 */
  setsRunningFalseOnStop?: boolean;
}

interface UseWatchConnectionResult {
  isRunning: boolean;
  /** terminal-exit等、フック外のイベントリスナーからも実行状態を更新できるようにするため公開する */
  setIsRunning: (value: boolean) => void;
  isSyncingState: boolean;
  isStarting: boolean;
  startError: string | null;
  setStartError: (value: string | null) => void;
  start: (invokeArgs?: Record<string, unknown>) => Promise<WatchStartResult>;
  stop: () => Promise<boolean>;
}

/**
 * ClipboardWatchModal/LogFileWatchModal/TerminalWatchModalの3つが共通で必要とする
 * 「接続ライフサイクル」（マウント時の実行状態同期、start/stop呼び出し、実行状態の
 * 親コンポーネントへの引き上げ）だけを切り出したフック。
 *
 * 3モーダルはそれぞれTauriイベント(listen)の購読対象やペイロード形状、スクロールバック・
 * キーワードテスター等の固有UI状態が大きく異なるため、それらは各モーダル側に残し、
 * このフックは「開始/停止/実行中かどうか」という接続部分のみを担う。
 */
export function useWatchConnection({
  startCommand,
  stopCommand,
  isRunningCommand,
  onRunningChange,
  setsRunningFalseOnStop = true,
}: UseWatchConnectionOptions): UseWatchConnectionResult {
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isSyncingState, setIsSyncingState] = useState<boolean>(true);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [startError, setStartError] = useState<string | null>(null);

  // 監視の実行状態をモーダルの外（ヘッダーボタン等）にも伝える
  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);

  // マウント時、実際にRust側で監視中かどうかを問い合わせて画面状態を補正する。
  // これをしないと、開発中のリロードやアプリ再起動直後の画面表示は常に
  // isRunning=falseから始まってしまい、「実際にはバックグラウンドで監視が
  // 継続しているのに画面には『開始』ボタンしか出ない」という食い違いが起きうる。
  // isRunningCommandは各モーダルが呼び出し時に固定で渡す値であり、実行中に
  // 変わることは想定していないため、依存配列には含めずマウント時一度だけ実行する。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const running = await invoke<boolean>(isRunningCommand);
        if (!cancelled) setIsRunning(running);
      } catch {
        // Tauriアプリの外（ブラウザ単体プレビュー等）では常にfalse扱いのままでよい
      } finally {
        if (!cancelled) setIsSyncingState(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async (invokeArgs?: Record<string, unknown>): Promise<WatchStartResult> => {
    setStartError(null);
    setIsStarting(true);
    try {
      await invoke(startCommand, invokeArgs);
      setIsRunning(true);
      return "started";
    } catch (err) {
      // 画面側は「未実行」のつもりでも、実はRust側で既に監視中だった場合
      // （開発中のリロード等で画面の状態だけがリセットされた場合に起こりうる）、
      // ここで実際の状態を問い合わせて補正する。
      try {
        const running = await invoke<boolean>(isRunningCommand);
        setIsRunning(running);
        if (running) return "already-running";
      } catch {
        // 状態問い合わせ自体に失敗した場合は、下のsetStartErrorにフォールスルーする
      }
      setStartError(String(err).slice(0, 200));
      return "failed";
    } finally {
      setIsStarting(false);
    }
  };

  const stop = async (): Promise<boolean> => {
    try {
      await invoke(stopCommand);
      if (setsRunningFalseOnStop) setIsRunning(false);
      return true;
    } catch (err) {
      setStartError(String(err).slice(0, 200));
      return false;
    }
  };

  return { isRunning, setIsRunning, isSyncingState, isStarting, startError, setStartError, start, stop };
}
