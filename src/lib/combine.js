// 벽 자동 인식 combiner — v1(잉크 띠 기반, trace.js)과 v2(공간 워터셰드, trace2.js)를
// 모두 실행하고 상호 지지도로 결과를 고른다.
//
// 신호: v2 벽 표본점이 v1 검출로 지지되는 비율(support).
// 두 엔진은 실패 모드가 다르다 — v1은 저대비·노이즈 시트에서 붕괴(벽 소실 또는 junk 폭주),
// v2는 방 구조가 서는 도면에서만 벽을 낸다. 정상 도면에서는 서로의 벽을 재발견하므로
// support가 높고(픽스처 12종 실측 0.80~1.00), v1이 붕괴한 시트에서는 v2가 찾은 벽을
// v1이 뒷받침하지 못해 support가 떨어진다. junk 폭주는 아무 데나 벽이 있어 support가
// 오히려 높은데, 그 경우 v1 junk가 GT를 넓게 덮어 F1도 v1이 낫다(CubiCasa 실측) —
// 신호 방향이 일치해서 별도 junk 가드가 필요 없다.
//
// 문턱 0.5는 CubiCasa5K 60장 검증값: 정답률 54/60, 평균 F1 0.704(오라클 0.709,
// always-v1 0.679). 0.3~0.55 구간이 평평해 과적합 아님. 상세=test/README.md.
import { detectWalls } from './trace.js'
import { detectWalls2 } from './trace2.js'

const SUPPORT_MIN = 0.5
const SAMPLE_STEP_CM = 30
const SUPPORT_TOL_CM = 12

function segPoints(w, step = SAMPLE_STEP_CM) {
  const { x: x0, z: z0 } = w.from
  const { x: x1, z: z1 } = w.to
  const len = Math.max(Math.hypot(x1 - x0, z1 - z0), 1)
  const k = Math.max(Math.round(len / step), 1)
  const pts = []
  for (let i = 0; i <= k; i++) pts.push([x0 + (x1 - x0) * i / k, z0 + (z1 - z0) * i / k])
  return pts
}

function nearAny(x, z, walls, tol) {
  for (const w of walls) {
    const { x: x0, z: z0 } = w.from
    const { x: x1, z: z1 } = w.to
    const dx = x1 - x0
    const dz = z1 - z0
    const L2 = dx * dx + dz * dz
    if (!L2) continue
    let t = ((x - x0) * dx + (z - z0) * dz) / L2
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const px = x0 + t * dx
    const pz = z0 + t * dz
    if (Math.hypot(x - px, z - pz) <= tol + (w.thickness ?? 10) / 2) return true
  }
  return false
}

// sample 벽들의 표본점 중 reference 벽 근방(tol+두께/2)에 있는 비율.
export function supportFraction(sample, reference, tol = SUPPORT_TOL_CM) {
  if (!sample.length || !reference.length) return 0
  let hit = 0
  let total = 0
  for (const w of sample) {
    for (const [x, z] of segPoints(w)) {
      total++
      if (nearAny(x, z, reference, tol)) hit++
    }
  }
  return hit / total
}

// 두 엔진을 실행하고 결과를 고른다. 반환: { walls, engine, support }
export async function detectWallsAuto(src, underlay) {
  const [w1, w2] = await Promise.all([
    detectWalls(src, underlay),
    detectWalls2(src, underlay),
  ])
  if (!w2.length) return { walls: w1, engine: 'v1', support: 1 }
  if (!w1.length) return { walls: w2, engine: 'v2', support: 0 }
  const support = supportFraction(w2, w1)
  return support < SUPPORT_MIN
    ? { walls: w2, engine: 'v2', support }
    : { walls: w1, engine: 'v1', support }
}
