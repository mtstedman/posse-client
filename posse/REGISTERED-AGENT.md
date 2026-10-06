# Registered agent bridge

`posse-agent chat` and `posse-agent run` are application commands. The resident
automation owner executes the turn. The CLI sends one newline-framed
`posse.registered_agent_request.v1` request over the registered socket and
prints one `bossy.agent_turn.v1` envelope. It never starts or replaces the owner.

```sh
printf '%s' '{"message":"What should I focus on?","pre_run_context":[]}' |
  posse-agent chat kairos-angel --session kairos-angel-chat-123 \
    --idempotency-key kairos-ai-job-456 --request-json --json
```

The idempotency key is mandatory and unique per registration identity, agent,
operation, and semantic request. An identical retry returns the terminal
receipt. Changing the message, bootstrap, context, or session selector under
the same key returns `idempotency_conflict`. Busy retries use
`agent_request_busy` or `agent_session_busy`; retry those with the same key.
The key never grants access to another client's conversation. A one-shot
`run` returns an audit ID that cannot be resumed.

Exit codes: 0 for `done`, 1 for terminal failure or retryable busy, 2 for
`needs_confirmation`, 64 for invalid input, 69 for owner unavailability, and
77 for registration denial. Read the JSON status and safe error code on every
exit. `needs_confirmation` carries no application-resumable authority.

Provision a 256-bit credential with `posse agent clients create` and place its
one-time value in a private file readable by the application identity. The
file may contain `{"client_id":"kairos","credential":"..."}` and be selected
with `POSSE_AGENT_REGISTRATION_FILE`, or the credential alone may be selected
with `POSSE_AGENT_CREDENTIAL_FILE` plus `POSSE_AGENT_CLIENT_ID`. Set
`POSSE_REGISTERED_AGENT_SOCKET` to the system socket and
`POSSE_AGENT_EXPECTED_UID` to the numeric owner UID. The CLI checks the Unix
socket owner and its parent before sending the credential. The development
default is the current user's private automation data directory.

Operator examples:

```sh
posse agent trust approve script:application.lookup --level application_safe --reviewed-by mason
posse agent clients create kairos --agent kairos-angel --operation chat \
  --context get_angel_personality --context get_user_brief
posse agent clients rotate kairos
posse agent clients revoke kairos
posse agent repository save REPO_ID /srv/approved-repository
```

An executable needs an exact-digest `application_safe` approval and an
applicable current grant. Existing entries default to `operator_only`.
Approving a new script version requires a new review. A write also needs the
agent's `write_tools: allow` and an unattended grant. The operator's script
review must establish that arguments and tool credentials cannot escape its
declared resource contract. Prompt tools are data-only context and need no
executable approval. Global and legacy general agents cannot be exposed.

For an opt-in Linux machine owner, first install the tested Posse package in a
root-owned, non-writable system path (for example
`/opt/posse-agent/current/posse`). Then run as root:

```sh
posse agent service install --system --package-root /opt/posse-agent/current/posse
```

The unit uses the dedicated `posse-agent` user, a private state directory under
`/var/lib/posse-agent`, and `/run/posse-agent/agent.sock` with group
`posse-agent-clients`. Add only the intended application identity to that
group. The application must still present its own credential. Application
accounts sharing one Unix identity or one readable credential directory share
that OS trust domain. Keep operator tokens, provider secrets, and tool code
outside application-readable paths. `posse agent service status --system` and
`posse agent service remove --system` inspect or remove the unit; removal keeps
state and receipts. Windows per-user hosting remains available; Windows machine
hosting needs the separate native service host before deployment.

Chat content is kept for 90 days after the last turn, then the session ID is
tombstoned. Public receipt content is kept for 30 days. Idempotency keys and
audit tombstones remain reserved indefinitely so an old write key cannot be
executed again. Tool outcomes whose commit status is unknown after a restart
return `external_outcome_unknown` and require operator reconciliation. The
registered store retains aggregate spend evidence after public content expires.
