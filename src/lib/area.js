// 클릭 지점을 둘러싼 "벽으로 닫힌 영역"을 감지해 다각형(cm)으로 돌려준다.
// 방식: 도면을 셀 격자로 래스터화(벽=차단, 문·창 개구부도 감지 목적상 차단으로 취급)
//       → 클릭 셀에서 플러드필 → 격자 밖으로 새면 "열린 영역"이라 실패
//       → 채운 영역의 경계 간선을 체인으로 이어 루프를 만들고 단순화한다.

const STEP = 5          // cm — 격자 해상도 (SNAP과 동일)
const MAX_CELLS = 4e6   // 폭주 방지 (100m×100m @5cm)

export function detectEnclosedArea(scene, px, pz, step = STEP) {
  const walls = scene.walls ?? []
  if (!walls.length) return null

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const w of walls) {
    for (const p of [w.from, w.to]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
    }
  }
  minX -= step; minZ -= step; maxX += step; maxZ += step
  const cols = Math.max(1, Math.ceil((maxX - minX) / step))
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / step))
  if (cols * rows > MAX_CELLS) return null

  // 1) 벽 래스터화 — 개구부 무시(문이 있어도 방 단위로 닫힌 것으로 본다)
  const blocked = new Uint8Array(cols * rows)
  for (const w of walls) {
    const ax = w.from.x, az = w.from.z, bx = w.to.x, bz = w.to.z
    const len2 = (bx - ax) ** 2 + (bz - az) ** 2
    if (len2 === 0) continue
    const reach = (w.thickness ?? 12) / 2 + step * 0.51
    const cx0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - minX) / step))
    const cx1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + reach - minX) / step))
    const cy0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - minZ) / step))
    const cy1 = Math.min(rows - 1, Math.ceil((Math.max(az, bz) + reach - minZ) / step))
    for (let cy = cy0; cy <= cy1; cy++) {
      const pzc = minZ + (cy + 0.5) * step
      for (let cx = cx0; cx <= cx1; cx++) {
        const pxc = minX + (cx + 0.5) * step
        let t = ((pxc - ax) * (bx - ax) + (pzc - az) * (bz - az)) / len2
        t = Math.max(0, Math.min(1, t))
        const dx = pxc - (ax + t * (bx - ax)), dz = pzc - (az + t * (bz - az))
        if (dx * dx + dz * dz <= reach * reach) blocked[cy * cols + cx] = 1
      }
    }
  }

  // 2) 플러드필
  const scx = Math.floor((px - minX) / step), scy = Math.floor((pz - minZ) / step)
  if (scx < 0 || scx >= cols || scy < 0 || scy >= rows) return null
  const start = scy * cols + scx
  if (blocked[start]) return null
  const filled = new Uint8Array(cols * rows)
  const stack = [start]
  filled[start] = 1
  while (stack.length) {
    const i = stack.pop()
    const cx = i % cols, cy = (i / cols) | 0
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return null // 격자 밖으로 샘 = 열린 영역
      const ni = ny * cols + nx
      if (!filled[ni] && !blocked[ni]) { filled[ni] = 1; stack.push(ni) }
    }
  }

  // 3) 경계 간선 수집 — 채운 셀 기준, 채움이 진행방향 오른쪽에 오도록 방향 부여
  const isF = (cx, cy) => cx >= 0 && cx < cols && cy >= 0 && cy < rows && filled[cy * cols + cx] === 1
  const edges = new Map() // "x,y"(시작 코너) → [끝 코너 [x,y], ...]
  const addEdge = (x0, y0, x1, y1) => {
    const k = `${x0},${y0}`
    if (!edges.has(k)) edges.set(k, [])
    edges.get(k).push([x1, y1])
  }
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!filled[cy * cols + cx]) continue
      if (!isF(cx, cy - 1)) addEdge(cx, cy, cx + 1, cy)         // 북쪽 경계 → 동진
      if (!isF(cx + 1, cy)) addEdge(cx + 1, cy, cx + 1, cy + 1) // 동쪽 경계 → 남진
      if (!isF(cx, cy + 1)) addEdge(cx + 1, cy + 1, cx, cy + 1) // 남쪽 경계 → 서진
      if (!isF(cx - 1, cy)) addEdge(cx, cy + 1, cx, cy)         // 서쪽 경계 → 북진
    }
  }

  // 4) 간선 체인 → 루프들. 바깥 루프(면적 최대)만 취한다 (내부 기둥 구멍은 구역에 포함)
  const loops = []
  for (const [k] of edges) {
    if (!edges.get(k)?.length) continue
    const loop = []
    let [cx, cy] = k.split(',').map(Number)
    let prevDir = null
    for (;;) {
      const outs = edges.get(`${cx},${cy}`)
      if (!outs?.length) break
      // 코너에 나가는 간선이 2개면(대각 접촉) 직전 방향에서 우회전 쪽을 우선
      let pick = 0
      if (outs.length > 1 && prevDir) {
        pick = outs.findIndex(([nx, ny]) => (nx - cx) * prevDir[1] - (ny - cy) * prevDir[0] < 0)
        if (pick < 0) pick = 0
      }
      const [nx, ny] = outs.splice(pick, 1)[0]
      loop.push([cx, cy])
      prevDir = [nx - cx, ny - cy]
      cx = nx; cy = ny
      if (`${cx},${cy}` === k) break
    }
    if (loop.length >= 4) loops.push(loop)
  }
  if (!loops.length) return null
  const areaOf = loop => {
    let a = 0
    for (let i = 0; i < loop.length; i++) {
      const [x0, y0] = loop[i], [x1, y1] = loop[(i + 1) % loop.length]
      a += x0 * y1 - x1 * y0
    }
    return Math.abs(a) / 2
  }
  const outer = loops.reduce((best, l) => (areaOf(l) > areaOf(best) ? l : best))

  // 5) cm 변환 + 단순화 (일직선 제거 → 근접 꼭짓점 병합)
  let pts = outer.map(([gx, gy]) => ({
    x: Math.round(minX + gx * step),
    z: Math.round(minZ + gy * step),
  }))
  pts = simplify(pts, step * 1.5)
  return pts.length >= 3 ? pts : null
}

// 닫힌 다각형 단순화.
// 1단계: 양옆 원본 이웃 기준 "완전 일직선" 점만 제거 (코너는 절대 안 먹음)
// 2단계: 대각벽 계단무늬용 RDP — 서로 가장 먼 두 꼭짓점에서 루프를 갈라 각각 돌린다
function simplify(pts, eps) {
  const corners = pts.filter((b, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length]
    const c = pts[(i + 1) % pts.length]
    return (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x) !== 0
  })
  if (corners.length <= 4) return corners
  let ai = 0, bi = 0, best = -1
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const d = (corners[i].x - corners[j].x) ** 2 + (corners[i].z - corners[j].z) ** 2
      if (d > best) { best = d; ai = i; bi = j }
    }
  }
  const half1 = corners.slice(ai, bi + 1)
  const half2 = [...corners.slice(bi), ...corners.slice(0, ai + 1)]
  return [...rdp(half1, eps).slice(0, -1), ...rdp(half2, eps).slice(0, -1)]
}

// Douglas-Peucker (열린 폴리라인)
function rdp(pts, eps) {
  if (pts.length <= 2) return pts
  let maxD = -1, idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1])
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]]
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)]
}

function perpDist(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z
  const len = Math.hypot(dx, dz)
  if (len === 0) return Math.hypot(p.x - a.x, p.z - a.z)
  return Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / len
}
