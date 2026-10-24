# What changed in OpenRig 0.7.1

This note is for an agent on an install that was just upgraded to 0.7.1. It lists only what behaves differently from
0.7.0 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`). Five migrations run on the first start (124, 125,
  127, 128 and 129). Five settings are added: `policies.claude_compaction.preparation_root` (unset),
  `skills.router_line.enabled` (off), and `decisions.enabled` (false), `decisions.consumers` and
  `decisions.template_dir`. None is removed.
- **The bundled openrig-core plugin goes from 0.1.17 to 0.1.18.** Startup replaces the installed plugin's changed files:
  its Claude hook definitions, three hook scripts and the pre-compaction hook (so hooks start on a seat whose PATH has
  no Node), and the `openrig-user`, `messaging-the-human` and `forming-an-openrig-mental-model` skills. As in
  0.7.0, it first copies each file it replaces under `$OPENRIG_HOME/backups/managed-refresh/<id>/`, edited or not, and
  logs `[plugin-vendor] preserved previous contents of <file> at <copy> before managed refresh`. A copy doesn't mean
  anyone edited the file; if someone did, reapply the change from the copy.
- **Claude seats need Claude Code 2.1.280 or newer to see their team skills,** which now arrive as a per-seat plugin
  through `CLAUDE_CODE_PLUGIN_DIRS` (below). OpenRig doesn't check the version. A running seat gets the new layout at its
  next launch, restore or handover.
- **If a worktree's `.claude/settings.local.json` says `"defaultMode": "acceptEdits"` and the person didn't choose it,**
  an earlier OpenRig wrote it when it added or freshly launched a managed Claude seat. 0.7.1 no longer writes it but
  doesn't repair it; ask the person which mode they want and set it once.

## New things you can do

- **Choose how much automatic input reaches a seat:** `rig seat set-typing-guard <seat> --mode <mode> --reason "…"`, where
  `<mode>` adds `openrig-urgent` (OpenRig's own notices and anything urgent) and `urgent-only` between `off` and `hold`.
  Mark a message urgent with `rig send --urgent`, or create the row at priority `urgent` or `critical`. Held input stays
  readable (`rig seat held-messages`) and is never replayed.
- **Choose how far OpenRig and peers may act on a seat:** `rig seat set-terminal-policy <seat> --preset
  no-peer-interventions|help-within-instructions|full-control --reason "…"`, with `--helper <addresses…>`,
  `--rig-default` (seats added later), and exceptions such as `--peer-compaction deny` or `--openrig-model allow`.
  Managed compaction and saved model or effort changes are checked; a denial is `terminal_policy_refused`. Other
  interventions are guidance only.
- **Read a seat's planned permissions:** `rig seat status <seat>` shows what its next fresh managed launch will pass and
  where each part comes from, and its terminal policy. `rig setup --router-line yes|no` decides whether OpenRig adds its
  one line to shared guidance files.
- **Let a person choose whether every ask reaches Slack:** `rig gateway human set <id> slack-subscription
  every-ask|urgent-only|unset`. Every ask is on the TUI's Feed either way. Under `urgent-only`, only an ask
  created or handed off with `--alert` posts. An ask marked `--alert` stands out in Slack (an interrupt with a mention)
  under either setting, so use it only for something only they can do, or an approval whose wait costs now.
- **Give one Claude member its own setup** in the rig spec: `agent_file`, `append_system_prompt_file`, `plugin_dirs` and
  `advisor` (an Advisor model). They're copied into that seat's storage, never the project.
- **See a seat's own skills:** `rig skill loadout --seat <session|self>`.
- **Reach the team from an assistant without a shell:** the MCP server has 34 tools, including `rig_whoami`,
  `rig_restore_status`, `rig_team`, `rig_telemetry_events`, following a handoff, reading a finished item's artifact and
  deciding inside a person's decision room. `rig mcp serve --http` serves them over HTTP; `rig mcp token add <name>
  --seat <session>` gives each caller its own seat.
- **Hand a row's task to an outside agent:** `rig acp run <row>` for an ACP agent (Hermes, OpenClaw).
  `docs/reference/a2a-agents.md` covers A2A agents.
- **Run a community harness that names, reports or reopens its conversations:** preset fields `launch_result`, `resume`,
  `names_conversation` and `startup_assisted`, with examples for Cursor, Hermes and OpenClaw under
  `docs/reference/community-harness-examples/`.
- **Change one edge on a running rig:** `rig edge add <rig> <from> <to> --kind <kind>` and `rig edge remove <rig>
  <edge-id>` (`--plan`, `--json`). A `delegates_to` change says when it moves who work routes to.
- **Run one spec as several rigs:** `rig up <spec> --name <rig>`.
- **Retune a watchdog in place:** `rig watchdog update <jobId> [--interval-seconds n] [--message text] [--spec path]`
  keeps its id and attachments. The context watch takes `--threshold-tokens` or `--threshold-percent`.
- **Put restore maps where seats may write:** `rig config set policies.claude_compaction.preparation_root <abs path>`.
- **Pick a Herdr session:** `rig terminal open <view> --provider herdr --session <name>`.
- **Close a row with its artifact:** `rig queue update <id> --state done --evidence-ref <path>`.
- **File and read subscription move reports:** `rig provider moves report` and `rig provider moves`. `--host <id>` and
  `--codex-home <dir>` on `rig auth status|list|switch` and `rig seat restart` act on another machine's Codex home.
- **Route stream observations with typed decisions (opt-in, off by default):** once `decisions.enabled` is true,
  `decisions.consumers` includes `stream` and the intake seat has `OPENROUTER_API_KEY`, `rig project wake --decide`
  gives each eligible stream observation one bounded typed decision during that seat's wake: create a row for a supplied
  owner, join supplied work, or record a duplicate or no action. Anything uncertain, refused or failed goes to the
  intake seat as its own disposition, and the model isn't asked again. `rig project decisions status` shows the state
  without making a call. Without `--decide`, or with decisions off, nothing changes.

## Behaviour that changed

- **Team skills live in each seat's own storage** (`$OPENRIG_HOME/state/seats/<rig id>/<logical seat>/<runtime>/`), not
  in the project's `.claude/skills` or `.agents/skills`. Claude seats get them as a generated plugin (`openrig:<id>`),
  Codex seats as their own catalog. If a link sits in that path, the seat starts without them and the result names
  what wasn't delivered.
- **Urgent wakes are labelled:** an urgent or critical row's wake starts with `Urgent (marked by …):` at every seat. A
  seat on `hold` gets one held notice per wake instead of re-nudges, and lifecycle work is refused at the middle levels as
  at `hold`.
- **A daemon restart picks up a managed compaction where it stopped.** An owed restore step resumes, a `/compact` that
  may have been sent is never sent again, and `rig compact --state` shows anything stranded or owed.
- **A Claude seat whose startup turn is refused** (an expired login, say) holds the rest of its startup context as owed
  instead of typing it.
- **`rig send` refuses with `target_needs_input`** when a Claude seat's hook has just reported it running and its screen
  shows an MCP enablement menu, a question or a permission prompt.
- **`rig down` asks before stopping the caller's own rig.** Without a terminal it exits 1, stops nothing and prints the
  `--yes` command.
- **`rig up --plan` doesn't start a stopped daemon:** it exits 1 with `daemon_not_running` and names `rig daemon start`
  and `--no-kernel`.
- **`rig daemon start`** waits up to 20 seconds for a slow daemon, and starts with a warning when only a secondary
  listener, such as Tailscale's, can't be verified.
- **A seat joined with `rig attach` as an outside app** (Claude Desktop) stays attached through `rig down` and restore
  (`left_attached`). To replace it, `rig unclaim <name>`, then launch.
- **New seats get the daemon's `OPENRIG_DB` and `TMUX_TMPDIR`.**
- **A rebuilt Codex seat keeps its observed permissions,** and a read-only Codex profile launches without OpenRig's
  writable roots.
- **A seat's own role** goes only to that seat, never into a shared `CLAUDE.md` or `AGENTS.md`, and `rig down` returns
  guidance files byte for byte.
- **Workflow actions** (`project`, `route`, `resume`, `abort`) record the calling agent; a request with neither identity
  nor actor gets the shared `actor_required` error.
- **`rig provider moves` is back** for subscription move reports. It switches nothing.

## Output that changed shape

- **`rig ps --nodes`** separates every cell with one space (the default row is 5 columns wider), adds an `ATTN` column
  (`yes`, `no` or `?`) before `REASON`, and marks a `running` seat whose tmux couldn't be reached as unconfirmed.
- **`rig queue show --json`** no longer has `lastNudgeInputBox`, and send results no longer describe the input box.
- **`rig queue show` and `rig queue whoami`** print their human notices on stderr, so stdout is the JSON.
- **A claimed row whose owner waits on a person** reads pickup `needs-input`, with the reason.
- **`rig down --json`** adds `leftRunning`; `rig reconcile-session` says whether resume metadata was recorded.
- **`rig compact-plan`** labels its thresholds as its own and says whether automatic compaction is on.

## What to stop doing

- **Don't read `lastNudgeInputBox`.** It's gone.
- **Don't parse `rig ps --nodes` by column position.** Use `--json`, with `--fields` to pick fields.
- **Don't look for a team seat's skills in the project folders.** Use `rig skill loadout --seat`.
- **Don't stop and re-register a watchdog to change it.** Use `rig watchdog update`.
- **Don't take a rig down to fix one edge.** Use `rig edge add` or `remove`.
- **Don't print `OPENRIG_ACTIVITY_*` values** while looking for identity. Use `rig whoami`.

## Known gaps in 0.7.1

- **A new Claude seat's startup text can stay in its input box unsent.** If a fresh Claude seat sits idle with text at
  its prompt, press Enter in its pane, or ask the person to.
- **Claude seats on a macOS native install can read as needing attention after a restore.** Check the pane before
  acting on it.
- **A Slack channel-mapping change needs a daemon restart.** Don't use `rig slack disable` then `enable` for it: enabling
  marks any alerts waiting to post to Slack as already seen.
- **Ubuntu 22.04's tmux 3.2a:** the query known to crash its server is gone, but a narrower race remains. Avoid 3.2a
  (`tmux -V`).
- **`rig daemon start` can take 20 to 40 seconds** before its listener warning, longer than the TUI's 30-second "restore
  everything" wait. On a slow host, start the daemon yourself first.
- **A launch that warns "Scoped tmux environment unavailable; retaining the previous environment"** didn't give that seat
  the clean environment. Check `env` in the seat before relying on OpenRig's variables.
- **A Herdr tile over SSH** doesn't come back by itself after a Herdr restart. Reopen it with `rig terminal open <view>
  --provider herdr`.
- **Delegated decisions:** the ask is created before the decision, so without quiet hours it can post to the person
  first. Pair a decision room with quiet hours, or decide before asking.
- **`restore-check` still treats a missing startup file as rig-wide.** Trust `rig up --existing`'s per-seat result.
