// 밑그림 이미지에서 축 정렬 벽 자동 추출.
// 접근: 휘도 이진화(배경 대비 어두운 픽셀=벽, 청사진류는 극성 반전, 유채색 제외) →
// 가로/세로로 긴 런(run)의 띠(band)를 벽 사각형으로 묶고 → 가는 띠끼리 융합(창 다중선·CAD 중공벽 외곽선) →
// 두께·비율·채움율 필터로 글자·가구 선을 거른 뒤 → 동일선상 토막을 이어 벽 세그먼트로 변환.
// 사선·곡선 벽은 다루지 않는다. cm 문턱값들은 밑그림의 '실제 폭(cm)' 보정에 의존한다.
//
// 스타일별 실측(2026-07-12) 근거 규칙:
// - MIN_LEN 60: 문 옆 80~90cm 벽 토막이 100cm 문턱에 걸려 통째로 사라지던 문제(CAD·아파트 욕실벽)
// - MAX_CHROMA: 피난안내도 녹색 화살표·픽토그램, 금지구역 붉은 해칭이 벽으로 오인되던 문제
// - 가는 띠끼리만 융합: 두꺼운 벽이 옆 가구 선(조리대 모서리 등)을 흡수해 부풀던 문제.
//   CAD 중공벽(외곽선 2px 쌍)·창 다중선은 가는 띠끼리라 여전히 융합된다.
// - 채움율 검사 비율<12: 분양 평면도의 방이름+mm치수 텍스트 블롭(세장비 8~12)이 통과하던 문제

const MAX_SIDE = 1200      // 처리 해상도 상한(px)
const MIN_LEN_CM = 40      // 이보다 짧은 띠는 벽으로 안 봄(문 옆 40cm 스텁은 벽이다 — 글자는 판정 게이트가 거름)
const MIN_T_CM = 6         // 띠 추출 두께 하한(가는 선은 융합 후보로만)
const MAX_T_CM = 45        // 벽 두께 상한(색면·가구 채움 배제)
const MERGE_GAP_CM = 12    // 같은 줄에서 이 이하 끊김은 노이즈로 이음(문 개구부 60cm+는 유지)
const FUSE_DIST_CM = 22    // 나란한 '가는' 띠끼리 하나로 합칠 간격(창 다중선·중공벽 외곽선 쌍)
const MAX_CHROMA = 60      // max(RGB)-min(RGB)가 이보다 크면 유채색 장식으로 보고 벽에서 제외
const JOIN_GAP_CM = 20     // 동일선상 벽 토막 사이 이 이하 틈은 이어붙임(문 개구부보다 훨씬 작음)

// 최종 벽 판정(9종 스타일 실측 분포로 결정한 문턱):
// 두께 ≥ 9cm 이고,
// (a) 채움율 ≥ 0.7 = 속이 찬 보통 벽(비CAD 진짜 벽은 0.76~1.0, 글자 블롭은 ≤0.67)
// (b) 세장비 ≥ 14 & 채움율 ≥ 0.28 & 내부 밀도가 글자대(0.37~0.49)가 아님
//     = 창이 길게 낀 외벽·CAD 해칭 중공벽.
//     내부 라인 밀도(inter) 실측: CAD 해칭 벽 0.27~0.34(성긴 규칙 패턴) /
//     물결·창 낀 벽 0.56~0.67(벽체가 참) / 캡션 텍스트 0.43(획 밀도) — 중간대만 글자다.
//     (실제폭을 작게 보정하면 글자 틈이 병합돼 캡션이 세장비 14를 넘는 사례 대응)
// (c) 라인 연속성 ≥ 0.85 = 손그림처럼 물결쳐 채움율이 낮아도, 띠 안 거의 모든 라인이
//     스팬을 꽉 채우면 벽(글자는 획 라인만, 치수선은 선 라인 1~2줄만 차서 구분됨)
// (d) 테두리 선 쌍 = 짧은 해칭 중공벽(CAD 문옆 토막·욕실벽): 첫/끝 라인이 스팬의 85%+를
//     채우고 속에 해칭이 충분히(≥0.25) 있다. 글자는 테두리가 성기고, 치수선은 한 줄뿐이고,
//     옷장(이중선+행어 틱)은 내부 0.16~0.18이라 구분된다.
const WALL_MIN_T_CM = 9
const SOLID_FILL = 0.7
const HOLLOW_RATIO = 14
const HOLLOW_MIN_FILL = 0.28
const TEXT_INTER_LO = 0.36
const TEXT_INTER_HI = 0.5
const CONT_LINE_FILL = 0.7
const CONT_RATIO = 0.85
const EDGE_LINE_FILL = 0.85
const EDGE_INTERIOR_MIN = 0.25

