// What `kronika --help` prints: every command, every option and the sentences
// that say what a run will and will not do. Held as text of its own because it
// is the product speaking to a person rather than logic.


const HELP = `Kronika — source-grounded documentation writing through Brama

Usage:
  kronika init [--docs <path>] [--source <path>] [--replace] [options]
  kronika gui [--repo <path>] [--port <n>]
  kronika sources [options]
  kronika check --base <ref> [options]
  kronika write [options]
  kronika sync [options]
  kronika onboarding [--advance | --skip | --reset | --status] [--json]

Commands:
  init                  Adopt existing repository documentation into the
                        canonical kronika.sync.json project manifest
  gui                   Host the local existing-project importer without
                        opening a browser
  check                 Audit one exact Git change against current documentation
  sources               Show the safe source manifest without calling Brama
  write                 Generate complete Markdown through Brama
  sync                  Reconcile every manifest-declared document with the
                        repository: audit drifted ones, rewrite only audited
                        defects, and record the reconciled commit
  onboarding            Walk the first-use journey Kronika ships, one screen at
                        a time, and replay it with --reset

Options:
  --repo <path>          Repository root (default: current directory)
  --output <path>        Target document inside the repository (default: README.md)
  --docs <path>          Existing Markdown file or directory for init; repeatable
  --port <n>             GUI loopback port (default: operating-system assigned)
  --source <path>        Explicit source file or directory; repeatable
  --base <ref>           Base Git commit for check (required)
  --head <ref>           Head Git commit for check (default: HEAD)
  --instruction <text>   Additional documentation goal
  --model <selector>     Brama model selector (default: KRONIKA_MODEL or any)
  --max-input-bytes <n>  Total source budget (default: none; every selected source is read)
  --max-file-bytes <n>   Per-file source limit (default: none)
  --max-tokens <n>       Completion token budget (default: none sent; the Brama alias's own limit)
  --max-diff-bytes <n>   Git diff budget for check (default: none; the whole diff is audited)
  --apply                Atomically replace the target document
  --manifest <path>      Sync manifest inside the repository (default: kronika.sync.json)
  --state <path>         Sync state file inside the repository (default: kronika.sync-state.json)
  --dry-run              Sync: report and audit, but write no file and no state
  --commit               Sync: commit rewritten documents and the state file
  --push                 Sync: push the sync commit
  --replace              Init: replace a conflicting existing sync manifest
  --advance              Onboarding: move to the next screen
  --skip                 Onboarding: dismiss the journey
  --reset                Onboarding: replay the journey from its first screen
  --status               Onboarding: report an existing attempt without starting one
  --json                 Print the result as a JSON document for a machine; without it every
                         command prints the same result as text for a person
  -h, --help             Show this help

Brama environment:
  BRAMA_URL (or MODEL_ROUTER_URL)   Brama, or without it any OpenAI-compatible provider
  BRAMA_API_KEY_ROLE              ROLE#FIELD: the role the item holding the bearer plays, and its field
  WISENT_APP_AGENT_ID             optional; unset, requests go unsigned
  WISENT_APP_AGENT_AUTH_SECRET_ROLE  ROLE#FIELD of the signing secret
  STADO_BIN                       the stado executable the roles are read through (default: stado on PATH)
  KRONIKA_CREDENTIALS_FILE        without Stado: owner-only JSON file of role -> field -> value
                                  that answers every ROLE#FIELD reference
  KRONIKA_MODEL (optional)

Without --apply, write prints the generated Markdown and does not change files.
Check exits non-zero when it reports a documentation blocker.
Sync's first run for a document records a baseline and generates nothing;
every later run audits only documents whose declared sources changed, and
exits non-zero when any document failed to reconcile.
Onboarding needs no Brama route: it completes when kronika init durably
adopts an existing documentation workspace. The gui command binds only
127.0.0.1, prints its session URL, and never opens a browser.`;

/// What `kronika <command> --help` prints: the command's usage lines and its
/// paragraph from the command list, then the shared options, so a person asking
/// about one command reads about that command first (cli.md rule 11). A word
/// that names no command gets the whole help.
const helpFor = (command: string): string => {
  const lines = HELP.split("\n");
  const usage = lines.filter((line) => line.startsWith(`  kronika ${command} `) || line === `  kronika ${command}`);
  if (usage.length === 0) return HELP;
  const commands = lines.indexOf("Commands:");
  const options = lines.indexOf("Options:");
  const description: string[] = [];
  for (let index = commands + 1; index < options; index += 1) {
    const line = lines[index];
    if (line.startsWith(`  ${command} `)) description.push(line);
    else if (description.length > 0 && line.startsWith("                        ")) description.push(line);
    else if (description.length > 0) break;
  }
  const rest = lines.slice(options).join("\n");
  return ["Usage:", ...usage, "", "Command:", ...description, "", rest].join("\n");
};

export { HELP, helpFor };
