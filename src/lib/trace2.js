// v2 공간 우선(room-first) 벽 인식 엔진 — 실험판. v1(trace.js)과 병행 평가용.
//
// 가설(LH 226장 전수조사로 검증, 정면 반례 0):
//   벽 = '어두운 띠'가 아니라 '공간(방)들 사이의 경계'다.
//   방 = 벽보다 밝은 균질 폐영역. 문 = 두 방을 잇는 좁은 개구부(경계인데 벽 픽셀이 없음).
//   글자·가구·치수선은 방 내부/외부에 있으므로 경계가 아니다 — 판정 게이트가 필요 없다.
//
// 파이프라인:
//   이진화(벽 마스크) → 실링용 구조 마스크(글자·점선·가구 제외) → 문 봉인 팽창으로 방 씨앗 분리
//   → 다중소스 BFS로 방 라벨 확장 → 갇힌 영역 복원(봉인이 씨앗을 지운 방·외부)
//   → 벽 픽셀 소유권 부여 → 라벨쌍 경계 리지 추출(벽 리지=벽 / 바닥 리지=문)
//   → 열린 경계 방 병합(문보다 넓은 바닥 인터페이스) → 최대 방 군집 선택(배너·카탈로그 시트 대응)
//   → 리지를 양방향 축정렬 세그먼트로 피팅 → 두께는 리지 주변 벽 마스크 실측 → v1과 동일한 스키마로 출력.
//
// cm 문턱이 거의 없어(봉인 반경 45cm, 최소 방 1.5㎡) 보정 오차에 구조적으로 강건하다.

const MAX_SIDE = 1200
const MAX_CHROMA = 60
const MIN_SEED_CM = 30       // 워터셰드 분지 씨앗 최소 거리(벽에서) — 이보다 얕은 극대점은 씨앗이 아니다
const POCKET_MIN_M2 = 0.7    // 갇힌 영역 복원 최소 면적 — 욕실·팬트리(1.2~1.5㎡)가 씨앗을 잃는 경우
const POCKET_MIN_DIM_CM = 55 // 포켓 최소 변 — 새시 이중선 사이 띠(20~30cm)는 방이 아니다
const MIN_WALL_LEN_CM = 40
const MIN_T_CM = 6
const MAX_T_CM = 60
const CLOSE_CM = 5           // 닫힘 반경 — 새시 창(가는 이중선+살) 틈을 벽 띠로 봉합
const SEAL_MIN_COMP_CM = 120 // 실링 참여 최소 성분 크기 — 글자·심볼·점선은 방을 가르면 안 된다
const FURN_MIN_CM = 75       // 양방향 모두 이보다 두꺼운 블롭 = 가구 — 실링에서 제외
const MERGE_OPEN_CM = 110    // 문(≤90cm)보다 넓은 연속 열린 인터페이스 = 같은 방
const MERGE_SADDLE_CM = 70   // + 경계 위 거리장 최대(=개구부 반폭)가 이 이상이어야 병합.
                             //   문(반폭≤45)과 문틈으로 샌 '혀' 경계는 벽에 붙어 D가 작아 차단되고,
                             //   심볼 분할·개방 플랜·잉크 없는 개구부는 D가 커서 병합된다.
const RIDGE_MIN_T_CM = 4     // 경계의 실측 벽 띠가 이보다 얇으면 벽이 아니라 심볼/개구부

