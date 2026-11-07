import assert from 'node:assert/strict';
import test from 'node:test';
import { selectKvmemVision } from '../src/kvmem-vision.js';
const GiB = 1024 ** 3;
const hardware = { modelBytes: 12 * GiB, availableVramBytes: 15 * GiB };

test('CPU remains default and is not a claim of CPU text-model inference', () => {
  const choice = selectKvmemVision(undefined, hardware);
  assert.equal(choice.mode, 'cpu'); assert.equal(choice.admitted, true);
  assert.equal(choice.requiredBytes, 13 * GiB); assert.equal(choice.estimateOnly, true);
});
test('auto selects resident GPU vision only with the extra conservative headroom', () => {
  assert.equal(selectKvmemVision('auto', hardware).mode, 'gpu');
  const low = selectKvmemVision('auto', { ...hardware, availableVramBytes: 14 * GiB });
  assert.equal(low.mode, 'cpu'); assert.equal(low.admitted, true);
  assert.equal(low.reason, 'cpu-preserve-vram');
  assert.equal(selectKvmemVision('auto', { ...hardware, availableVramBytes: 12 * GiB }).admitted, false);
});
test('explicit GPU never silently downgrades and unknown memory never admits a launch', () => {
  const low = selectKvmemVision('gpu', { ...hardware, availableVramBytes: 14 * GiB });
  assert.equal(low.mode, 'gpu'); assert.equal(low.admitted, false);
  for (const value of [{}, { modelBytes: NaN, availableVramBytes: 32 * GiB }, { ...hardware, availableVramBytes: NaN }]) {
    assert.equal(selectKvmemVision('gpu', value).admitted, false);
    assert.equal(selectKvmemVision('auto', value).admitted, false);
  }
});
test('only supported exact modes are accepted', () => {
  for (const value of ['resident', 'overlay', '', 'GPU', ' cpu', null, {}, false]) {
    assert.throws(() => selectKvmemVision(value, hardware), { code: 'kvmem_invalid_vision_mode' });
  }
});
