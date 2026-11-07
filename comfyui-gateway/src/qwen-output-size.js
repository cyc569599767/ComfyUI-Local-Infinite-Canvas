// Legacy Qwen 2.1 exports contain an unused EmptyImage -> VAEEncode canvas,
// while their sampler still consumes the encoder's square latent. Generic
// binding inference cannot see this branch. Infer it only when unambiguous;
// never replace a user's explicit size policy or write the source graph.
export function inferQwenOutputSize(workflow, entry = {}) {
  if (Object.prototype.hasOwnProperty.call(entry, "outputSize")) return undefined;
  if (Object.values(entry.bindings || {}).some((binding) => /^size\.(width|height)$/.test(binding?.from || ""))) return undefined;
  const nodes = Object.entries(workflow || {});
  const candidates = [];
  const linkIs = (value, id, slot) => Array.isArray(value) && String(value[0]) === id && value[1] === slot;
  const consumers = (id) => nodes.filter(([, node]) => Object.values(node.inputs || {}).some((value) => Array.isArray(value) && String(value[0]) === id));

  for (const [encoderId, encoder] of nodes) {
    if (encoder.class_type !== "TextEncodeQwenImage21") continue;
    // Image/edit workflows must keep their reference-derived latent geometry.
    if (Object.keys(encoder.inputs || {}).some((key) => /^images(?:\.|$)/.test(key))) continue;
    // Optional images can be absent from the export and added by bindings later.
    if (Object.values(entry.bindings || {}).some((binding) => String(binding?.node) === encoderId &&
      (binding.from === "image" || binding.imageIndex !== undefined || /^images(?:\.|$)/.test(binding.input || "")))) continue;
    if (!Array.isArray(encoder.inputs?.vae)) continue;
    const samplers = nodes.filter(([, node]) => node.class_type === "SamplerCustomAdvanced" && linkIs(node.inputs?.latent_image, encoderId, 2));
    if (samplers.length !== 1) continue;
    const [samplerId, sampler] = samplers[0];
    const guider = workflow[sampler.inputs.guider?.[0]];
    if (guider?.class_type !== "CFGGuider" || !linkIs(guider.inputs?.positive, encoderId, 0) || !linkIs(guider.inputs?.negative, encoderId, 1)) continue;

    for (const [latentId, latent] of nodes) {
      if (latent.class_type !== "VAEEncode" || !linkIs(latent.inputs?.vae, String(encoder.inputs.vae[0]), encoder.inputs.vae[1])) continue;
      const canvasId = String(latent.inputs?.pixels?.[0]);
      const canvas = workflow[canvasId];
      if (!linkIs(latent.inputs?.pixels, canvasId, 0) || canvas?.class_type !== "EmptyImage") continue;
      if (![canvas.inputs?.width, canvas.inputs?.height, canvas.inputs?.batch_size].every((value) => Number.isInteger(value) && value > 0)) continue;
      // Only the disconnected canvas branch is eligible. Shared/active branches
      // may have a different user-defined purpose; leave those untouched.
      if (consumers(latentId).length || consumers(canvasId).length !== 1) continue;
      const inputs = new Set([`${canvasId}.width`, `${canvasId}.height`, `${latentId}.pixels`, `${samplerId}.latent_image`]);
      if (Object.keys(entry.defaults || {}).some((key) => inputs.has(key))) continue;
      if (Object.values(entry.bindings || {}).some((binding) => inputs.has(`${binding?.node}.${binding?.input}`))) continue;
      candidates.push({ node: canvasId, latentNode: samplerId, latentInput: "latent_image", latentSource: latentId, fromSize: true, skipNativeSquare: true });
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}
