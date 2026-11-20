import { randomUUID } from "node:crypto";

/** File stem only: no paths, ComfyUI substitutions, device names or control chars. */
export function safeCreationAssetName(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let name = Array.from(value.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*%]/g, "_").replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "")).slice(0, 80).join("").replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
export function creationOutputParams(entry, params) {
  if (entry?.source?.kind !== "creation-reference") return { params, assetName: "" };
  const assetName = safeCreationAssetName(params?.assetName);
  if (!assetName) return { params, assetName: "" };
  return { params: { ...params, assetName, filenamePrefix: `creation/${assetName}_${randomUUID().slice(0, 12)}` }, assetName };
}
