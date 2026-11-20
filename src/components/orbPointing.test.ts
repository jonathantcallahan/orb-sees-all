import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { pointNearestTip } from "./orbPointing";

const TIPS = [1, -1].flatMap((s) => [new THREE.Vector3(s, 0, 0), new THREE.Vector3(0, s, 0), new THREE.Vector3(0, 0, s)]);
const euler = (x: number, y: number, z = 0, order: THREE.EulerOrder = "XYZ") => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, order));
/** The cursor's direction from the orb's center, as PressureBlob aims at it (orb-box units, y down). */
const aimAt = (dx: number, dy: number) => new THREE.Vector3(dx, -dy, 0.6).normalize();
/** How far, in degrees, the cross's point nearest `aim` is from it, with the orb turned by `facing` then `blob`. */
const offBy = (facing: THREE.Quaternion, blob: THREE.Quaternion, aim: THREE.Vector3) => {
  const world = facing.clone().multiply(blob);
  return THREE.MathUtils.radToDeg(Math.min(...TIPS.map((t) => t.clone().applyQuaternion(world).angleTo(aim))));
};

const cursors: [number, number][] = [[1.1, 0], [0.8, -0.8], [0, -1.2], [-0.9, 0.6], [0, 0], [-1.7, -0.4]];
const orbs = [euler(0, 0.3, 0, "YXZ"), euler(0, 2.4, 0, "YXZ"), euler(0.5, -1.1, 0.4, "YXZ")];

describe("Kitten pointing a point of its cross at the cursor", () => {
  it("turns the nearest point onto the cursor, whatever its spin and lean", () => {
    for (const blob of orbs)
      for (const [dx, dy] of cursors) {
        const facing = euler(dy * 0.6, dx * 0.6);
        const aim = aimAt(dx, dy);
        const pointed = pointNearestTip(facing, blob, aim, new THREE.Quaternion());
        expect(offBy(facing, pointed, aim)).toBeLessThan(0.01);
      }
  });

  it("takes the shortest turn, never more than the farthest a point can be (about 55 degrees)", () => {
    const most = THREE.MathUtils.radToDeg(Math.acos(1 / Math.sqrt(3)));
    for (const blob of orbs)
      for (const [dx, dy] of cursors) {
        const facing = euler(dy * 0.6, dx * 0.6);
        const aim = aimAt(dx, dy);
        const before = offBy(facing, blob, aim);
        const pointed = pointNearestTip(facing, blob, aim, new THREE.Quaternion());
        const turned = THREE.MathUtils.radToDeg(blob.angleTo(pointed));
        expect(turned).toBeCloseTo(before, 3);
        expect(turned).toBeLessThanOrEqual(most + 0.01);
      }
  });

  it("leaves a point already on the cursor where it is", () => {
    const blob = euler(0, 0, 0, "YXZ");
    const pointed = pointNearestTip(new THREE.Quaternion(), blob, new THREE.Vector3(0, 0, 1), new THREE.Quaternion());
    expect(blob.angleTo(pointed)).toBeLessThan(1e-6);
  });

  it("settles on the cursor frame by frame as the lean eases in, as PressureBlob steps it", () => {
    const blob = euler(0, 0.9, 0, "YXZ");
    const facing = new THREE.Quaternion();
    const aim = aimAt(0.8, -0.8);
    const pointed = new THREE.Quaternion();
    for (let frame = 0; frame < 120; frame++) {
      // The lean eases toward the cursor at the same pace (1/15 of the way each frame at 60 fps).
      facing.slerp(euler(-0.8 * 0.6, 0.8 * 0.6), 4 / 60);
      blob.slerp(pointNearestTip(facing, blob, aim, pointed), 4 / 60);
    }
    expect(offBy(facing, blob, aim)).toBeLessThan(0.5);
  });
});
