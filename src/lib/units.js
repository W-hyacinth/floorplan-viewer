// 2D 도면(cm, xz) ↔ 3D 월드(m, y-up) 변환은 이 파일에만 존재한다. (SCHEMA.md)
export const CM = 0.01

export function toWorld(x, z, y = 0) {
  return [x * CM, y * CM, z * CM]
}

export function toPlan(wx, wz) {
  return { x: wx / CM, z: wz / CM }
}

export function deg(d) {
  return (d * Math.PI) / 180
}
