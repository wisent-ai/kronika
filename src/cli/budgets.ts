// The budgets a run starts with unless a flag says otherwise: source bytes in
// total and per file, completion tokens, the Git diff a check reads, and the
// largest TCP port a GUI can bind. No budget is a clock: a Brama request ends
// with its answer or a transport error.

export const DEFAULT_MAX_INPUT_BYTES = 200_000;
export const DEFAULT_MAX_FILE_BYTES = 64_000;
export const DEFAULT_MAX_TOKENS = 8_000;
export const DEFAULT_MAX_DIFF_BYTES = 200_000;
export const MAX_PORT = 65_535;
