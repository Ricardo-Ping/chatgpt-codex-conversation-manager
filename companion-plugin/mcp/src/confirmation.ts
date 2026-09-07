import { randomUUID } from "node:crypto";

export class ConfirmationStore<Action extends string> {
  readonly #entries = new Map<string, { action: Action; ids: string[]; fingerprint: string; expiresAt: number }>();
  readonly #now: () => number;

  constructor(now = Date.now) {
    this.#now = now;
  }

  issue(action: Action, ids: string[], fingerprint: string): string {
    const token = randomUUID();
    this.#entries.set(token, { action, ids: [...new Set(ids)].sort(), fingerprint, expiresAt: this.#now() + 120_000 });
    return token;
  }

  consume(token: string, action: Action, ids: string[]): { fingerprint: string } {
    const expected = this.#entries.get(token);
    this.#entries.delete(token);
    const normalized = [...new Set(ids)].sort();
    if (!expected || expected.expiresAt < this.#now() || expected.action !== action || JSON.stringify(expected.ids) !== JSON.stringify(normalized)) {
      throw new Error("Confirmation expired or does not match this action. Run preview_batch_action again.");
    }
    return { fingerprint: expected.fingerprint };
  }
}