export async function detectWalls2(src, underlay, debug = false) {
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
  const raw = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if ((lum[i] < thr) !== darkIsWall) continue
    const c = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) - Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])
    if (c <= MAX_CHROMA) raw[i] = 1
  }

  // ── 1a') 두꺼운 암부 내부 = 바닥 재분류 ──
  // 벽은 두께 MAX_T_CM 이하의 띠다. 양방향 모두 FURN_MIN_CM보다 두꺼운 어두운 영역
  // (어두운 타일 바닥 방·솔리드 가구 블롭)의 내부는 벽일 수 없다 — raw에서 제거해
  // 그 안에 분지·포켓이 형성되게 한다. (전역 이진화가 타일 바닥 방 전체를 벽으로
  // 분류해 방이 라벨 0으로 죽던 한계의 처방. 성분·구조 수준 차감으로는 포켓 단계가
  // wall 픽셀을 건너뛰지 못해 부족했다.)
  const rF = Math.max(1, Math.round(FURN_MIN_CM / 2 / cmPerPx))
  const thickCore = dilate(erode(raw, w, h, rF), w, h, rF)
  for (let i = 0; i < N; i++) if (thickCore[i]) raw[i] = 0
  // 중간회색 전용 열림: 벽은 잉크(어두움)지 중간회색이 아니다. 회색 픽셀만 모아
  // 50cm 이상 두꺼운 영역(타일 바닥·회색 가구)을 바닥으로 재분류 — 위생기구가
  // 타일 방을 75cm 미만 조각으로 쪼개도 잡힌다. CAD 해칭 벽 띠(~20cm)는 안전.
  {
    const grayThr2 = lo + 0.15 * (hi - lo) // 어두운 타일도 잉크보다는 밝다(잉크≈lo)
    const midGray = new Uint8Array(N)
    for (let i = 0; i < N; i++) if (raw[i] && lum[i] > grayThr2) midGray[i] = 1
    const rG = Math.max(1, Math.round(25 / cmPerPx))
    const grayCore = dilate(erode(midGray, w, h, rG), w, h, rG)
    for (let i = 0; i < N; i++) if (grayCore[i]) raw[i] = 0
  }

  // ── 1a) 닫힘(팽창→침식): 틈이 있는 부재를 벽 띠로 봉합 ──
  // 새시 창(fill~0.5의 가는 이중선+살) 틈으로 방 라벨이 새면 외부와 한 라벨이 되어
  // 그 벽의 리지가 통째로 사라진다(첫 벤치: 새시 recall 0.04의 원인).
  const closed = close(raw, w, h, Math.max(1, Math.round(CLOSE_CM / cmPerPx)))

  // 닫힌 마스크가 이후 단계의 벽(barrier·두께 실측)이다. 글자·점선·가구도 그대로 두는데,
  // 마스크 레벨에서 심볼을 걸러내는 건 합성물(점선+글자가 닫힘으로 한 성분이 되는 등)에
  // 취약해서다. 심볼이 방을 갈라도 경계 두께 판정(리지 단계)과 병합이 되돌린다.
  const wall = closed

  // ── 1b) 실링용 구조 마스크 ──
  // 봉인 팽창만은 구조 부재로 제한한다: 글자·점선이 45~55cm씩 부풀면 작은 방의
  // 씨앗이 통째로 지워진다(주방이 제 라벨 글자에 지워진 진단 결함).
  // 가구 판정은 닫힘 이전(raw)에서 한다 — 닫힘이 벽에 붙은 가구를 벽 띠와 한 덩어리로
  // 만들면 열림이 그 벽 구간까지 가구로 도려내 봉인 구멍이 생긴다(진단된 결함).
  const structural = structuralMask(closed, raw, lum, lo, hi, w, h, cmPerPx)

  // ── 2·3) 거리변환 워터셰드: 방 = 거리 지형의 분지, 문/개구부 = 안장 ──
  // (고정 반경 봉인의 두 결함 대체: ①작은 방은 봉인 침식에 씨앗이 소멸 ②이진화가 놓친
  //  희미한 새시 개구부는 어떤 반경으로도 못 막고 방이 여백으로 새어 전역이 한 라벨.
  //  워터셰드는 잉크 없는 개구부에도 기하학적 협착부에서 분지 경계를 만든다.
  //  과분할은 5b 열린 경계 병합이 치유.)
  const D = chebyshevDT(structural, w, h)
  const label = new Int32Array(N) // 0=미배정, 1=외부, 2..=방
  const stack = []
  const compPx = new Map() // label → px count
  let nextLabel = 2
  {
    const minSeedD = Math.max(3, Math.round(MIN_SEED_CM / cmPerPx))
    // 거리 내림차순 버킷 홍수(Meyer식 간이 워터셰드) — 비구조 픽셀만
    let maxD = 0
    for (let i = 0; i < N; i++) if (D[i] > maxD) maxD = D[i]
    const buckets = Array.from({ length: maxD + 1 }, () => [])
    for (let i = 0; i < N; i++) if (!structural[i] && D[i] > 0) buckets[D[i]].push(i)
    // 이웃은 8방향 — 체비쇼프 거리장(8이웃 메트릭)에 4이웃 홍수를 쓰면 대각 기울기
    // 지역에서 윗 레벨과 연결이 끊겨 행마다 새 씨앗이 생긴다(줄무늬 과분할 버그).
    for (let d = maxD; d >= 1; d--) {
      const bucket = buckets[d]
      for (let k = 0; k < bucket.length; k++) {
        const i = bucket[k]
        if (label[i]) continue
        const x = i % w, y = (i / w) | 0
        const x0 = x > 0, x1 = x < w - 1, y0 = y > 0, y1 = y < h - 1
        // 채택은 최급상승: D가 가장 높은 라벨 이웃 = 분지의 진짜 부모.
        // 고정 순서(왼쪽 우선)로 채택하면 같은 D의 평탄 등고선(벽과 평행한 행/열)이
        // 스캔 방향으로 통째로 찢겨 문틈 침입 라벨이 방의 벽면 띠를 차지한다
        // (가로벽 리지만 소실되던 비대칭의 원인 — 행은 좌→우로 찢기고 열은 보호됐음).
        let lb = 0, bestD = -1
        const adopt = j => { if (label[j] > 0 && D[j] > bestD) { bestD = D[j]; lb = label[j] } }
        if (x0) adopt(i - 1)
        if (x1) adopt(i + 1)
        if (y0) adopt(i - w)
        if (y1) adopt(i + w)
        if (y0 && x0) adopt(i - w - 1)
        if (y0 && x1) adopt(i - w + 1)
        if (y1 && x0) adopt(i + w - 1)
        if (y1 && x1) adopt(i + w + 1)
        if (!lb) {
          if (d < minSeedD) continue // 얕은 극대점은 씨앗이 아님 — 이웃 분지가 나중에 흡수
          lb = nextLabel++
        }
        label[i] = lb
        compPx.set(lb, (compPx.get(lb) || 0) + 1)
        // 같은 버킷(평탄부) 이웃이 즉시 이어받도록 같은 d 버킷 끝에 재시도 추가
        const tryPush = j => { if (!label[j] && !structural[j] && D[j] === d) bucket.push(j) }
        if (x0) tryPush(i - 1)
        if (x1) tryPush(i + 1)
        if (y0) tryPush(i - w)
        if (y1) tryPush(i + w)
        if (y0 && x0) tryPush(i - w - 1)
        if (y0 && x1) tryPush(i - w + 1)
        if (y1 && x0) tryPush(i + w - 1)
        if (y1 && x1) tryPush(i + w + 1)
      }
    }
    // 테두리 접촉 분지 = 외부(1)로 통합
    const borderLb = new Set()
    for (let x = 0; x < w; x++) {
      if (label[x] >= 2) borderLb.add(label[x])
      if (label[(h - 1) * w + x] >= 2) borderLb.add(label[(h - 1) * w + x])
    }
    for (let y = 0; y < h; y++) {
      if (label[y * w] >= 2) borderLb.add(label[y * w])
      if (label[y * w + w - 1] >= 2) borderLb.add(label[y * w + w - 1])
    }
    if (borderLb.size) {
      let acc = 0
      for (let i = 0; i < N; i++) if (borderLb.has(label[i])) { label[i] = 1; acc++ }
      for (const lb of borderLb) compPx.delete(lb)
      compPx.set(1, (compPx.get(1) || 0) + acc)
    }
  }

  // ── 3b) 갇힌 영역 복원 ──
  // 봉인 팽창이 씨앗을 통째로 지운 영역은 어느 라벨도 닿지 못해 0으로 남는다.
  // (예: 좁은 도면 여백 전체가 봉인돼 외부 씨앗이 사라짐 → 외벽 리지 전멸,
  //  가구·글자 실링에 씨앗을 잃은 작은 방.) 남은 비벽 성분을 수집해
  // 테두리 접촉이면 외부(1), 최소 면적 이상이면 새 방으로 되살린다.
  const pocketSeen = new Uint8Array(N)
  const pocketLog = []
  const minPocketPx = Math.max(30, Math.round(POCKET_MIN_M2 * 1e4 / (cmPerPx * cmPerPx)))
  const minPocketDim = Math.round(POCKET_MIN_DIM_CM / cmPerPx)
  for (let s = 0; s < N; s++) {
    if (label[s] || wall[s] || pocketSeen[s]) continue
    const px = []
    let touchesBorder = false
    let x1 = w, x2 = 0, y1 = h, y2 = 0
    stack.length = 0
    stack.push(s)
    pocketSeen[s] = 1
    while (stack.length) {
      const i = stack.pop()
      px.push(i)
      const x = i % w, y = (i / w) | 0
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true
      if (x < x1) x1 = x
      if (x > x2) x2 = x
      if (y < y1) y1 = y
      if (y > y2) y2 = y
      if (x > 0 && !wall[i - 1] && !label[i - 1] && !pocketSeen[i - 1]) { pocketSeen[i - 1] = 1; stack.push(i - 1) }
      if (x < w - 1 && !wall[i + 1] && !label[i + 1] && !pocketSeen[i + 1]) { pocketSeen[i + 1] = 1; stack.push(i + 1) }
      if (y > 0 && !wall[i - w] && !label[i - w] && !pocketSeen[i - w]) { pocketSeen[i - w] = 1; stack.push(i - w) }
      if (y < h - 1 && !wall[i + w] && !label[i + w] && !pocketSeen[i + w]) { pocketSeen[i + w] = 1; stack.push(i + w) }
    }
    let lb = 0
    if (touchesBorder) lb = 1
    else if (px.length >= minPocketPx && Math.min(x2 - x1, y2 - y1) + 1 >= minPocketDim) lb = nextLabel++
    if (px.length > 300) pocketLog.push({ size: px.length, touchesBorder, lb, x0: x1, x1: x2, y0: y1, y1: y2 })
    if (lb >= 1) {
      for (const i of px) label[i] = lb
      compPx.set(lb, (compPx.get(lb) || 0) + px.length)
    }
  }

  // ── 4) 벽 픽셀 소유권: 벽 마스크 안으로도 확장 ──
  bfsExpand(label, wall, w, h, true)

  // ── 4b) label 0 사각지대 흡수 ──
  // 크기 미달로 방이 못 된 비벽 조각(새시 이중선 사이 띠·가구 옆 틈)을 이웃 라벨
  // 다수결로 흡수한다 — 0으로 남으면 그 경계의 라벨쌍이 아예 안 생겨 새시 창이
  // 리지를 만들 기회조차 없다. (벽 소유권이 정해진 뒤라 다수결이 가능.)
  {
    const seen0 = new Uint8Array(N)
    for (let s = 0; s < N; s++) {
      if (label[s] || wall[s] || seen0[s]) continue
      const px = []
      stack.length = 0
      stack.push(s)
      seen0[s] = 1
      while (stack.length) {
        const i = stack.pop()
        px.push(i)
        const x = i % w, y = (i / w) | 0
        if (x > 0 && !wall[i - 1] && !label[i - 1] && !seen0[i - 1]) { seen0[i - 1] = 1; stack.push(i - 1) }
        if (x < w - 1 && !wall[i + 1] && !label[i + 1] && !seen0[i + 1]) { seen0[i + 1] = 1; stack.push(i + 1) }
        if (y > 0 && !wall[i - w] && !label[i - w] && !seen0[i - w]) { seen0[i - w] = 1; stack.push(i - w) }
        if (y < h - 1 && !wall[i + w] && !label[i + w] && !seen0[i + w]) { seen0[i + w] = 1; stack.push(i + w) }
      }
      const votes = new Map()
      for (const i of px) {
        const x = i % w, y = (i / w) | 0
        if (x > 0 && label[i - 1] >= 1) votes.set(label[i - 1], (votes.get(label[i - 1]) || 0) + 1)
        if (x < w - 1 && label[i + 1] >= 1) votes.set(label[i + 1], (votes.get(label[i + 1]) || 0) + 1)
        if (y > 0 && label[i - w] >= 1) votes.set(label[i - w], (votes.get(label[i - w]) || 0) + 1)
        if (y < h - 1 && label[i + w] >= 1) votes.set(label[i + w], (votes.get(label[i + w]) || 0) + 1)
      }
      let best = 0, bestN = 0
      for (const [l, n2] of votes) if (n2 > bestN) { bestN = n2; best = l }
      if (best >= 1) {
        for (const i of px) label[i] = best
        compPx.set(best, (compPx.get(best) || 0) + px.length)
      }
    }
  }

  // ── 5) 라벨쌍 경계 리지 (벽 리지=벽 / 바닥 리지=문·개구부) ──
  let { wallR, floorR } = extractRidges(label, structural, w, h)

  let preMergePng = null
  let preGrid = null
  if (debug) {
    preMergePng = renderLabelPng(label, wall, w, h, N)
    preGrid = sampleGrid(label, w, h, 20)
  }

  // ── 5b) 열린 경계 방 병합 ──
  // 문은 90cm 이하라 봉인이 닫지만, 그보다 넓은 '열린 인터페이스'(바닥, 또는 벽 띠가
  // RIDGE_MIN_T_CM보다 얇은 심볼 위 경계)로 만나는 두 라벨은 심볼·실링 부작용으로
  // 갈라진 한 공간이다(진단: 점선+글자 합성 성분이 거실을 두 방으로 갈랐음).
  const minTpx = RIDGE_MIN_T_CM / cmPerPx
  const mergeLog = []
  for (let iter = 0; iter < 8; iter++) {
    const parent = new Map()
    const find = l => { let r3 = l; while (parent.has(r3)) r3 = parent.get(r3); return r3 }
    let merged = false
    const openByPair = new Map()
    const thickByPair = new Map()
    for (const [k, pxs] of floorR) openByPair.set(k, [...pxs])
    for (const [k, pxs] of wallR) {
      let arr = openByPair.get(k)
      for (const i of pxs) {
        if (pxThickness(structural, w, h, i) >= minTpx) {
          thickByPair.set(k, (thickByPair.get(k) || 0) + 1)
          continue
        }
        if (!arr) { arr = []; openByPair.set(k, arr) }
        arr.push(i)
      }
    }
    for (const [k, pxs] of openByPair) {
      const a = Math.floor(k / 100000), b = k % 100000
      // 방-방뿐 아니라 방-외부(1) 병합도 허용: 치수선에 둘러싸인 여백 분지가
      // 넓고 깊은 열린 인터페이스로 외부와 이어져 있으면 방이 아니라 바깥이다
      if (b < 2 && a < 2) continue
      const maxRun = fitSegments(pxs, w).reduce((m2, s) => Math.max(m2, s.len), 0)
      if (maxRun * cmPerPx < MERGE_OPEN_CM) continue
      // 안장 검사: 경계 위 거리장 최대 = 실제 개구부 반폭. 문·문틈 '혀' 경계는 벽에
      // 붙어 있어 D가 작고(≤문 반폭), 진짜 열린 연결은 D가 크다.
      let maxSad = 0
      for (const i of pxs) if (D[i] > maxSad) maxSad = D[i]
      if (maxSad * cmPerPx < MERGE_SADDLE_CM) continue
      const ra = find(a), rb = find(b)
      if (ra !== rb) {
        parent.set(Math.max(ra, rb), Math.min(ra, rb))
        merged = true
        if (debug) mergeLog.push({ iter, a, b, runCm: Math.round(maxRun * cmPerPx), saddleCm: Math.round(maxSad * cmPerPx), openPx: pxs.length, thickPx: thickByPair.get(k) || 0 })
      }
    }
    if (!merged) break
    for (let i = 0; i < N; i++) if (label[i] >= 2) label[i] = find(label[i])
    for (const [l, n2] of [...compPx]) {
      const r3 = find(l)
      if (r3 !== l) { compPx.set(r3, (compPx.get(r3) || 0) + n2); compPx.delete(l) }
    }
    ;({ wallR, floorR } = extractRidges(label, structural, w, h))
  }

  // ── 6) 최대 방 군집 선택 (배너·카탈로그 시트: 본 도면만) ──
  // 방 인접 그래프(벽 또는 문(바닥) 리지 공유 = 인접, 외부(1) 제외) → 총면적 최대 군집
  const adj = new Map()
  for (const src2 of [wallR, floorR]) {
    for (const k of src2.keys()) {
      const a = Math.floor(k / 100000), b = k % 100000
      if (a === 1 || b === 1) continue
      if (!adj.has(a)) adj.set(a, new Set())
      if (!adj.has(b)) adj.set(b, new Set())
      adj.get(a).add(b)
      adj.get(b).add(a)
    }
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
  const maxTpx = Math.round(MAX_T_CM / cmPerPx)
  for (const [k, pxs] of wallR) {
    const a = Math.floor(k / 100000), b = k % 100000
    const aIn = keep.has(a), bIn = keep.has(b)
    if (!(aIn || bIn)) continue
    // 소유권 경계는 밴드 안에서 비스듬히 만나 계단으로 조각난다(긴 가로벽 부분검출의
    // 원인) — 각 리지 픽셀을 구조 띠의 중심선으로 스냅한 뒤 피팅한다.
    const segs = fitSegments(snapToBandCenter(pxs, structural, w, h, maxTpx), w)
    for (const s of segs) {
      const lenCm = s.len * cmPerPx
      // 길이 최종 판정은 mergeSegs 후에 — 워터셰드 경계는 지그재그라 리지가 짧은
      // 조각들로 쪼개지는데, 동일선 잇기가 이를 벽으로 조립한다(길이 선기각 시 전멸).
      if (lenCm < 18) continue
      // 두께: 세그먼트 표본점들에서 수직 방향 벽 마스크 폭 실측(0 포함 중앙값).
      // 실측 띠가 RIDGE_MIN_T_CM보다 얇으면 벽이 아니라 심볼 위 경계/개구부다.
      const tCm = measureThickness(structural, w, h, s) * cmPerPx
      let effT = tCm
      if (tCm < RIDGE_MIN_T_CM) {
        // 벽 띠는 없지만 창일 수 있다: 경계 주변 수직 프로파일에 평행 세선 ≥2 = 새시.
        // (새시 세선은 1~2px라 두께 게이트를 원리적으로 못 넘는다 — 진단 7/13.
        //  문은 개구부에 잉크가 없어 시그니처 미달로 자동 배제.)
        const winCm = windowStrip(raw, w, h, s, cmPerPx) * cmPerPx
        if (winCm < 10 || winCm > MAX_T_CM || lenCm < MIN_WALL_LEN_CM * 2) continue
        effT = winCm
      } else {
        // 벽 두께 상한을 크게 넘는 실측 = 교차부·블롭 위 조각(벽 아님) — 클램프 말고 폐기
        if (tCm > MAX_T_CM * 1.2) continue
        // 두께 대비 길이가 띠 꼴이 아니면 블롭(네트워크에 융합된 글자 슬래브·카운터) 위 경계.
        // 단, 같은 띠가 세그먼트 너머로 이어지면 벽이다 — 한 물리 벽이 라벨쌍별로 쪼개져
        // 짧아진 두꺼운 실전 벽 토막을 삼키지 않도록(성분 필터는 닫힘 융합에 무력).
        if (lenCm < tCm * 1.5 && !bandContinues(structural, w, h, s, Math.round(tCm / cmPerPx))) continue
      }
      const t = Math.round(Math.min(MAX_T_CM, Math.max(MIN_T_CM, effT)))
      const c = (s.c + 0.5) * cmPerPx
      const p1 = s.a * cmPerPx
      const p2 = (s.b + 1) * cmPerPx
      const win = tCm < RIDGE_MIN_T_CM // 창 시그니처로 승격된 세그먼트
      walls.push(s.vertical
        ? { from: { x: r2i(offX + c), z: r2i(offZ + p1) }, to: { x: r2i(offX + c), z: r2i(offZ + p2) }, thickness: t, win }
        : { from: { x: r2i(offX + p1), z: r2i(offZ + c) }, to: { x: r2i(offX + p2), z: r2i(offZ + c) }, thickness: t, win })
    }
  }
  // ── 7b) 바닥 리지의 창 승격 ──
  // 병합되지 않은(=안장 얕은, 진짜 분리) 쌍이 바닥 경계로 만나는 자리 중
  // 평행 세선 ≥2가 놓인 좁은 띠 = 새시 창. 문은 잉크가 없어 시그니처 미달.
  for (const [k, pxs] of floorR) {
    const a = Math.floor(k / 100000), b = k % 100000
    if (!(keep.has(a) || keep.has(b))) continue
    for (const s of fitSegments(pxs, w)) {
      const lenCm = s.len * cmPerPx
      if (lenCm < MIN_WALL_LEN_CM * 2) continue
      const winCm = windowStrip(raw, w, h, s, cmPerPx) * cmPerPx
      if (winCm < 10 || winCm > MAX_T_CM) continue
      const t = Math.round(Math.max(MIN_T_CM, winCm))
      const c = (s.c + 0.5) * cmPerPx
      const p1 = s.a * cmPerPx
      const p2 = (s.b + 1) * cmPerPx
      walls.push(s.vertical
        ? { from: { x: r2i(offX + c), z: r2i(offZ + p1) }, to: { x: r2i(offX + c), z: r2i(offZ + p2) }, thickness: t, win: true }
        : { from: { x: r2i(offX + p1), z: r2i(offZ + c) }, to: { x: r2i(offX + p2), z: r2i(offZ + c) }, thickness: t, win: true })
    }
  }
  const merged = mergeSegs(walls).filter(s =>
    Math.max(Math.abs(s.to.x - s.from.x), Math.abs(s.to.z - s.from.z)) >= MIN_WALL_LEN_CM)
  if (debug) {
    // 마스크 PNG: 흰=배경 / 연회색=closed만 / 검정=structural / 파랑조=sealed 영역 표시
    var maskPng = (() => {
      const c2 = document.createElement('canvas')
      c2.width = w
      c2.height = h
      const cx2 = c2.getContext('2d')
      const im2 = cx2.createImageData(w, h)
      for (let i = 0; i < N; i++) {
        let r3 = 255, g2 = 255, b2 = 255
        if (structural[i]) { r3 = 20; g2 = 20; b2 = 20 }
        else if (wall[i]) { r3 = 230; g2 = 120; b2 = 120 }
        im2.data[i * 4] = r3
        im2.data[i * 4 + 1] = g2
        im2.data[i * 4 + 2] = b2
        im2.data[i * 4 + 3] = 255
      }
      cx2.putImageData(im2, 0, 0)
      return c2.toDataURL('image/png')
    })()
    var segsDebug = []
    for (const [k, pxs] of wallR) {
      for (const s of fitSegments(pxs, w)) {
        segsDebug.push({ pair: [Math.floor(k / 100000), k % 100000], vertical: s.vertical, c: s.c, a: s.a, b: s.b, len: s.len, tPx: measureThickness(structural, w, h, s) })
      }
    }
  }
  if (!debug) return merged
  // 디버그: 라벨맵 PNG + 파이프라인 통계 (벤치 전용)
  const rooms = {}
  for (const [l, n2] of compPx) rooms[l] = Math.round(n2 * cmPerPx * cmPerPx / 1e4 * 100) / 100
  return {
    walls: merged,
    labelPng: renderLabelPng(label, wall, w, h, N),
    preMergePng,
    maskPng,
    stats: {
      cmPerPx, rooms, keep: [...keep], segsDebug, pocketLog, mergeLog, preGrid, postGrid: sampleGrid(label, w, h, 20),
      wallPairs: [...wallR.entries()].map(([k, v]) => {
        const wallFrac = v.filter(i => wall[i]).length / v.length
        const ths = v.map(i => pxThickness(structural, w, h, i)).sort((q, r3) => q - r3)
        return [Math.floor(k / 100000), k % 100000, v.length, Math.round(wallFrac * 100) / 100, ths[Math.floor(ths.length / 2)]]
      }),
      floorPairs: [...floorR.entries()].map(([k, v]) => [Math.floor(k / 100000), k % 100000, v.length]),
    },
  }
}

