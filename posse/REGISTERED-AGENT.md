# Registered agent bridge

`posse-agent chat` and `posse-agent run` are application commands. The resident
automation owner executes the turn. The CLI sends one newline-framed
`posse.registered_agent_request.v1` request over the registered socket and
prints one `bossy.agent_turn.v1` envelope. It never starts or replaces the owner.

```sh
printf '%s' '{"message":"What should I focus on?","pre_run_context":[],"inputs":{"account_ref":"opaque-account-123"}}' |
  posse-agent chat kairos-angel --session kairos-angel-chat-123 \
    --idempotency-key kairos-ai-job-456 --request-json --json
```

The idempotency key is mandatory and unique per registration identity, agent,
operation, and semantic request. An identical retry returns the terminal
receipt. Changing the message, bootstrap, context, or session selector under
the same key returns `idempotency_conflict`. Busy retries use
`agent_request_busy` or `agent_session_busy`; retry those with the same key.
`inputs` is an optional JSON object of private, fixed values supplied by the
application. Each script tool declares its caller-facing values in an `inputs`
JSON object schema beside its agent-facing `params` schema in `tool.json`.
Posse derives the registered agent call contract from those schemas, validates
the supplied values, and fills each tool's declared inputs when it runs. The
model sees only `params` and cannot supply or override `inputs`. Both kinds of
values reach the script as JSON on stdin and scalar `PARAM_*` variables.
For example, a tool can declare `"inputs":{"type":"object",
"additionalProperties":false,"properties":{"account_id":{"type":"string"}},
"required":["account_id"]}` while its `params` declares the scene ID the
model chooses. The registered request supplies `account_id` once per call in `inputs`;
the tool receives both values.
Supply the same `inputs` on every turn of a chat: a conversation pins their
digest and rejects a change. Posse stores the digest, not the values, with the
conversation. Tool scripts must treat the values as private and avoid echoing
them in results. To publish a tool that declares caller inputs, use
`posse tools test NAME --input-file args.json --inputs-file private.json`;
keep the private file out of source control and remove it after testing.
The key never grants access to another client's conversation. A one-shot
`run` returns an audit ID that cannot be resumed.

Each completed invocation returns `usage` for that invocation, not the whole
conversation: `input_tokens` (including cached input), `cache_read_tokens`,
`cache_write_tokens`, `uncached_input_tokens`, and `output_tokens`. It also
returns `billable_input_tokens`, `billable_output_tokens`, and `billable_tokens`
as input-rate-equivalent units calculated from Posse's current pricing data,
plus `cost_usd`. Billable fields are `null` when Posse has no applicable rate.
If an outcome is unknown after a service interruption, `usage` can be `null`
because reporting zero would conceal a possible provider call.

Set `"include_tool_summary":true` in the request JSON to receive a
`tool_summary` array alongside the always available `tool_calls` statuses.
Each item contains the tool name, status, effect, duration, and a bounded
structured result when the tool returned JSON. Posse redacts declared secrets
and private inputs before recording or returning a script result; a result over
8 KiB is marked `result_truncated` and omitted. The response reports
`tool_summary_omitted` if the reply limit forces Posse to drop summary items.
Without this opt-in, no tool results are returned to the calling application.

Exit codes: 0 for `done`, 1 for terminal failure or retryable busy, 2 for
`needs_confirmation`, 64 for invalid input, 69 for owner unavailability, and
77 for registration denial. Read the JSON status and safe error code on every
exit. `needs_confirmation` carries no application-resumable authority.

On Linux, `posse-agent` discovers the system gateway at
`/run/posse-agent/public.sock` when no credential file is configured. The
gateway reads kernel peer credentials, resolves the account's current groups,
and forwards a signed request through a private owner socket. The owner checks
the selected exposure on every invocation and before returning a stored
receipt. Neither a caller-supplied UID nor a copied credential expands the
exposure's audience. Applications do not need socket group membership or
bridge-specific environment settings.
If more than one named exposure for an agent matches the caller, select one
with `posse-agent chat NAME --client CLIENT_ID ...`.

