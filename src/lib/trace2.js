// v2 공간 우선(room-first) 벽 인식 엔진 — 실험판. v1(trace.js)과 병행 평가용.
//
// 가설(LH 226장 전수조사로 검증, 정면 반례 0):
//   벽 = '어두운 띠'가 아니라 '공간(방)들 사이의 경계'다.
//   방 = 벽보다 밝은 균질 폐영역. 문 = 두 방을 잇는 좁은 개구부(경계인데 벽 픽셀이 없음).
//   글자·가구·치수선은 방 내부/외부에 있으므로 경계가 아니다 — 판정 게이트가 필요 없다.
//
// 파이프라인:
//   이진화(벽 마스크) → 문 봉인 팽창으로 방 씨앗 분리 → 다중소스 BFS로 방 라벨 확장
//   → 벽 픽셀 소유권 부여 → 라벨쌍 경계 리지 추출(벽 리지=벽 / 바닥 리지=문)
//   → 최대 방 군집 선택(배너·카탈로그 시트 대응) → 리지를 축정렬 세그먼트로 피팅
//   → 두께는 리지 주변 벽 마스크 실측 → v1과 동일한 스키마로 출력.
//
// cm 문턱이 거의 없어(봉인 반경 45cm, 최소 방 1.5㎡) 보정 오차에 구조적으로 강건하다.

const MAX_SIDE = 1200
const MAX_CHROMA = 60
const DOOR_SEAL_CM = 45      // 이 반경 팽창으로 ≤90cm 개구부가 봉인돼 방이 분리된다
const MIN_ROOM_M2 = 1.5      // 방 최소 면적
const MIN_WALL_LEN_CM = 40
const MIN_T_CM = 6
const MAX_T_CM = 60

