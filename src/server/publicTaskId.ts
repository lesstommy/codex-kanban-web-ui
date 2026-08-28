import { randomBytes } from "node:crypto";

export function generatePublicTaskId(now = new Date()): string {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const randomPart = randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(7, "0").slice(0, 7);
  return `HT-${datePart}-${randomPart}`;
}

export function normalizePublicTaskId(value: string): string {
  return value.trim().toUpperCase();
}
