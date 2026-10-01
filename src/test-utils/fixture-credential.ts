import { randomUUID } from "node:crypto";

const credentials = new Map<string, string>();

/** Generated, stable-within-test credentials; labels are public fixture names. */
export function fixtureCredential(label: string): string {
  let value = credentials.get(label);
  if (!value) {
    value = randomUUID();
    credentials.set(label, value);
  }
  return value;
}
