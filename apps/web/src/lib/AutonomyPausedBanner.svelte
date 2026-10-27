<script lang="ts">
// Persistent "autonomy paused" notice. The server re-applies the pause fence
// on every restart by design, so a paused snapshot is expected after a boot
// and stays visible until the operator explicitly resumes. Reads the same
// GET /api/autonomy/control snapshot as AutonomyPanel; the resume button
// reuses the shared CAS + frozen Idempotency-Key request builder.
import { onMount } from "svelte";
import { randomUuid } from "./api.js";
import {
  AUTONOMY_BANNER_REFRESH_MS,
  type AutonomyControlSnapshot,
  autonomyBannerState,
  type FrozenResumeCommand,
  fetchAutonomyControl,
  frozenResumeCommand,
  postAutonomyControl,
  shouldPollBanner,
} from "./autonomy_control.js";

let snapshot = $state<AutonomyControlSnapshot | null>(null);
let busy = $state(false);
let notice = $state("");
// Frozen retry state: an uncertain outcome keeps the SAME key + version.
let pending: FrozenResumeCommand | null = null;

async function refresh(): Promise<void> {
  snapshot = await fetchAutonomyControl();
}

async function resume(): Promise<void> {
  const current = snapshot;
  if (current === null || !current.paused || busy) return;
  busy = true;
  const command = frozenResumeCommand(pending, current.version, randomUuid());
  pending = command;
  try {
    const result = await postAutonomyControl(
      false,
      command.expectedVersion,
      command.key,
    );
    if (result.status === 0 || result.status >= 500) {
      notice = "通信が不確定です。もう一度「再開」を押してください";
      return;
    }
    // Definitive reply (2xx/4xx): the frozen command is done.
    pending = null;
    if (result.status === 200) {
      notice = "自律動作を再開しました";
    } else if (result.status === 409) {
      notice = "他の変更がありました。状態を更新しました";
    } else {
      notice = "再開に失敗しました";
    }
    await refresh();
  } finally {
    busy = false;
  }
}

onMount(() => {
  // An already-open page must discover a pause applied from another tab
  // (`/tasks`) or by a server restart, so revalidate on focus, on tab
  // visibility, and on a low-frequency poll (review #155).
  const onFocus = (): void => {
    void refresh();
  };
  const onVisibility = (): void => {
    if (shouldPollBanner(document.visibilityState)) void refresh();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  const timer = window.setInterval(() => {
    if (shouldPollBanner(document.visibilityState)) void refresh();
  }, AUTONOMY_BANNER_REFRESH_MS);
  void refresh();
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    window.clearInterval(timer);
  };
});
</script>

{#if autonomyBannerState(snapshot) === "paused"}
  <section
    class="autonomy-paused-banner"
    aria-label="自律動作の一時停止"
    role="status"
  >
    <p>
      自律動作は一時停止中です（再起動のたびに停止します）。試行を動かすには「再開」を押してください。
    </p>
    <button
      id="autonomy-paused-resume"
      type="button"
      disabled={busy}
      onclick={() => void resume()}
    >
      再開
    </button>
    {#if notice.length > 0}
      <p class="autonomy-paused-notice" aria-live="polite">{notice}</p>
    {/if}
  </section>
{/if}

<style>
  .autonomy-paused-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--secondary);
    color: var(--secondary-foreground);
    font-size: 0.85rem;
  }

  .autonomy-paused-banner p {
    margin: 0;
    flex: 1 1 18rem;
  }

  .autonomy-paused-banner button {
    flex: 0 0 auto;
  }

  .autonomy-paused-notice {
    flex-basis: 100%;
  }
</style>