const r2i = v => Math.round(v)

// 디버그용 라벨 다운샘플 그리드 (step px 간격, 행 배열)
function sampleGrid(label, w, h, step) {
  const rows = []
  for (let y = 0; y < h; y += step) {
    const row = []
    for (let x = 0; x < w; x += step) row.push(label[y * w + x])
    rows.push(row)
  }
  return rows
}

// 디버그용 라벨맵 PNG (벽 픽셀은 0.45 음영)
function renderLabelPng(label, wall, w, h, N) {
  const cv2 = document.createElement('canvas')
  cv2.width = w
  cv2.height = h
  const ctx2 = cv2.getContext('2d')
  const im2 = ctx2.createImageData(w, h)
  const pal = [[0, 0, 0], [255, 255, 255], [230, 80, 80], [80, 160, 240], [90, 200, 120], [240, 200, 80], [180, 100, 220], [240, 140, 60], [110, 220, 220], [200, 220, 100]]
  for (let i = 0; i < N; i++) {
    const l = label[i]
    const col = l < 0 ? [255, 0, 255] : pal[l % pal.length]
    const shade = wall[i] ? 0.45 : 1
    im2.data[i * 4] = col[0] * shade
    im2.data[i * 4 + 1] = col[1] * shade
    im2.data[i * 4 + 2] = col[2] * shade
    im2.data[i * 4 + 3] = 255
  }
  ctx2.putImageData(im2, 0, 0)
  return cv2.toDataURL('image/png')
}

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

