// Run: node tools/test-walk.mjs (no packages needed).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const url = new URL('../pet-renderer.js', import.meta.url);
const source = (await readFile(url, 'utf8')).replaceAll('import.meta.url', JSON.stringify(url.href));
const {getWalkFootTarget: foot, getWalkSkinOffset: skin, getWalkStrideLength: stride} =
    await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const legs = [
    ['frontFar', 720, 0.77], ['hindFar', 710, 0.50],
    ['frontNear', 700, 0.27], ['hindNear', 710, 0],
];
const TAU = Math.PI * 2;
let checks = 0;
for (const [name, pivot, touchdown] of legs) {
    for (let i = 0; i < 1000; i++) {
        const phase = i / 1000 * TAU;
        const a = foot(phase, name);
        const root = skin(name, pivot, a);
        assert.ok(Math.hypot(root.x, root.y) < 1e-12);
        const b = foot(phase + 1e-6, name);
        if (!a.swinging && !b.swinging && b.cycle > a.cycle) {
            // Left-facing pet: page goes left, supporting paw goes right.
            const pageTravel = 150 * 1e-6 / TAU;
            assert.ok(Math.abs(b.x - a.x - pageTravel) < 1e-8);
            assert.equal(a.y, b.y);
        }
        // No texture strip may fold over or invert during lift/extension.
        let previousY = pivot;
        for (let y = pivot + 1; y <= pivot + 310; y++) {
            const nextY = y + skin(name, y, a).y;
            assert.ok(nextY > previousY);
            previousY = nextY;
        }
        checks++;
    }
    for (const boundary of [0, 0.72, 1]) {
        const p = (touchdown + boundary) * TAU;
        const eps = 1e-5;
        const a = foot(p - eps, name), b = foot(p, name), c = foot(p + eps, name);
        assert.ok(Math.hypot(c.x - a.x, c.y - a.y) < 0.002);
        assert.ok(Math.abs((c.x-b.x)/eps - (b.x-a.x)/eps) < 0.01);
        assert.ok(Math.abs((c.y-b.y)/eps - (b.y-a.y)/eps) < 0.01);
    }
    assert.deepEqual(foot(0, name, true), {...foot(0, name, true), lift: 0, offsetX: 0, swinging: false});
}
assert.ok(Math.abs(stride(303) / stride(101) - 3) < 1e-12);
assert.throws(() => foot(0, 'unknown'), RangeError);
console.log(`PASS: ${checks} poses; fixed roots, stance contact, world-space paw lock, continuous landings, non-folding skin, responsive stride.`);
