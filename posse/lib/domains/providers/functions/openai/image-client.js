import { buildNativeImageClient } from "../shared/native-image.js";
export function buildImageClient() {
  return buildNativeImageClient("openai");
}
