// 금지구역은 두 형태를 지원한다: 사각형 {x,z,w,d} (드래그 지정) / 다각형 {points:[{x,z},...]} (영역 감지·수정)
// 소비자(3D·미니맵·충돌·에디터)는 전부 zonePoints()로 통일해 다각형으로만 다룬다.

export function zonePoints(zn) {
  if (zn.points?.length >= 3) return zn.points
  return [
    { x: zn.x, z: zn.z },
    { x: zn.x + zn.w, z: zn.z },
    { x: zn.x + zn.w, z: zn.z + zn.d },
    { x: zn.x, z: zn.z + zn.d },
  ]
}

// ray casting 점-다각형 판정
export function pointInZone(px, pz, zn) {
  const pts = zonePoints(zn)
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j]
    if ((a.z > pz) !== (b.z > pz) && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside
    }
  }
  return inside
}

export function zoneCentroid(zn) {
  const pts = zonePoints(zn)
  let x = 0, z = 0
  for (const p of pts) { x += p.x; z += p.z }
  return { x: x / pts.length, z: z / pts.length }
}
