import { setTimeout as delay } from "node:timers/promises";
import { SERVED_SESSION_POLL_MS } from "../../../catalog/pairing-wire.js";
import { scrubSecrets } from "../../../shared/telemetry/classes/logging/secret-scrub.js";

/** Owns the invitation before the ordinary Git session monitor takes over. */
export class ServedSession {
  constructor({ remoteClient, instanceId, host, log = console.log, pollMs = SERVED_SESSION_POLL_MS }) {
    this.remoteClient = remoteClient;
    this.instanceId = instanceId;
    this.host = host;
    this.log = log;
    this.pollMs = pollMs;
    this.abort = new AbortController();
    this.reservation = null;
    this.hostTask = null;
    this.activated = false;
  }

  async start() {
    this.reservation = await this.remoteClient.reserve(this.instanceId);
    this.log(`  Clone pairing code: ${this.reservation.code}`);
    this.log(`  Join from another computer: posse serve join ${this.reservation.code}`);
    this.log("  The shared Git session will be created when a clone joins.\n");
    // Keep the rejection observed even if shutdown arrives during startup.
    this.done = this.run();
    this.done.catch(() => {});
    return this.reservation;
  }

  async run() {
    const { signal } = this.abort;
    let failures = 0;
    let outcome = null;
    try {
      while (!signal.aborted) {
        if (outcome) {
          if (outcome.error) throw outcome.error;
          return outcome.result;
        }
        if (this.activated) return await this.hostTask;
        let status;
        try {
          status = await this.remoteClient.heartbeatReservation(this.reservation.host_token, { signal });
          failures = 0;
        } catch (error) {
          if (signal.aborted) break;
          failures += 1;
          if (error?.status === 401 || error?.status === 403 || failures >= 3) throw error;
          await delay(this.pollMs, undefined, { signal });
          continue;
        }
        if (status.repository_requested && !status.repository_error && !this.hostTask) {
          this.log("  A clone is joining; preparing the shared Git session...");
          const client = {
            ...this.remoteClient,
            reservation: this.reservation,
            activationAttempted: false,
            start: async (metadata) => {
              signal.throwIfAborted();
              client.activationAttempted = true;
              const result = await this.remoteClient.activateReservation(this.reservation, metadata);
              this.activated = true;
              return result;
            },
          };
          this.hostTask = Promise.resolve().then(() => this.host(client, signal));
          this.hostOutcome = this.hostTask.then(
            (result) => { outcome = { result }; },
            (error) => { outcome = { error }; },
          );
        }
        await Promise.race([
          delay(this.pollMs, undefined, { signal }),
          this.hostOutcome || new Promise(() => {}),
        ]);
      }
    } catch (error) {
      if (!signal.aborted) {
        if (!this.activated && this.hostTask) {
          const message = scrubSecrets(String(error?.message || error)).slice(0, 1000);
          await this.remoteClient.failReservation(this.reservation.host_token, message).catch(() => {});
        }
        throw error;
      }
    } finally {
      // Never leave a preparation mutating Git after its serving owner stops.
      this.abort.abort();
      if (this.hostTask) await this.hostTask.catch(() => {});
    }
  }

  async stop() {
    this.abort.abort();
    await this.done?.catch(() => {});
    if (this.reservation && !this.activated) {
      await this.remoteClient.cancelReservation(this.reservation.host_token);
    }
  }
}
