// 충돌은 전부 월드 좌표(m)의 2D xz 평면에서 처리. 물리엔진 금지. (SCHEMA.md)
import { CM, deg } from './units.js'

// 씬 JSON → 충돌 프리미티브. 벽=선분(문 구간 제외), 가구=회전 박스.
export function buildColliders(scene, catalog) {
  const segments = []
  for (const wall of scene.walls ?? []) {
    const ax = wall.from.x * CM, az = wall.from.z * CM
    const bx = wall.to.x * CM, bz = wall.to.z * CM
    const len = Math.hypot(bx - ax, bz - az)
    if (len === 0) continue
    const ux = (bx - ax) / len, uz = (bz - az) / len
    const pad = ((wall.thickness ?? 12) / 2) * CM

    // 문(door) 구간만 통과 가능 → 선분을 문 스팬 밖의 조각으로 쪼갠다
    const doors = (wall.openings ?? [])
      .filter(o => o.type === 'door')
      .map(o => [o.offset * CM, (o.offset + o.width) * CM])
      .sort((a, b) => a[0] - b[0])
    let cursor = 0
    const spans = []
    for (const [s, e] of doors) {
      if (s > cursor) spans.push([cursor, s])
      cursor = Math.max(cursor, e)
    }
    if (cursor < len) spans.push([cursor, len])

    for (const [s, e] of spans) {
      segments.push({
        ax: ax + ux * s, az: az + uz * s,
        bx: ax + ux * e, bz: az + uz * e,
        pad,
      })
    }
  }

  const boxes = []
  // 출입금지 구역 = 회전 없는 박스 콜라이더
  for (const zn of scene.zones ?? []) {
    boxes.push({
      cx: (zn.x + zn.w / 2) * CM,
      cz: (zn.z + zn.d / 2) * CM,
      hw: (zn.w / 2) * CM,
      hd: (zn.d / 2) * CM,
      rotY: 0,
    })
  }
  for (const item of scene.items ?? []) {
    const cat = catalog.items[item.catalogId]
    if (!cat) continue
    boxes.push({
      cx: item.position.x * CM,
      cz: item.position.z * CM,
      hw: (cat.size.w / 2) * CM,
      hd: (cat.size.d / 2) * CM,
      rotY: deg(item.rotationY ?? 0),
    })
  }

  return { segments, boxes }
}

// 원(플레이어)을 모든 콜라이더 밖으로 밀어낸다. 3회 반복으로 코너 안정화.
export function resolveCircle(pos, r, segments, boxes) {
  const p = { x: pos.x, z: pos.z }
  for (let i = 0; i < 3; i++) {
    for (const s of segments) pushOutSegment(p, r, s)
    for (const b of boxes) pushOutBox(p, r, b)
  }
  return p
}

function pushOutSegment(p, r, s) {
  const dx = s.bx - s.ax, dz = s.bz - s.az
  const len2 = dx * dx + dz * dz
  let t = len2 === 0 ? 0 : ((p.x - s.ax) * dx + (p.z - s.az) * dz) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = s.ax + t * dx, cz = s.az + t * dz
  const ex = p.x - cx, ez = p.z - cz
  const rr = r + s.pad
  const d2 = ex * ex + ez * ez
  if (d2 >= rr * rr) return
  if (d2 === 0) { p.x = cx + rr; return } // 정확히 선 위: 임의 방향으로 탈출
  const d = Math.sqrt(d2)
  p.x = cx + (ex / d) * rr
  p.z = cz + (ez / d) * rr
}