export async function detectWalls2(src, underlay) {
  const img = await loadImage(src)
  const crop = findContentBox(img)
  const scale = MAX_SIDE / Math.max(crop.w, crop.h)
  const w = Math.max(1, Math.round(crop.w * scale))
  const h = Math.max(1, Math.round(crop.h * scale))
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const fullCmPerPx = underlay.widthCm / img.naturalWidth
  const cmPerPx = (crop.w * fullCmPerPx) / w
  const offX = underlay.x + crop.x * fullCmPerPx
  const offZ = underlay.z + crop.y * fullCmPerPx

  // ── 1) 벽 마스크 (v1 검증 로직: 5/95 분위 중간 문턱 + 극성 + 채도) ──
  const N = w * h
  const lum = new Float32Array(N)
  for (let i = 0; i < N; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]
  const sorted = Float32Array.from(lum).sort()
  const lo = sorted[Math.floor(N * 0.05)]
  const hi = sorted[Math.floor(N * 0.95)]
  if (hi - lo < 30) return []
  const thr = (lo + hi) / 2
  let dark = 0
  for (let i = 0; i < N; i++) if (lum[i] < thr) dark++
  const darkIsWall = dark <= N / 2
  const wall = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if ((lum[i] < thr) !== darkIsWall) continue
    const c = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) - Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])
    if (c <= MAX_CHROMA) wall[i] = 1
  }

  // ── 2) 문 봉인 팽창 → 방 씨앗 ──
  const sealR = Math.max(2, Math.round(DOOR_SEAL_CM / cmPerPx))
  const sealed = dilate(wall, w, h, sealR)
  // 씨앗 라벨링: sealed=0 픽셀의 연결성분. 라벨 1=외부(테두리 접촉 성분 전부), 2..=방
  const label = new Int32Array(N) // 0=미배정
  const minRoomPx = Math.max(30, Math.round(MIN_ROOM_M2 * 1e4 / (cmPerPx * cmPerPx)))
  let nextLabel = 2
  const stack = []
  const compPx = new Map() // label → px count
  for (let s = 0; s < N; s++) {
    if (sealed[s] || label[s]) continue
    // BFS로 성분 수집
    const px = []
    let touchesBorder = false
    stack.length = 0
    stack.push(s)
    label[s] = -1
    while (stack.length) {
      const i = stack.pop()
      px.push(i)
      const x = i % w, y = (i / w) | 0
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true
      if (x > 0 && !sealed[i - 1] && !label[i - 1]) { label[i - 1] = -1; stack.push(i - 1) }
      if (x < w - 1 && !sealed[i + 1] && !label[i + 1]) { label[i + 1] = -1; stack.push(i + 1) }
      if (y > 0 && !sealed[i - w] && !label[i - w]) { label[i - w] = -1; stack.push(i - w) }
      if (y < h - 1 && !sealed[i + w] && !label[i + w]) { label[i + w] = -1; stack.push(i + w) }
    }
    let lb
    if (touchesBorder) lb = 1
    else if (px.length >= minRoomPx) lb = nextLabel++
    else lb = 0 // 자잘한 조각은 씨앗 아님(확장 단계에서 이웃에 흡수)
    for (const i of px) label[i] = lb
    if (lb >= 1) compPx.set(lb, (compPx.get(lb) || 0) + px.length)
  }

  // ── 3) 라벨 확장: 비벽 픽셀 전체로 (기하 BFS — 방 모양 복원) ──
  bfsExpand(label, wall, w, h, false)
  // ── 4) 벽 픽셀 소유권: 벽 마스크 안으로도 확장 ──
  bfsExpand(label, wall, w, h, true)

  // ── 5) 라벨쌍 경계 리지 ──
  // wallRidge: 서로 다른 라벨의 벽 픽셀이 만나는 자리(=벽), pairKey → 픽셀들
  const ridge = new Map()
  const addR = (k, i) => { let a = ridge.get(k); if (!a) { a = []; ridge.set(k, a) } a.push(i) }
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x
      const a = label[i]
      for (const j of [i + 1, i + w]) {
        const b = label[j]
        if (a === b || a < 1 || b < 1) continue
        if (!wall[i] && !wall[j]) continue // 둘 다 바닥 = 문/개구부 경계 → 벽 아님
        addR(a < b ? a * 100000 + b : b * 100000 + a, i)
      }
    }
  }

  // ── 6) 최대 방 군집 선택 (배너·카탈로그 시트: 본 도면만) ──
  // 방 인접 그래프(리지 공유 = 인접, 외부(1) 제외) → 총면적 최대 군집
  const adj = new Map()
  for (const k of ridge.keys()) {
    const a = Math.floor(k / 100000), b = k % 100000
    if (a === 1 || b === 1) continue
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a).add(b)
    adj.get(b).add(a)
  }
  const roomLabels = [...compPx.keys()].filter(l => l >= 2)
  const seen = new Set()
  let bestCluster = null
  for (const r0 of roomLabels) {
    if (seen.has(r0)) continue
    const cl = new Set([r0])
    const q = [r0]
    seen.add(r0)
    while (q.length) {
      const r2 = q.pop()
      for (const nb of (adj.get(r2) || [])) {
        if (!cl.has(nb)) { cl.add(nb); q.push(nb); seen.add(nb) }
      }
    }
    const area = [...cl].reduce((s2, l) => s2 + (compPx.get(l) || 0), 0)
    if (!bestCluster || area > bestCluster.area) bestCluster = { set: cl, area }
  }
  if (!bestCluster) return []
  const keep = bestCluster.set

  // ── 7) 리지 → 축정렬 벽 세그먼트 ──
  const walls = []
  for (const [k, pxs] of ridge) {
    const a = Math.floor(k / 100000), b = k % 100000
    const aIn = keep.has(a), bIn = keep.has(b)
    if (!(aIn || bIn)) continue
    if ((a === 1 || b === 1) && !(aIn || bIn)) continue
    // 픽셀들을 마스크로 → 밴드 추출(가로/세로)
    const segs = fitSegments(pxs, w, h)
    for (const s of segs) {
      const lenCm = s.len * cmPerPx
      if (lenCm < MIN_WALL_LEN_CM) continue
      // 두께: 세그먼트 중점들에서 수직 방향 벽 마스크 폭 실측(중앙값)
      const tCm = measureThickness(wall, w, h, s) * cmPerPx
      const t = Math.round(Math.min(MAX_T_CM, Math.max(MIN_T_CM, tCm)))
      const c = (s.c + 0.5) * cmPerPx
      const p1 = s.a * cmPerPx
      const p2 = (s.b + 1) * cmPerPx
      walls.push(s.vertical
        ? { from: { x: r2i(offX + c), z: r2i(offZ + p1) }, to: { x: r2i(offX + c), z: r2i(offZ + p2) }, thickness: t }
        : { from: { x: r2i(offX + p1), z: r2i(offZ + c) }, to: { x: r2i(offX + p2), z: r2i(offZ + c) }, thickness: t })
    }
  }
  return mergeSegs(walls)
}

const r2i = v => Math.round(v)

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error('이미지를 읽을 수 없어요'))
    img.src = src
  })
}

