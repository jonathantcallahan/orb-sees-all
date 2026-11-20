import * as THREE from "three";

/** The six points of a cross with a point along each way of its three axes (Kitten's), in its own space. */
const TIPS = [1, -1].flatMap((s) => [new THREE.Vector3(s, 0, 0), new THREE.Vector3(0, s, 0), new THREE.Vector3(0, 0, s)]);
const world = new THREE.Quaternion();
const tip = new THREE.Vector3();
const nearest = new THREE.Vector3();
const turn = new THREE.Quaternion();

/**
 * How to turn the orb (`blob`, its turn inside the facing group, which is turned by `facing`) so
 * the point of its cross nearest `aim` (a unit direction in the scene) lies along it: the shortest
 * such turn, at most about 55 degrees, since some point is always that close. Written into `out`.
 */
export function pointNearestTip(facing: THREE.Quaternion, blob: THREE.Quaternion, aim: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  world.multiplyQuaternions(facing, blob);
  let best = -2;
  for (const t of TIPS) {
    tip.copy(t).applyQuaternion(world);
    const d = tip.dot(aim);
    if (d > best) {
      best = d;
      nearest.copy(tip);
    }
  }
  // Made in the scene, then taken into the facing group.
  turn.setFromUnitVectors(nearest, aim);
  return out.copy(facing).invert().multiply(turn).multiply(world);
}
