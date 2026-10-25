// Fixed loopback ports + deterministic text for the Auto-dispatch real-browser
// E2E harness (isolated from M3/Calendar/Memory/AGORA).
//
// 4194  AUTODISPATCH_APP_PORT      real server + real planner + real TrialRunner
// 4195  AUTODISPATCH_CONTROL_PORT  loopback-only model/planner observation

export const AUTODISPATCH_APP_PORT = 4194;
export const AUTODISPATCH_CONTROL_PORT = 4195;
export const AUTODISPATCH_APP_ORIGIN = `http://127.0.0.1:${AUTODISPATCH_APP_PORT}`;
export const AUTODISPATCH_CONTROL_ORIGIN = `http://127.0.0.1:${AUTODISPATCH_CONTROL_PORT}`;

/** First completed human turn used as the standing-policy source anchor. */
export const AD_TEXT_ANCHOR =
  "README.md の見出しを確認して、このセッションで結果を報告したいです。";
/** Concrete follow-up that the background planner turns into one candidate trial. */
export const AD_TEXT_EXECUTE =
  "README.md の見出しを実際に確認して、結果を報告してください。今すぐ実行して構いません。";
/** Negated/discussion turn: must never create an execution. */
export const AD_TEXT_DISCUSS =
  "README.md の見出しについて相談したいだけです。実行しないでください。";
/** Turn whose planner output carries an unresolved user decision. */
export const AD_TEXT_MISSING =
  "README.md の見出しを確認したいですが、どの範囲まで報告するか決めていません。";
/** Turn whose planner output carries markup (must render as text). */
export const AD_TEXT_XSS =
  "README.md の見出しを確認する件について相談したいです。実行しないでください。";

export const AD_XSS_GOAL =
  '<img src=x onerror="window.__autodispatchXss=1"> & <script>window.__autodispatchXss=2</script>';
