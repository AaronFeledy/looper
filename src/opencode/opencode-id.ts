import { randomBytes } from "node:crypto";

const ID_BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdTimestamp = 0;
let idCounter = 0;

export function createOpencodeID(prefix: string): string {
  const currentTimestamp = Date.now();
  if (currentTimestamp !== lastIdTimestamp) {
    lastIdTimestamp = currentTimestamp;
    idCounter = 0;
  }
  idCounter += 1;
  const value = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(idCounter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) {
    timeBytes[i] = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  const random = randomBytes(14);
  let suffix = "";
  for (let i = 0; i < 14; i += 1) suffix += ID_BASE62[random[i]! % 62];
  return `${prefix}_${timeBytes.toString("hex")}${suffix}`;
}