// 구조 부재만 남긴 벽 마스크. 벽 = 길게 이어진 네트워크(성분 bbox가 큼)이면서
// 띠로서의 실질 두께(면적/최장변)가 있는 것. 글자·치수·심볼은 bbox가 작아서,
// 닫힘으로 이어진 확장 점선은 평균 두께 ~2cm라서 걸러진다. 가구는 열림(두꺼운 블롭)+
// 톤 게이트(잉크보다 밝은 회색 블롭 — 장롱·소파·수납 심볼)로 제거.
function structuralMask(wall, raw, lum, lo, hi, w, h, cmPerPx) {
  const N = w * h
  const out = new Uint8Array(N)
  const minSide = Math.round(SEAL_MIN_COMP_CM / cmPerPx)
  const minThick = Math.max(1.5, 4 / cmPerPx) // 평균 두께 4cm 미만 성분 = 선형 심볼
  const smallThick = []
  const seen = new Uint8Array(N)
  const stack = []
  for (let s = 0; s < N; s++) {
    if (!wall[s] || seen[s]) continue
    stack.length = 0
    stack.push(s)
    seen[s] = 1
    const px = []
    let x1 = w, x2 = 0, y1 = h, y2 = 0
    while (stack.length) {
      const i = stack.pop()
      px.push(i)
      const x = i % w, y = (i / w) | 0
      if (x < x1) x1 = x
      if (x > x2) x2 = x
      if (y < y1) y1 = y
      if (y > y2) y2 = y
      if (x > 0 && wall[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1) }
      if (x < w - 1 && wall[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1) }
      if (y > 0 && wall[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w) }
      if (y < h - 1 && wall[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w) }
    }
    const maxDim = Math.max(x2 - x1, y2 - y1) + 1
    // 선형 심볼 판정은 주축 방향 '열 질량'의 중앙값(길이 가중)으로.
    // 픽셀(면적) 가중 통계는 점선 라인에 글자 블롭이 붙은 합성물에서 블롭이 지배해
    // 통과시킨다(-20% 보정에서만 나타나던 미해명 t45 가짜 벽의 원인).
    const horiz = (x2 - x1) >= (y2 - y1)
    // 열 '합산 질량'은 나란한 이중 라인(점선 두 줄)이 문턱을 넘는다 — 연속 런만 인정
    const colPx = new Map()
    for (const i of px) {
      const c2 = horiz ? (i % w) : ((i / w) | 0)
      let arr = colPx.get(c2)
      if (!arr) { arr = []; colPx.set(c2, arr) }
      arr.push(horiz ? ((i / w) | 0) : (i % w))
    }
    const runs = []
    for (const arr of colPx.values()) {
      arr.sort((q, r3) => q - r3)
      let best = 1, cur = 1
      for (let t2 = 1; t2 < arr.length; t2++) {
        if (arr[t2] === arr[t2 - 1] + 1) { cur++; if (cur > best) best = cur }
        else cur = 1
      }
      runs.push(best)
    }
    runs.sort((q, r3) => q - r3)
    if (runs[(runs.length / 2) | 0] < minThick) continue // 점선·문 호선 등 선형 심볼
    if (maxDim >= minSide) for (const i of px) out[i] = 1
    else smallThick.push(px) // 크기 미달이지만 띠 두께는 있는 조각 — 근접 구제 후보
  }
  // 문 옆 벽 토막 구제: 실전 JPEG에서 얇은 내벽이 조각나 크기 필터에 탈락하면
  // 유효 개구부가 문폭+토막 길이로 넓어져 봉인이 새고, 씨앗이 방들을 관통한다.
  // 대형 구조에 근접(25cm)한 두꺼운 조각만 재편입 — 글자는 방 중앙/여백이라 멀다.
  if (smallThick.length) {
    const prox = dilate(out, w, h, Math.max(1, Math.round(25 / cmPerPx)))
    for (const px of smallThick) {
      if (px.some(i => prox[i])) for (const i of px) out[i] = 1
    }
  }
  // (두꺼운 블롭 가구는 1a'에서 raw 자체에서 제거됨 — 여기서는 톤 게이트만)
  // 가구 ②: 톤 게이트 — 잉크(벽)보다 확연히 밝은 회색 블롭(소파·수납·장롱 심볼).
  // raw 성분 단위로 평균 밝기를 재고, 어느 정도 몸집(최소변 25cm)이 있으면 제외.
  // 얇은 벽·새시 잉크는 어둡고, 주방 카운터급 준벽(짙은 회색)은 문턱 아래라 유지된다.
  {
    const grayThr = lo + 0.3 * (hi - lo)
    const minDim2 = Math.round(25 / cmPerPx)
    const seen2 = new Uint8Array(N)
    const grayBlob = new Uint8Array(N)
    let anyGray = false
    for (let s = 0; s < N; s++) {
      if (!raw[s] || seen2[s]) continue
      stack.length = 0
      stack.push(s)
      seen2[s] = 1
      const px = []
      let x1 = w, x2 = 0, y1 = h, y2 = 0, sum = 0
      while (stack.length) {
        const i = stack.pop()
        px.push(i)
        sum += lum[i]
        const x = i % w, y = (i / w) | 0
        if (x < x1) x1 = x
        if (x > x2) x2 = x
        if (y < y1) y1 = y
        if (y > y2) y2 = y
        if (x > 0 && raw[i - 1] && !seen2[i - 1]) { seen2[i - 1] = 1; stack.push(i - 1) }
        if (x < w - 1 && raw[i + 1] && !seen2[i + 1]) { seen2[i + 1] = 1; stack.push(i + 1) }
        if (y > 0 && raw[i - w] && !seen2[i - w]) { seen2[i - w] = 1; stack.push(i - w) }
        if (y < h - 1 && raw[i + w] && !seen2[i + w]) { seen2[i + w] = 1; stack.push(i + w) }
      }
      if (Math.min(x2 - x1, y2 - y1) + 1 < minDim2) continue
      if (sum / px.length <= grayThr) continue
      for (const i of px) grayBlob[i] = 1
      anyGray = true
    }
    if (anyGray) {
      // 닫힘 팽창 반경만큼 부풀려 제거(닫힘이 이어붙인 주변부까지)
      const blobD = dilate(grayBlob, w, h, Math.max(1, Math.round(CLOSE_CM / cmPerPx)))
      for (let i = 0; i < N; i++) if (blobD[i]) out[i] = 0
    }
  }
  return out
}

