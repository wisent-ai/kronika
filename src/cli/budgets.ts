// The largest TCP port a GUI can bind. Source, diff and completion budgets
// are the caller's: a flag or a sync manifest field states each one, and a run
// that needs one nobody stated is refused by name. No budget is a clock: a
// Brama request ends with its answer or a transport error.

export const MAX_PORT = 65_535;

/** The budget `value` given as `flag`, or a refusal naming the flag. */
export const requiredBudget = (value: number | undefined, flag: string): number => {
  if (value === undefined) throw new Error(`${flag} <n> is required for this command: no budget is assumed`);
  return value;
};
