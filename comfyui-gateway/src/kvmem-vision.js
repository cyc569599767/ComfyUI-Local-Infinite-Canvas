const GiB = 1024 ** 3;

// Admission estimates only; artifact bytes are not exact GPU allocation. Keep
// the existing CPU-vision floor and an extra 2 GiB for resident vision/workspace.
// Never claim these estimates prove fit or retry a failed GPU run on CPU silently.
export function selectKvmemVision(requested = 'cpu', hardware = {}) {
  if (!['cpu', 'gpu', 'auto'].includes(requested)) {
    throw Object.assign(new Error('KVMem 视觉模式必须是 cpu、gpu 或 auto'), { code: 'kvmem_invalid_vision_mode', status: 400 });
  }
  const { modelBytes, availableVramBytes } = hardware;
  const known = Number.isFinite(modelBytes) && modelBytes > 0 && Number.isFinite(availableVramBytes) && availableVramBytes >= 0;
  const cpuRequiredBytes = known ? modelBytes + GiB : null;
  const gpuRequiredBytes = known ? modelBytes + 3 * GiB : null;
  const mode = requested === 'auto' ? (known && availableVramBytes >= gpuRequiredBytes ? 'gpu' : 'cpu') : requested;
  const requiredBytes = mode === 'gpu' ? gpuRequiredBytes : cpuRequiredBytes;
  return {
    requested, mode, requiredBytes,
    admitted: known && availableVramBytes >= requiredBytes,
    reason: requested === 'auto' ? (mode === 'gpu' ? 'gpu-headroom-available' : 'cpu-preserve-vram') : 'explicit-selection',
    estimateOnly: true,
  };
}