// 라벨쌍 경계 리지: 서로 다른 라벨(≥1)이 만나는 자리.
// 어느 한쪽이 벽 픽셀이면 벽 리지, 둘 다 바닥이면 문/개구부 리지.
function extractRidges(label, wall, w, h) {
  const wallR = new Map()
  const floorR = new Map()
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x
      const a = label[i]
      for (const j of [i + 1, i + w]) {
        const b = label[j]
        if (a === b || a < 1 || b < 1) continue
        const m = (wall[i] || wall[j]) ? wallR : floorR
        const k = a < b ? a * 100000 + b : b * 100000 + a
        let arr = m.get(k)
        if (!arr) { arr = []; m.set(k, arr) }
        arr.push(i)
      }
    }
  }
  return { wallR, floorR }
}

// 닫힘 = 팽창 후 침식 — 2r 이하의 내부 틈을 메우고 외곽은 보존.
// 침식은 경계 밖을 배경으로 취급해야 한다(반전 팽창으로 구현하면 이미지 가장자리의
// 좁은 도면 여백이 벽으로 메워져 외부 라벨이 파편화된다).
function close(mask, w, h, r) {
  return erode(dilate(mask, w, h, r), w, h, r)
}

// 체비쇼프(L∞) 거리변환 — 각 픽셀에서 가장 가까운 구조 픽셀까지의 거리. 2패스 챔퍼(8이웃)
function chebyshevDT(mask, w, h) {
  const N = w * h
  const INF = 1 << 29
  const D = new Int32Array(N)
  for (let i = 0; i < N; i++) D[i] = mask[i] ? 0 : INF
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!D[i]) continue
      let m = D[i]
      if (x > 0 && D[i - 1] + 1 < m) m = D[i - 1] + 1
      if (y > 0) {
        if (D[i - w] + 1 < m) m = D[i - w] + 1
        if (x > 0 && D[i - w - 1] + 1 < m) m = D[i - w - 1] + 1
        if (x < w - 1 && D[i - w + 1] + 1 < m) m = D[i - w + 1] + 1
      }
      D[i] = m
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (!D[i]) continue
      let m = D[i]
      if (x < w - 1 && D[i + 1] + 1 < m) m = D[i + 1] + 1
      if (y < h - 1) {
        if (D[i + w] + 1 < m) m = D[i + w] + 1
        if (x < w - 1 && D[i + w + 1] + 1 < m) m = D[i + w + 1] + 1
        if (x > 0 && D[i + w - 1] + 1 < m) m = D[i + w - 1] + 1
      }
      D[i] = m
    }
  }
  return D
}