export async function detectWalls(src, underlay, debug = false) {
  const img = await loadImage(src)
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const cmPerPx = underlay.widthCm / w

  const lum = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]
  }
  const sorted = Float32Array.from(lum).sort()
  const lo = sorted[Math.floor(sorted.length * 0.05)]
  const hi = sorted[Math.floor(sorted.length * 0.95)]
  if (hi - lo < 30) return [] // 대비가 없는 이미지
  const thr = (lo + hi) / 2
  let dark = 0
  for (let i = 0; i < lum.length; i++) if (lum[i] < thr) dark++
  const darkIsWall = dark <= lum.length / 2 // 어두운 픽셀이 과반이면(청사진) 밝은 쪽이 벽
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < lum.length; i++) {
    if ((lum[i] < thr) !== darkIsWall) continue
    const r4 = data[i * 4], g4 = data[i * 4 + 1], b4 = data[i * 4 + 2]
    const chroma = Math.max(r4, g4, b4) - Math.min(r4, g4, b4)
    if (chroma <= MAX_CHROMA) mask[i] = 1
  }

  const minLen = Math.max(3, Math.round(MIN_LEN_CM / cmPerPx))
  const mergeGap = Math.max(1, Math.round(MERGE_GAP_CM / cmPerPx))
  const fuseDist = Math.max(1, Math.round(FUSE_DIST_CM / cmPerPx))
  const thinPx = Math.max(1, Math.round(MIN_T_CM / cmPerPx))

  const walls = []
  for (const vertical of [false, true]) {
    let bands = extractBands(mask, w, h, minLen, mergeGap, vertical)
    bands = fuseBands(bands, fuseDist, thinPx)
    const segs = []
    for (const bd of bands) {
      // 끝단 정리: 치수 보조선·치수 숫자가 벽과 한 줄로 이어져 스팬을 오염시키는 경우 —
      // 양끝의 '벽답지 않은' 자잘한 조각을 잘라내고 실한 구간 사이만 남긴다
      // 실한 구간 문턱: 치수 숫자+치수선 조각(~34px)보다 크게 — 픽셀 하한 42를 둔다
      trimBandEnds(mask, w, bd, vertical, mergeGap, Math.max(42, Math.round(minLen * 0.8)))
      if (bd.b - bd.a + 1 < minLen) continue
      const tCm = (bd.end - bd.start + 1) * cmPerPx
      const lenCm = (bd.b - bd.a + 1) * cmPerPx
      if (tCm < MIN_T_CM || tCm > MAX_T_CM) continue
      if (lenCm < MIN_LEN_CM || lenCm / tCm < 2.5) continue
      const fill = fillRatio(mask, w, bd, vertical)
      const ratio = lenCm / tCm
      if (debug) {
        const es = edgeStats(mask, w, bd, vertical)
        segs.push({
          c: (bd.start + bd.end + 1) / 2 * cmPerPx, p1: bd.a * cmPerPx, p2: (bd.b + 1) * cmPerPx,
          t: Math.round(tCm), fused: !!bd.fused, fill: +fill.toFixed(2), ratio: +ratio.toFixed(1), vertical,
          edge: +es.edge.toFixed(2), inter: +es.inter.toFixed(2),
          cont: +contRatio(mask, w, bd, vertical).toFixed(2),
        })
        continue
      }
      if (tCm < WALL_MIN_T_CM) continue
      const hollowOk = () => {
        if (ratio < HOLLOW_RATIO || fill < HOLLOW_MIN_FILL) return false
        const { inter } = edgeStats(mask, w, bd, vertical)
        return inter <= TEXT_INTER_LO || inter >= TEXT_INTER_HI
      }
      if (!(fill >= SOLID_FILL ||
            hollowOk() ||
            contRatio(mask, w, bd, vertical) >= CONT_RATIO ||
            isOutlinePair(mask, w, bd, vertical))) continue
      segs.push({
        c: (bd.start + bd.end + 1) / 2 * cmPerPx,
        p1: bd.a * cmPerPx,
        p2: (bd.b + 1) * cmPerPx,
        t: Math.round(tCm),
      })
    }
    if (debug) { walls.push(...segs); continue }
    for (const s of joinCollinear(segs)) {
      walls.push(vertical
        ? { from: { x: r(underlay.x + s.c), z: r(underlay.z + s.p1) }, to: { x: r(underlay.x + s.c), z: r(underlay.z + s.p2) }, thickness: s.t }
        : { from: { x: r(underlay.x + s.p1), z: r(underlay.z + s.c) }, to: { x: r(underlay.x + s.p2), z: r(underlay.z + s.c) }, thickness: s.t })
    }
  }
  return debug ? walls : pruneToStructure(walls)
}