// v1과 동일한 내용 크롭(여백 과다 시트 대응)
function findContentBox(img) {
  const P = 240
  const s = P / Math.max(img.naturalWidth, img.naturalHeight)
  const pw = Math.max(1, Math.round(img.naturalWidth * s))
  const ph = Math.max(1, Math.round(img.naturalHeight * s))
  const cv = document.createElement('canvas')
  cv.width = pw
  cv.height = ph
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, pw, ph)
  const d = ctx.getImageData(0, 0, pw, ph).data
  const lum = i => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
  const border = []
  for (let x = 0; x < pw; x++) border.push(lum(x), lum((ph - 1) * pw + x))
  for (let y = 0; y < ph; y++) border.push(lum(y * pw), lum(y * pw + pw - 1))
  border.sort((q, r3) => q - r3)
  const bg = border[Math.floor(border.length / 2)]
  let x1 = pw, y1 = ph, x2 = -1, y2 = -1
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    if (Math.abs(lum(y * pw + x) - bg) > 28) {
      if (x < x1) x1 = x
      if (x > x2) x2 = x
      if (y < y1) y1 = y
      if (y > y2) y2 = y
    }
  }
  if (x2 < 0 || (x2 - x1) < pw * 0.2 || (y2 - y1) < ph * 0.2) return { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }
  const areaFrac = ((x2 - x1 + 1) * (y2 - y1 + 1)) / (pw * ph)
  if (areaFrac >= 0.55) return { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }
  const fx = v => Math.round(v / s)
  const padX = Math.round((x2 - x1) * 0.02) + 1
  const padY = Math.round((y2 - y1) * 0.02) + 1
  return {
    x: Math.max(0, fx(x1 - padX)),
    y: Math.max(0, fx(y1 - padY)),
    w: Math.min(img.naturalWidth, fx(x2 + padX)) - Math.max(0, fx(x1 - padX)),
    h: Math.min(img.naturalHeight, fx(y2 + padY)) - Math.max(0, fx(y1 - padY)),
  }
}

// 체비쇼프(사각) 팽창 — 두 번의 1D 슬라이딩 최대로 O(N)
function dilate(mask, w, h, r) {
  const tmp = new Uint8Array(mask.length)
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let cnt = 0
    for (let x = -r; x < w; x++) {
      if (x + r < w && mask[row + x + r]) cnt++
      if (x - r - 1 >= 0 && mask[row + x - r - 1]) cnt--
      if (x >= 0) tmp[row + x] = cnt > 0 ? 1 : 0
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0
    for (let y = -r; y < h; y++) {
      if (y + r < h && tmp[(y + r) * w + x]) cnt++
      if (y - r - 1 >= 0 && tmp[(y - r - 1) * w + x]) cnt--
      if (y >= 0) out[y * w + x] = cnt > 0 ? 1 : 0
    }
  }
  return out
}

// 다중 소스 BFS: 라벨(≥1) 픽셀에서 미배정(0) 픽셀로 확장.
// intoWall=false: 비벽 픽셀만 / true: 벽 픽셀 포함(소유권 부여 단계)
function bfsExpand(label, wall, w, h, intoWall) {
  const N = w * h
  let frontier = []
  for (let i = 0; i < N; i++) {
    if (label[i] >= 1) frontier.push(i)
  }
  while (frontier.length) {
    const next = []
    for (const i of frontier) {
      const lb = label[i]
      const x = i % w, y = (i / w) | 0
      if (x > 0) tryTake(i - 1)
      if (x < w - 1) tryTake(i + 1)
      if (y > 0) tryTake(i - w)
      if (y < h - 1) tryTake(i + w)

      function tryTake(j) {
        if (label[j] !== 0) return
        if (!intoWall && wall[j]) return
        if (intoWall && !wall[j]) return
        label[j] = lb
        next.push(j)
      }
    }
    frontier = next
  }
}