function pushOutBox(p, r, b) {
  // 월드→박스 로컬 (Ry(-rot)): lx = wx·cos − wz·sin, lz = wx·sin + wz·cos
  const cos = Math.cos(b.rotY), sin = Math.sin(b.rotY)
  const wx = p.x - b.cx, wz = p.z - b.cz
  const lx = wx * cos - wz * sin
  const lz = wx * sin + wz * cos

  const qx = Math.max(-b.hw, Math.min(b.hw, lx))
  const qz = Math.max(-b.hd, Math.min(b.hd, lz))
  let ex = lx - qx, ez = lz - qz
  const d2 = ex * ex + ez * ez

  if (d2 === 0) {
    // 중심이 박스 내부: 가장 얕은 면으로 밀어냄
    const px = b.hw - Math.abs(lx), pz = b.hd - Math.abs(lz)
    let ox = 0, oz = 0
    if (px < pz) ox = (lx >= 0 ? 1 : -1) * (px + r)
    else oz = (lz >= 0 ? 1 : -1) * (pz + r)
    applyLocalOffset(p, b, ox, oz)
    return
  }
  if (d2 >= r * r) return
  const d = Math.sqrt(d2)
  const push = r - d
  applyLocalOffset(p, b, (ex / d) * push, (ez / d) * push)
}

function applyLocalOffset(p, b, ox, oz) {
  // 로컬→월드 (Ry(+rot)): wx = lx·cos + lz·sin, wz = −lx·sin + lz·cos
  const cos = Math.cos(b.rotY), sin = Math.sin(b.rotY)
  p.x += ox * cos + oz * sin
  p.z += -ox * sin + oz * cos
}

// ---- 배치 유효성 판정용 기하 (전부 월드 m, xz 평면) ----

function axesOf(b) {
  // 로컬 x축=Ry(θ)·(1,0)=(cos,−sin), 로컬 z축=Ry(θ)·(0,1)=(sin,cos)
  const c = Math.cos(b.rotY), s = Math.sin(b.rotY)
  return [[c, -s], [s, c]]
}

function cornersOf(b) {
  const [ax, az] = axesOf(b)
  const out = []
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      out.push([
        b.cx + sx * b.hw * ax[0] + sz * b.hd * az[0],
        b.cz + sx * b.hw * ax[1] + sz * b.hd * az[1],
      ])
  return out
}

const TOUCH_EPS = 0.002 // 2mm — "딱 붙이기"는 겹침이 아니다

export function obbOverlapsObb(a, b) {
  const ca = cornersOf(a), cb = cornersOf(b)
  for (const [nx, nz] of [...axesOf(a), ...axesOf(b)]) {
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity
    for (const [x, z] of ca) { const d = x * nx + z * nz; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d) }
    for (const [x, z] of cb) { const d = x * nx + z * nz; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d) }
    if (aMax <= bMin + TOUCH_EPS || bMax <= aMin + TOUCH_EPS) return false
  }
  return true
}

// 벽 선분(두께 pad) vs 회전박스 — 박스 로컬로 옮겨 Liang-Barsky 클리핑
export function obbIntersectsSegment(b, ax, az, bx, bz, pad = 0) {
  const cos = Math.cos(b.rotY), sin = Math.sin(b.rotY)
  const toLocal = (wx, wz) => {
    const dx = wx - b.cx, dz = wz - b.cz
    return [dx * cos - dz * sin, dx * sin + dz * cos]
  }
  const [x0, z0] = toLocal(ax, az)
  const [x1, z1] = toLocal(bx, bz)
  const hx = b.hw + pad - 0.002, hz = b.hd + pad - 0.002 // 2mm 여유 — 벽에 딱 붙이기 허용
  let t0 = 0, t1 = 1
  const dx = x1 - x0, dz = z1 - z0
  const clip = (p, q) => {
    if (p === 0) return q >= 0
    const r = q / p
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r }
    else { if (r < t0) return false; if (r < t1) t1 = r }
    return true
  }
  return clip(-dx, x0 + hx) && clip(dx, hx - x0) && clip(-dz, z0 + hz) && clip(dz, hz - z0)
}

export function circleOverlapsObb(px, pz, r, b) {
  const cos = Math.cos(b.rotY), sin = Math.sin(b.rotY)
  const dx = px - b.cx, dz = pz - b.cz
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos
  const qx = Math.max(-b.hw, Math.min(b.hw, lx))
  const qz = Math.max(-b.hd, Math.min(b.hd, lz))
  const ex = lx - qx, ez = lz - qz
  return ex * ex + ez * ez < r * r
}
