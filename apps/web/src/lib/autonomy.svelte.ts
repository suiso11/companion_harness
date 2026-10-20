// Shared autonomy-changed signal (PR-5 review fix, review comment on
// ShadowPanel): the legacy shell exposed notifyAutonomyChanged() so the
// autonomy panel could tell the sibling shadow panel that purposes/tasks
// changed. The native pages mount the panels as siblings on /shadow with no
// shared parent state, so this tiny reactive counter replaces the hook:
// AutonomyPanel bumps it after every successful create/transition, and any
// interested panel tracks `readAutonomyVersion()` inside a `$effect` to
// refetch.
let autonomyVersion = $state(0);

/** Called by AutonomyPanel after a successful autonomy mutation. */
export function notifyAutonomyChanged(): void {
  autonomyVersion += 1;
}

/**
 * Reactive read: track this inside a `$effect` that must re-run when the
 * autonomy surface commits a create/transition.
 */
export function readAutonomyVersion(): number {
  return autonomyVersion;
}
