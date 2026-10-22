// Pure list-action decisions shared by the legacy client and the Svelte
// memory panel. Both surfaces keep separate search/detail generations and a
// browse view that can be re-entered while reads are still in flight.

/**
 * Run binding used by the list browse: the active run wins, else the latest
 * rendered/known run. `null` means "no Run yet" and the browse must not send
 * a request (the memory API requires the originating runId).
 */
export function browseRunId(
  activeRunId: string | null,
  latestRenderedRunId: string | null,
): string | null {
  return activeRunId ?? latestRenderedRunId;
}

/**
 * Generations to publish when returning to browse. Bumping BOTH makes an
 * abandoned search and an abandoned detail read stale, so neither can apply
 * its late response over the fresh browse state.
 */
export function returnToBrowseGenerations(
  searchSeq: number,
  detailSeq: number,
): { readonly searchSeq: number; readonly detailSeq: number } {
  return { searchSeq: searchSeq + 1, detailSeq: detailSeq + 1 };
}

/**
 * Search-button disabled state after 「すべて表示」 abandoned an in-flight
 * search. The abandoned search's `finally` sees a stale generation and never
 * touches the button, so the reset must happen here: enabled for a fresh
 * search, but kept disabled while a mutation is still in flight.
 */
export function searchButtonDisabledAfterAbandon(mutating: boolean): boolean {
  return mutating;
}
