// The largest TCP port a GUI can bind: ports are 16-bit numbers
// (https://www.rfc-editor.org/rfc/rfc9293#section-3.1, "Source Port: 16 bits"). Source, diff and completion budgets
// are the caller's and optional: a flag or a sync manifest field states one,
// and an unstated one is no limit. No budget is a clock: a Brama request ends
// with its answer or a transport error.

export const MAX_PORT = 65_535;