// 체비쇼프(사각) 침식 — 창 전체가 채워진 픽셀만 생존, 경계 밖 = 배경
function erode(mask, w, h, r) {
  const tmp = new Uint8Array(mask.length)
  const out = new Uint8Array(mask.length)
  const full = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let cnt = 0
    for (let x = -r; x < w; x++) {
      if (x + r < w && mask[row + x + r]) cnt++
      if (x - r - 1 >= 0 && mask[row + x - r - 1]) cnt--
      if (x >= 0) tmp[row + x] = cnt === full ? 1 : 0
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0
    for (let y = -r; y < h; y++) {
      if (y + r < h && tmp[(y + r) * w + x]) cnt++
      if (y - r - 1 >= 0 && tmp[(y - r - 1) * w + x]) cnt--
      if (y >= 0) out[y * w + x] = cnt === full ? 1 : 0
    }
  }
  return out
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

// 리지 픽셀 집합 → 축정렬 밴드들 {vertical, c(라인), a..b(스팬 px), len}.
// 탐욕적 벗겨내기: 두 방향 모두에서 가장 긴 연속 런을 찾아 세그먼트로 떼어내고 반복.
// (지배축 1회 피팅은 외곽 고리·L자 경계에서 c 그룹이 ±2 사슬로 이어져 전체가
//  도면 한가운데의 한 라인으로 붕괴하거나 한 방향이 통째로 소실된다 — 진단된 결함.)
function fitSegments(pxs, w) {
  const n = pxs.length
  if (n < 3) return []
  const xs = new Int32Array(n)
  const ys = new Int32Array(n)
  for (let k = 0; k < n; k++) {
    xs[k] = pxs[k] % w
    ys[k] = (pxs[k] / w) | 0
  }
  const alive = new Uint8Array(n).fill(1)
  const out = []
  for (let guard = 0; guard < 64; guard++) {
    const maps = [new Map(), new Map()] // [가로(c=y, p=x), 세로(c=x, p=y)]
    for (let k = 0; k < n; k++) {
      if (!alive[k]) continue
      for (let o = 0; o < 2; o++) {
        const c = o ? xs[k] : ys[k]
        let arr = maps[o].get(c)
        if (!arr) { arr = []; maps[o].set(c, arr) }
        arr.push(o ? ys[k] : xs[k], k)
      }
    }
    // 리지는 1~2px 두께 — c±1 병합 라인에서 최장 런(갭 ≤ 6px 허용)을 찾는다
    let best = null
    for (let o = 0; o < 2; o++) {
      for (const c of maps[o].keys()) {
        const pts = []
        for (let dc = -1; dc <= 1; dc++) {
          const arr = maps[o].get(c + dc)
          if (arr) for (let t2 = 0; t2 < arr.length; t2 += 2) pts.push([arr[t2], arr[t2 + 1], c + dc])
        }
        if (pts.length < 3) continue
        pts.sort((q, r3) => q[0] - r3[0])
        let runStart = 0
        for (let k = 1; k <= pts.length; k++) {
          if (k === pts.length || pts[k][0] - pts[k - 1][0] > 6) {
            const len = pts[k - 1][0] - pts[runStart][0] + 1
            if (len >= 3 && (!best || len > best.len)) best = { o, len, pts: pts.slice(runStart, k) }
            runStart = k
          }
        }
      }
    }
    if (!best) break
    const a = best.pts[0][0], b = best.pts[best.pts.length - 1][0]
    let cSum = 0
    for (const p of best.pts) {
      cSum += p[2]
      alive[p[1]] = 0
    }
    out.push({ vertical: best.o === 1, c: Math.round(cSum / best.pts.length), a, b, len: b - a + 1 })
  }
  return out
}

// 창(새시) 시그니처: 세그먼트 표본점들의 수직 프로파일(±32cm)에서 가는 잉크 선
// (두께 ≤8cm) 개수를 센다. 중앙값 ≥2면 창 — 반환값은 선들이 걸친 스팬(px, =창틀 폭).
// 두꺼운 잉크 런이 걸리면 그 표본은 실격(-99) — 벽·가구 옆 오탐 방지.
function windowStrip(raw, w, h, s, cmPerPx) {
  const half = Math.round(32 / cmPerPx)
  const maxLineT = Math.max(2, Math.round(8 / cmPerPx))
  const n = Math.min(15, s.len)
  const counts = []
  const spans = []
  for (let k = 0; k < n; k++) {
    const p = Math.round(s.a + ((k + 0.5) / n) * (s.b - s.a))
    const x0 = s.vertical ? s.c : p
    const y0 = s.vertical ? p : s.c
    let cnt = 0, run = 0, first = 99999, last = -99999
    for (let d = -half; d <= half + 1; d++) {
      const x = s.vertical ? x0 + d : x0
      const y = s.vertical ? y0 : y0 + d
      const v = d <= half && x >= 0 && y >= 0 && x < w && y < h && raw[y * w + x] ? 1 : 0
      if (v) {
        run++
        if (d < first) first = d
        last = d
      } else {
        if (run > 0 && run <= maxLineT) cnt++
        else if (run > maxLineT) cnt = -99
        run = 0
      }
    }
    counts.push(cnt)
    spans.push(last >= first ? last - first + 1 : 0)
  }
  counts.sort((q, r3) => q - r3)
  // 30퍼센타일 — 새시는 연속선이라 표본 대부분이 2줄을 보지만, 확장 점선 쌍(듀티 ~60%)은
  // 표본의 40%가 빈 구간에 떨어져 탈락한다(중앙값이면 점선 쌍이 창으로 오승격 — 실측 결함)
  if (counts[(counts.length * 0.3) | 0] < 2) return 0
  spans.sort((q, r3) => q - r3)
  return spans[(spans.length / 2) | 0]
}

// 세그먼트 라인이 양끝 너머로도 구조 띠 위를 달리는지(한쪽이라도 70%+ 점유) 검사
function bandContinues(structural, w, h, s, ext) {
  if (ext < 3) ext = 3
  const occ = (p1, p2) => {
    let n = 0, hit = 0
    for (let p = p1; p <= p2; p++) {
      const x = s.vertical ? s.c : p
      const y = s.vertical ? p : s.c
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      n++
      if (structural[y * w + x]) hit++
    }
    return n ? hit / n : 0
  }
  return occ(s.a - ext, s.a - 1) >= 0.7 || occ(s.b + 1, s.b + ext) >= 0.7
}

// 리지 픽셀을 구조 띠의 중심선으로 투영: 두께 방향(짧은 런)의 중점으로 스냅.
// 비구조 픽셀·교차부(양방향 모두 두꺼움)는 그대로 둔다.
function snapToBandCenter(pxs, structural, w, h, maxTpx) {
  const LIM = 90
  const out = new Array(pxs.length)
  for (let k = 0; k < pxs.length; k++) {
    const i = pxs[k]
    if (!structural[i]) { out[k] = i; continue }
    const x = i % w, y = (i / w) | 0
    let a = x
    while (a > 0 && x - a < LIM && structural[y * w + a - 1]) a--
    let b = x
    while (b < w - 1 && b - x < LIM && structural[y * w + b + 1]) b++
    let c = y
    while (c > 0 && y - c < LIM && structural[(c - 1) * w + x]) c--
    let d = y
    while (d < h - 1 && d - y < LIM && structural[(d + 1) * w + x]) d++
    const runH = b - a + 1, runV = d - c + 1
    if (Math.min(runH, runV) > maxTpx) { out[k] = i; continue }
    out[k] = runV <= runH
      ? Math.round((c + d) / 2) * w + x
      : y * w + Math.round((a + b) / 2)
  }
  return out
}

// 한 픽셀에서의 벽 띠 두께: 가로/세로 연속 벽 런 중 짧은 쪽(px). 벽이 아니면 0
function pxThickness(wall, w, h, i) {
  if (!wall[i]) return 0
  const LIM = 80
  const x = i % w, y = (i / w) | 0
  let a = x
  while (a > 0 && x - a < LIM && wall[y * w + a - 1]) a--
  let b = x
  while (b < w - 1 && b - x < LIM && wall[y * w + b + 1]) b++
  let c = y
  while (c > 0 && y - c < LIM && wall[(c - 1) * w + x]) c--
  let d = y
  while (d < h - 1 && d - y < LIM && wall[(d + 1) * w + x]) d++
  return Math.min(b - a + 1, d - c + 1)
}

// 세그먼트 표본점들에서 수직 방향 벽 마스크 연속 폭의 중앙값(px).
// 0(벽 없음)도 표본에 포함 — 표본 과반이 바닥이면 0이 나와 벽이 아님이 드러난다.
function measureThickness(wall, w, h, s) {
  const samples = []
  const n = Math.min(15, s.len)
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
  samples.sort((q, r3) => q - r3)
  // 20퍼센타일 — 중앙값·35퍼센타일은 리지에 접한 가구·수납 블롭이 두께를 60cm급으로
  // 오염시킨다. 진짜 벽은 표본이 균일해 퍼센타일에 둔감하고, 개구부 리지는 0이 많아 탈락.
  return samples[Math.floor(samples.length * 0.2)]
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
      win: !!s.win,
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
          // 두께는 주(긴) 세그먼트의 것 — max를 취하면 교차부의 두꺼운 조각이 본벽을 오염
          A.t = main.t
          A.win = main.win
          list.splice(j, 1)
          changed = true
          break outer
        }
      }
    }
    for (const s of list) {
      const wallOut = vertical
        ? { from: { x: Math.round(s.c), z: Math.round(s.p1) }, to: { x: Math.round(s.c), z: Math.round(s.p2) }, thickness: Math.round(s.t) }
        : { from: { x: Math.round(s.p1), z: Math.round(s.c) }, to: { x: Math.round(s.p2), z: Math.round(s.c) }, thickness: Math.round(s.t) }
      if (s.win) {
        // 창 승격 세그먼트: 스키마 openings(window)로 분리 — 3D 새시 렌더·충돌 파이프라인 연결
        const len = Math.round(s.p2 - s.p1)
        if (len > 16) wallOut.openings = [{ type: 'window', offset: 4, width: len - 8, height: 120 }]
      }
      out.push(wallOut)
    }
  }
  return out
}