// 치수선·표제 등 '구조 밖' 요소 정리.
// 1) 코너 필터: 벽은 서로 닿아 직교 코너를 이루지만, 치수선·표제·가구 이중선은
//    나란하거나 고립돼 있다 — 가로·세로가 함께 있는 연결 무리만 남긴다.
// 2) 스팬 트림: 치수 보조선이 벽과 한 줄로 이어져 벽을 도면 여백까지 늘이는 오염이 있어,
//    직교 벽 중심선들이 정의하는 건물 범위로 각 벽의 스팬을 잘라낸다.
function pruneToStructure(walls) {
  const n = walls.length
  if (n === 0) return walls
  const isV = w => w.from.x === w.to.x
  const rects = walls.map(w => {
    const e = w.thickness / 2 + 4
    return {
      x1: Math.min(w.from.x, w.to.x) - e, x2: Math.max(w.from.x, w.to.x) + e,
      z1: Math.min(w.from.z, w.to.z) - e, z2: Math.max(w.from.z, w.to.z) + e,
    }
  })
  const parent = [...Array(n).keys()]
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rects[i].x1 <= rects[j].x2 && rects[j].x1 <= rects[i].x2 &&
          rects[i].z1 <= rects[j].z2 && rects[j].z1 <= rects[i].z2) {
        parent[find(i)] = find(j)
      }
    }
  }
  const comps = new Map()
  walls.forEach((w, i) => {
    const k = find(i)
    if (!comps.has(k)) comps.set(k, { h: false, v: false, idx: [] })
    const c = comps.get(k)
    c.idx.push(i)
    if (isV(w)) c.v = true
    else c.h = true
  })
  const kept = []
  for (const c of comps.values()) if (c.h && c.v) kept.push(...c.idx)
  if (!kept.length) return walls // 코너가 전혀 없으면 판단 보류 — 원본 유지
  let res = kept.map(i => walls[i])
  // 구제: 코너 없는 조각이라도 채택된 벽과 동일선상이면 같은 벽의 일부다
  // (물결친 벽이 창 구간에서 토막나 코너를 잃는 경우) — 치수선은 채택 벽과 다른 선 위라 제외됨
  const keptSet = new Set(kept)
  walls.forEach((w, i) => {
    if (keptSet.has(i)) return
    const c = isV(w) ? w.from.x : w.from.z
    if (res.some(k => isV(k) === isV(w) && Math.abs((isV(k) ? k.from.x : k.from.z) - c) <= 6)) {
      res.push(w)
    }
  })
  const maxT = Math.max(...res.map(w => w.thickness))
  const xs = res.filter(isV).map(w => w.from.x)
  const zs = res.filter(w => !isV(w)).map(w => w.from.z)
  const xr = [Math.min(...xs) - maxT, Math.max(...xs) + maxT]
  const zr = [Math.min(...zs) - maxT, Math.max(...zs) + maxT]
  res = res.map(w => {
    if (isV(w)) {
      const z1 = Math.max(Math.min(w.from.z, w.to.z), zr[0])
      const z2 = Math.min(Math.max(w.from.z, w.to.z), zr[1])
      return { ...w, from: { x: w.from.x, z: z1 }, to: { x: w.to.x, z: z2 } }
    }
    const x1 = Math.max(Math.min(w.from.x, w.to.x), xr[0])
    const x2 = Math.min(Math.max(w.from.x, w.to.x), xr[1])
    return { ...w, from: { x: x1, z: w.from.z }, to: { x: x2, z: w.to.z } }
  }).filter(w => (w.to.x - w.from.x) + (w.to.z - w.from.z) >= MIN_LEN_CM)
  return res
}

const r = v => Math.round(v)