The legacy bearer path remains available for unmigrated clients. Provision a
256-bit credential with `posse agent clients create` and place its one-time
value in a private file readable by the application identity. The file may
contain `{"client_id":"kairos","credential":"..."}` and be selected with
`POSSE_AGENT_REGISTRATION_FILE`, or the credential alone may be selected with
`POSSE_AGENT_CREDENTIAL_FILE` plus `POSSE_AGENT_CLIENT_ID`. Set
`POSSE_REGISTERED_AGENT_SOCKET` to the private system socket and
`POSSE_AGENT_EXPECTED_UID` to the numeric owner UID. Once a named client is
registered as an exposure, its bearer-only path is denied. During migration,
`POSSE_AGENT_USE_GATEWAY=1` sends an explicitly configured credential through
the gateway, where the OS audience still applies. Remove the credential file
after that path is verified.

Operator examples:

```sh
posse agent clients create kairos --agent kairos-angel --operation chat \
  --context get_angel_personality --context get_user_brief
posse agent clients rotate kairos
posse agent clients revoke kairos
posse agent repository save REPO_ID /srv/approved-repository
sudo posse agent register kairos-angel --client kairos --user www-data \
  --operation chat --context get_angel_personality --context get_user_brief
sudo posse agent registrations list kairos-angel
sudo posse agent registrations show kairos-angel --client kairos
sudo posse agent registrations revoke kairos-angel --client kairos
```

An executable runs at the exact digest the conversation pinned and needs an
applicable current grant. There is no separate safety label: the operator
who installs a tool is the one who registers the agent that lists it. The
bounds that stay are real ones: a builtin's repository and folder resources
and a SQL capability's fixed folder. A write needs only the agent's
`write_tools: allow`. Prompt tools are data-only context. Global and legacy
general agents cannot be exposed.

For an opt-in Linux machine owner, first install the tested Posse package in a
root-owned, non-writable system path (for example
`/opt/posse-agent/current/posse`) and configure the owner's provider secrets
in `/etc/posse-agent/owner.env`. Then run as root:

```sh
posse agent service install --system --package-root /opt/posse-agent/current/posse
```

`posse agent register NAME` also installs and verifies this service and its
gateway, stages an audience, probes each audience class as an OS user, then
activates it. `--user` and `--group` are repeatable; without them, local OS
users are admitted globally with separate client identities. A named client
requires an explicit audience and shares its existing conversations with every
member of that audience. If the agent was created in the operator's per-user
automation database, registration imports its definition and prompt contexts
from `~/.posse/automation.db` (or `--source-data-dir DIR`). Executable grants
are never copied silently; missing dependencies fail registration
without activating the audience. The command never prints a credential.
When the operator edits an already registered definition, repeat registration
with the same audience, operations, contexts, and budget plus
`--source-data-dir DIR --update-definition`. This explicitly replaces the
system owner's copy before reactivating the exposure; failed staging or probes
restore the prior definition if no other operator has changed it. Existing
conversations remain pinned to their
original definition and must be restarted after an update.
Revoked exposures are terminal for ordinary retries. To restore one, repeat
`posse agent register` with `--restore-preserving-conversations`; this explicit
choice keeps the named or local client identities and their existing receipts,
stages a new policy, and requires the usual probes before activation. Use a
new named client ID when the prior conversation namespace must not be shared.

The owner keeps its private state under `/var/lib/posse-agent`. The gateway's
public socket is `/run/posse-agent/public.sock`; its private backend socket and
key are inaccessible to application accounts. The legacy socket remains
`/run/posse-agent/agent.sock` for unmigrated bearer clients. Every process
running under an authorized OS account shares that account's authority.
Linux peer credentials are captured when a connection is established, so an
authorized process can deliberately proxy or transfer its connection; separate
OS accounts are needed for application isolation. Before deleting, reassigning,
or removing and later readding an authorized OS account, run
`posse agent registrations retire-user UID` as root. This rotates its local
identity generation so a reused UID cannot recover its old local sessions.
`posse agent service status --system` and `posse agent service remove --system`
inspect or remove the units; removal keeps state and receipts. Windows per-user
hosting remains available; Windows machine hosting needs the separate native
service host before deployment.

Chat content is kept for 90 days after the last turn, then the session ID is
tombstoned. Public receipt content is kept for 30 days. Idempotency keys and
audit tombstones remain reserved indefinitely so an old write key cannot be
executed again. Tool outcomes whose commit status is unknown after a restart
return `external_outcome_unknown` and require operator reconciliation. The
registered store retains aggregate spend evidence after public content expires.
