import { deepFreeze } from "./deep-freeze.js";
// @ts-check



export function deepFreezeJson(value) {
  const clone = JSON.parse(JSON.stringify(value));
  return deepFreeze(clone);
}