// 리지 픽셀 집합 → 축정렬 밴드들 {vertical, c(라인), a..b(스팬 px), len}
function fitSegments(pxs, w) {
  // 가로/세로 히스토그램으로 지배 방향 판단 후, 지배 축 기준 1px 밴드 러닝
  const xs = pxs.map(i => i % w)
  const ys = pxs.map(i => (i / w) | 0)
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  // 픽셀들을 (라인 → 정렬된 좌표들)로 그룹화해 연속 런 추출, 라인 방향은 세그먼트별로 다를 수 있어
  // 두 방향 모두 시도해 긴 쪽 채택은 비싸므로: 지배 축 하나로 처리(교차 벽은 다른 라벨쌍에서 나옴)
  const vertical = spanY >= spanX
  const line = new Map() // c → sorted coords
  for (let k = 0; k < pxs.length; k++) {
    const c = vertical ? xs[k] : ys[k]
    const p = vertical ? ys[k] : xs[k]
    let arr = line.get(c)
    if (!arr) { arr = []; line.set(c, arr) }
    arr.push(p)
  }
  // 리지는 보통 1~2px 두께의 선 — c들을 ±2로 뭉쳐 하나의 라인으로
  const cs = [...line.keys()].sort((q, r3) => q - r3)
  const groups = []
  let cur = null
  for (const c of cs) {
    if (cur && c - cur.cMax <= 2) { cur.cMax = c; cur.cs.push(c) }
    else { cur = { cMin: c, cMax: c, cs: [c] }; groups.push(cur) }
  }
  const out = []
  for (const g of groups) {
    const coords = []
    for (const c of g.cs) coords.push(...line.get(c))
    coords.sort((q, r3) => q - r3)
    // 연속 런(갭 ≤ 6px 허용 — 리지의 소소한 끊김)
    let a = coords[0], last = coords[0]
    const cMid = Math.round((g.cMin + g.cMax) / 2)
    for (let k = 1; k <= coords.length; k++) {
      const v = coords[k]
      if (k === coords.length || v - last > 6) {
        if (last - a + 1 >= 3) out.push({ vertical, c: cMid, a, b: last, len: last - a + 1 })
        a = v
      }
      last = v
    }
  }
  return out
}

// 세그먼트 중점 표본들에서 수직 방향 벽 마스크 연속 폭의 중앙값(px)
function measureThickness(wall, w, h, s) {
  const samples = []
  const n = Math.min(9, s.len)
  for (let k = 0; k < n; k++) {
    const p = Math.round(s.a + ((k + 0.5) / n) * (s.b - s.a))
    const x0 = s.vertical ? s.c : p
    const y0 = s.vertical ? p : s.c
    // 리지에서 수직으로 벽 폭 측정(리지가 벽 내부에 있다고 가정, 양쪽으로 확장)
    let lo2 = 0, hi2 = 0
    if (s.vertical) {
      let x = x0
      while (x - 1 >= 0 && wall[y0 * w + x - 1]) { x--; lo2++ }
      x = x0
      while (x + 1 < w && wall[y0 * w + x + 1]) { x++; hi2++ }
      samples.push(wall[y0 * w + x0] ? lo2 + hi2 + 1 : 0)
    } else {
      let y = y0
      while (y - 1 >= 0 && wall[(y - 1) * w + x0]) { y--; lo2++ }
      y = y0
      while (y + 1 < h && wall[(y + 1) * w + x0]) { y++; hi2++ }
      samples.push(wall[y0 * w + x0] ? lo2 + hi2 + 1 : 0)
    }
  }
  const nz = samples.filter(v => v > 0).sort((q, r3) => q - r3)
  if (!nz.length) return 8
  return nz[Math.floor(nz.length / 2)]
}

// 동일선 근접 세그먼트 잇기 + 중복 흡수(간단판)
function mergeSegs(walls) {
  const isV = s => s.from.x === s.to.x
  const out = []
  for (const vertical of [false, true]) {
    const list = walls.filter(s => isV(s) === vertical).map(s => ({
      c: vertical ? s.from.x : s.from.z,
      p1: vertical ? Math.min(s.from.z, s.to.z) : Math.min(s.from.x, s.to.x),
      p2: vertical ? Math.max(s.from.z, s.to.z) : Math.max(s.from.x, s.to.x),
      t: s.thickness,
    }))
    let changed = true
    while (changed) {
      changed = false
      outer: for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i], B = list[j]
          const ov = Math.min(A.p2, B.p2) - Math.max(A.p1, B.p1)
          const near = Math.abs(A.c - B.c) <= Math.max(6, (A.t + B.t) / 4)
          if (!near) continue
          if (ov < -15 && !(ov >= -15)) continue
          if (ov < -15) continue
          const main = (A.p2 - A.p1) >= (B.p2 - B.p1) ? A : B
          A.p1 = Math.min(A.p1, B.p1)
          A.p2 = Math.max(A.p2, B.p2)
          A.c = main.c
          A.t = Math.max(A.t, B.t)
          list.splice(j, 1)
          changed = true
          break outer
        }
      }
    }
    for (const s of list) {
      out.push(vertical
        ? { from: { x: Math.round(s.c), z: Math.round(s.p1) }, to: { x: Math.round(s.c), z: Math.round(s.p2) }, thickness: Math.round(s.t) }
        : { from: { x: Math.round(s.p1), z: Math.round(s.c) }, to: { x: Math.round(s.p2), z: Math.round(s.c) }, thickness: Math.round(s.t) })
    }
  }
  return out
}