// 라인 연속성: 띠 안에서 '스팬의 70% 이상이 칠해진 라인'의 비율.
// 물결친 벽은 모든 라인이 벽을 길게 관통하지만, 글자·치수선은 일부 라인만 찬다.
function contRatio(mask, w, bd, vertical) {
  const span = bd.b - bd.a + 1
  let good = 0
  for (let L = bd.start; L <= bd.end; L++) {
    let on = 0
    for (let i = bd.a; i <= bd.b; i++) {
      on += vertical ? mask[i * w + L] : mask[L * w + i]
    }
    if (on >= CONT_LINE_FILL * span) good++
  }
  return good / (bd.end - bd.start + 1)
}

// 스팬을 '벽다운 열'의 최장 연속 구간으로 줄인다 (제자리 수정).
// 벽다운 열 = 띠의 양끝 1/3 구역 모두에 픽셀이 있는 열(테두리 쌍 또는 벽체).
// 치수 보조선 꼬리는 선 하나뿐이라 벽답지 않고, 치수 숫자 무리는 벽과 큰 틈으로
// 떨어져 있어 — 틈(mergeGap 이하) 허용 연속 구간을 찾으면 벽 구간만 남는다.
function trimBandEnds(mask, w, bd, vertical, mergeGap, subst) {
  const t = bd.end - bd.start + 1
  if (t < 3) return
  const k = Math.max(1, Math.floor(t / 3))
  const at = (i, L) => (vertical ? mask[i * w + L] : mask[L * w + i])
  const colOK = i => {
    let ok = false
    for (let L = bd.start; L < bd.start + k; L++) if (at(i, L)) { ok = true; break }
    if (!ok) return false
    for (let L = bd.end - k + 1; L <= bd.end; L++) if (at(i, L)) return true
    return false
  }
  const runs = []
  let s = -1
  let lastOk = -1
  for (let i = bd.a; i <= bd.b + 1; i++) {
    const ok = i <= bd.b && colOK(i)
    if (ok) {
      if (s < 0) s = i
      else if (i - lastOk - 1 > mergeGap) {
        runs.push([s, lastOk])
        s = i
      }
      lastOk = i
    }
  }
  if (s >= 0) runs.push([s, lastOk])
  if (!runs.length) return
  // 양끝에서 실하지 않은(치수 숫자 크기의) 조각을 버린다 — 사이의 문 개구부 분절은 유지
  let lo = 0
  let hi = runs.length - 1
  while (lo < hi && runs[lo][1] - runs[lo][0] + 1 < subst) lo++
  while (hi > lo && runs[hi][1] - runs[hi][0] + 1 < subst) hi--
  bd.a = runs[lo][0]
  bd.b = runs[hi][1]
}

// 테두리 통계: edge = 첫/끝 라인 커버리지의 최소값, inter = 내부 라인 평균 커버리지
function edgeStats(mask, w, bd, vertical) {
  const span = bd.b - bd.a + 1
  const lineFill = L => {
    let on = 0
    for (let i = bd.a; i <= bd.b; i++) on += vertical ? mask[i * w + L] : mask[L * w + i]
    return on / span
  }
  const edge = Math.min(lineFill(bd.start), lineFill(bd.end))
  let inner = 0
  const rows = bd.end - bd.start - 1
  for (let L = bd.start + 1; L < bd.end; L++) inner += lineFill(L)
  return { edge, inter: rows > 0 ? inner / rows : 0 }
}

// (d)판정: 첫/끝 라인이 거의 꽉 찬 테두리 선 쌍 + 속에 해칭 소량 — 짧은 중공벽 시그니처
function isOutlinePair(mask, w, bd, vertical) {
  if (bd.end - bd.start + 1 < 3) return false
  const { edge, inter } = edgeStats(mask, w, bd, vertical)
  return edge >= EDGE_LINE_FILL && inter >= EDGE_INTERIOR_MIN
}

// 띠 사각형 내부의 마스크 채움율 (가로띠: 행 start..end × 열 a..b / 세로띠: 전치)
function fillRatio(mask, w, bd, vertical) {
  let on = 0
  for (let L = bd.start; L <= bd.end; L++) {
    for (let i = bd.a; i <= bd.b; i++) {
      on += vertical ? mask[i * w + L] : mask[L * w + i]
    }
  }
  return on / ((bd.end - bd.start + 1) * (bd.b - bd.a + 1))
}

