import { expect, test } from 'bun:test';

import { planAudioCloneReference } from '../src/lib/canvas/audio-clone-reference';
import type { ReferenceAudio } from '../src/types/media';

const upstream: ReferenceAudio = { id: 'upstream', name: 'upstream.mp3', type: 'audio/mpeg', url: 'audio:upstream' };
const self: ReferenceAudio = { id: 'self', name: 'self.mp3', type: 'audio/mpeg', url: 'audio:self', storageKey: 'audio:self' };

test('音色克隆优先用连入的参考音频，不另开节点', () => {
    const plan = planAudioCloneReference('voice-clone', upstream, self);
    expect(plan.reference).toBe(upstream);
    expect(plan.usesSelfReference).toBe(false);
});

test('没连参考音频时把本节点音频当参考，并要求另开节点', () => {
    const plan = planAudioCloneReference('voice-clone', undefined, self);
    expect(plan.reference).toBe(self);
    expect(plan.usesSelfReference).toBe(true);
});

test('既没连也没有自身音频时不产生参考', () => {
    const plan = planAudioCloneReference('voice-clone', undefined, null);
    expect(plan.reference).toBeUndefined();
    expect(plan.usesSelfReference).toBe(false);
});

test('非克隆模式不参与参考音色决策', () => {
    for (const mode of ['voice-design', 'music', '']) {
        const plan = planAudioCloneReference(mode, upstream, self);
        expect(plan.reference).toBeUndefined();
        expect(plan.usesSelfReference).toBe(false);
    }
});