// 라인(가로: y, 세로: x)별 런을 뽑아, 스팬이 겹치는 연속 라인들을 띠로 묶는다.
function extractBands(mask, w, h, minLen, mergeGap, vertical) {
  const W = vertical ? h : w // 런 진행 축 길이
  const H = vertical ? w : h // 라인 수
  const px = (i, L) => (vertical ? mask[i * w + L] : mask[L * w + i])
  const bands = []
  let active = []
  for (let L = 0; L < H; L++) {
    const runs = []
    let s = -1
    let lastOn = -1
    for (let i = 0; i < W; i++) {
      if (!px(i, L)) continue
      if (s < 0) s = i
      else if (i - lastOn - 1 > mergeGap) {
        if (lastOn - s + 1 >= minLen) runs.push([s, lastOn])
        s = i
      }
      lastOn = i
    }
    if (s >= 0 && lastOn - s + 1 >= minLen) runs.push([s, lastOn])

    const next = []
    for (const [a, b] of runs) {
      let hit = null
      for (const bd of active) {
        const ov = Math.min(b, bd.b) - Math.max(a, bd.a) + 1
        if (ov >= 0.8 * Math.min(b - a + 1, bd.b - bd.a + 1)) { hit = bd; break }
      }
      if (hit) {
        hit.a = Math.min(hit.a, a)
        hit.b = Math.max(hit.b, b)
        hit.end = L
        active = active.filter(x => x !== hit)
        next.push(hit)
      } else {
        next.push({ a, b, start: L, end: L })
      }
    }
    bands.push(...active) // 이번 라인에서 이어지지 못한 띠는 종료
    active = next
  }
  bands.push(...active)
  return bands
}

// 나란히 붙어 있는 '가는' 띠(창의 2~3중 선, CAD 중공벽 외곽선 쌍)를 하나의 벽으로 융합.
// 두꺼운(=이미 벽인) 띠는 융합하지 않는다 — 옆 가구 선을 흡수해 벽이 부풀지 않게.
function fuseBands(bands, fuseDist, thinPx) {
  const isThin = bd => bd.end - bd.start + 1 <= thinPx
  const sorted = [...bands].sort((p, q) => p.start - q.start)
  const out = []
  for (const bd of sorted) {
    let prev = null
    if (isThin(bd)) {
      // 겹침 기준을 '긴 쪽'으로: 스팬이 같은 나란한 선들만 융합(치수선에 숫자 텍스트가 들러붙는 것 방지)
      prev = out.find(o =>
        (o.fused || isThin(o)) &&
        bd.start - o.end - 1 <= fuseDist &&
        Math.min(bd.b, o.b) - Math.max(bd.a, o.a) + 1 >= 0.8 * Math.max(bd.b - bd.a + 1, o.b - o.a + 1))
    }
    if (prev) {
      prev.a = Math.min(prev.a, bd.a)
      prev.b = Math.max(prev.b, bd.b)
      prev.end = Math.max(prev.end, bd.end)
      prev.fused = true
    } else {
      out.push({ ...bd })
    }
  }
  return out
}

// 동일선상 벽 토막 잇기 + 겹침 중복 흡수.
// - 잇기: 중심선·두께가 비슷하고 틈 ≤ JOIN_GAP — 손그림처럼 벽이 물결쳐 토막나는 경우.
//   문 개구부(60cm+)는 틈이 커서 안 붙는다.
// - 흡수: 띠 추출이 라인당 런 1개만 밴드에 붙이는 한계로 같은 벽이 겹치는 조각으로
//   중복 검출되는 경우(창 구간에서 갈라진 외벽 조각 등) — 두 세그먼트의 몸통이 겹치면 합친다.
function joinCollinear(segs) {
  const list = segs.map(s => ({ ...s }))
  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j]
        const ov = Math.min(A.p2, B.p2) - Math.max(A.p1, B.p1)
        const joinable = Math.abs(A.c - B.c) <= 6 && Math.abs(A.t - B.t) <= 10 && -ov <= JOIN_GAP_CM
        const overlapping = Math.abs(A.c - B.c) < (A.t + B.t) / 2 &&
          ov >= 0.5 * Math.min(A.p2 - A.p1, B.p2 - B.p1)
        if (!joinable && !overlapping) continue
        const main = (A.p2 - A.p1) * A.t >= (B.p2 - B.p1) * B.t ? A : B
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
  return list
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error('이미지를 읽을 수 없어요'))
    img.src = src
  })
}
