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
const MAX_T_CM = 60        // 벽 두께 상한(색면·가구 채움 배제) — 실전 LH 도면은 구조벽을 과장해 그려 45로는 주벽이 잘렸다(두꺼운 글자 블롭은 채움율·내부밀도 게이트가 거름)
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
  // 내용 영역 자동 크롭: 실전 도면(LH 등)은 이미지의 절반 이상이 여백인 경우가 많아
  // 히스토그램 백분위가 오염되고(이진화 문턱이 바닥재까지 삼킴) 유효 해상도도 낭비된다.
  // 테두리 표본으로 배경색을 정하고, 배경과 다른 픽셀의 bbox만 처리한다.
  const crop = findContentBox(img)
  // 작은 이미지는 업스케일해 정규화 — 실전 저해상도 도면(px당 2~3cm)에서 병합·두께
  // 문턱이 픽셀 단위로 뭉개지는 것을 막는다(보간이 선을 매끈하게 이어줘 띠가 안정됨)
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
  // 이하 파이프라인의 좌표 원점은 '크롭 프레임' — 최종 벽 좌표는 이 오프셋으로 원본 cm 프레임에 얹힌다
  underlay = { x: underlay.x + crop.x * fullCmPerPx, z: underlay.z + crop.y * fullCmPerPx, widthCm: crop.w * fullCmPerPx }

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
  // (실험 기록) 경계 히스테리시스로 벽 코어에 붙은 중간 회색을 흡수하는 방식은
  // LH 15장 배치에서 득실이 갈리고(일부 +0.1, 일부 -0.14) 합성 픽스처 3종이 회귀해 기각.
  // 회색 새시 검출은 라벨 데이터 기반 정량 평가가 갖춰진 뒤 재시도한다.

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
  if (debug) return walls
  const res = pruneToStructure(walls)
  completeWallLines(res, mask, w, h, cmPerPx, underlay, mergeGap)
  detectGlazing(res, mask, w, h, cmPerPx, underlay)
  return res
}

// 벽 속 유리 구간(창·유리벽) 식별 → openings[{type:'window'}]로 등록.
// 시그니처: 창 심볼은 벽 두께 안의 가는 2~3중 평행선 — 열 채움율이 낮으면서(≤0.75)
// 띠 '내부'에 구간을 관통하는 연속된 선(중간선)이 존재한다. 솔리드 벽은 열이 꽉 차고,
// CAD 해칭은 내부 픽셀이 있어도 연속된 한 줄이 없어 구분된다.
// 평면도에는 높이 정보가 없으므로: 벽 일부 구간=창문(sill 90 기본), 스팬의 85%+가
// 유리면=전면 유리벽으로 보고 sill 0·거의 전고 개구부 하나로 등록한다.
function detectGlazing(walls, mask, w, h, cmPerPx, underlay) {
  const isV = s => s.from.x === s.to.x
  for (const wall of walls) {
    const vertical = isV(wall)
    const c = vertical ? wall.from.x : wall.from.z
    const a = vertical ? Math.min(wall.from.z, wall.to.z) : Math.min(wall.from.x, wall.to.x)
    const b = vertical ? Math.max(wall.from.z, wall.to.z) : Math.max(wall.from.x, wall.to.x)
    const len = b - a
    if (len < 60) continue
    const cPx = Math.round((c - (vertical ? underlay.x : underlay.z)) / cmPerPx)
    const halfT = Math.max(1, Math.round(wall.thickness / cmPerPx / 2))
    const L1 = Math.max(0, cPx - halfT)
    const L2 = Math.min((vertical ? w : h) - 1, cPx + halfT)
    const inset = Math.max(2, Math.round((L2 - L1 + 1) * 0.25))
    if (L2 - inset <= L1 + inset) continue
    const off = vertical ? underlay.z : underlay.x
    const pa = Math.max(0, Math.round((a - off) / cmPerPx))
    const pb = Math.min((vertical ? h : w) - 1, Math.round((b - off) / cmPerPx))
    const at = (i, L) => (vertical ? mask[i * w + L] : mask[L * w + i])
    const colStat = i => {
      let total = 0
      let interior = 0
      for (let L = L1; L <= L2; L++) {
        const v = at(i, L)
        total += v
        if (v && L >= L1 + inset && L <= L2 - inset) interior = 1
      }
      return { fill: total / (L2 - L1 + 1), interior }
    }
    // 유리 후보 열의 연속 구간 수집
    const gap = Math.max(4, Math.round(10 / cmPerPx))
    const runs = []
    let s0 = -1
    let last = -1
    for (let i = pa; i <= pb + 1; i++) {
      let ok = false
      if (i <= pb) {
        const st = colStat(i)
        ok = st.interior === 1 && st.fill <= 0.75
      }
      if (ok) {
        if (s0 < 0) s0 = i
        else if (i - last - 1 > gap) { runs.push([s0, last]); s0 = i }
        last = i
      }
    }
    if (s0 >= 0) runs.push([s0, last])
    const openings = []
    for (const [ra, rb] of runs) {
      const wCm = (rb - ra + 1) * cmPerPx
      if (wCm < 40) continue
      // 결정타: 띠 '중앙부'를 관통하는 '가는' 연속선(창 중간선)이 있어야 유리.
      // 물결친 솔리드 벽은 몸통이 두껍고, CAD 해칭 테두리·문턱선은 가장자리라 배제된다.
      const tRows = L2 - L1 + 1
      const midLo = L1 + Math.max(2, Math.round(tRows * 0.3))
      const midHi = L2 - Math.max(2, Math.round(tRows * 0.3))
      const maxThin = Math.max(2, tRows * 0.35)
      let hasMidLine = false
      let clStart = -1
      for (let L = L1; L <= L2 + 1; L++) {
        let on = 0
        if (L <= L2) for (let i = ra; i <= rb; i++) on += at(i, L)
        const covOk = L <= L2 && on >= 0.65 * (rb - ra + 1)
        if (covOk && clStart < 0) clStart = L
        if (!covOk && clStart >= 0) {
          const mid = (clStart + L - 1) / 2
          if (mid >= midLo && mid <= midHi && L - clStart <= maxThin) hasMidLine = true
          clStart = -1
        }
      }
      if (!hasMidLine) continue
      openings.push({
        type: 'window',
        offset: Math.max(0, Math.round(ra * cmPerPx + off - a)),
        width: Math.round(wCm),
        height: 120,
      })
    }
    if (!openings.length) continue
    const covered = openings.reduce((s2, o) => s2 + o.width, 0)
    if (covered / len >= 0.85) {
      // 전면 유리벽: 개구부 하나로 거의 전체를 뚫는다(허리벽 없음)
      wall.openings = [{ type: 'window', offset: 4, width: Math.round(len - 8), sillHeight: 0, height: 220 }]
    } else {
      wall.openings = openings
    }
  }
}

// 문 옆 잔여 벽 보완: 검출된 벽 '선' 위를 마스크로 재주사해, 직교 벽이나 기존 구간에
// 붙어 있는 미검출 토막(문~코너 사이 8~80cm)을 추가한다. 이 크기대는 길이 문턱으로는
// 글자와 구분이 불가능하지만, '이미 확정된 벽 선 위 + 구조에 접함'이라는 위치 제약이
// 대신 걸러준다. 문 개구부는 마스크에 벽 픽셀이 없어 메워지지 않는다.
function completeWallLines(walls, mask, w, h, cmPerPx, underlay, mergeGapPx) {
  const isV = s => s.from.x === s.to.x
  const lines = new Map()
  for (const s of walls) {
    const key = `${isV(s) ? 'v' : 'h'}${Math.round((isV(s) ? s.from.x : s.from.z) / 4)}`
    if (!lines.has(key)) lines.set(key, s)
  }
  const span = (o, vertical) => (vertical
    ? [Math.min(o.from.z, o.to.z), Math.max(o.from.z, o.to.z)]
    : [Math.min(o.from.x, o.to.x), Math.max(o.from.x, o.to.x)])
  const added = []
  for (const ref of lines.values()) {
    const vertical = isV(ref)
    const c = vertical ? ref.from.x : ref.from.z
    const t = ref.thickness
    const cPx = Math.round((c - (vertical ? underlay.x : underlay.z)) / cmPerPx)
    const halfT = Math.max(1, Math.round(t / cmPerPx / 2))
    const L1 = Math.max(0, cPx - halfT)
    const L2 = Math.min((vertical ? w : h) - 1, cPx + halfT)
    if (L2 - L1 < 2) continue
    const k = Math.max(1, Math.floor((L2 - L1 + 1) / 3))
    const N = vertical ? h : w
    const at = (i, L) => (vertical ? mask[i * w + L] : mask[L * w + i])
    const colOK = i => {
      let ok = false
      for (let L = L1; L < L1 + k; L++) if (at(i, L)) { ok = true; break }
      if (!ok) return false
      for (let L = L2 - k + 1; L <= L2; L++) if (at(i, L)) return true
      return false
    }
    const runs = []
    let s0 = -1
    let last = -1
    for (let i = 0; i <= N; i++) {
      const ok = i < N && colOK(i)
      if (ok) {
        if (s0 < 0) s0 = i
        else if (i - last - 1 > mergeGapPx) { runs.push([s0, last]); s0 = i }
        last = i
      }
    }
    if (s0 >= 0) runs.push([s0, last])
    const off = vertical ? underlay.z : underlay.x
    const same = walls.filter(o => isV(o) === vertical &&
      Math.abs((isV(o) ? o.from.x : o.from.z) - c) <= 6)
    const crossers = walls.filter(o => isV(o) !== vertical).filter(o => {
      const [lo, hi] = span(o, !vertical)
      return c >= lo - 15 && c <= hi + 15
    }).map(o => ({ cc: vertical ? o.from.z : o.from.x, half: o.thickness / 2 + 2 }))
    for (const [ra, rb] of runs) {
      let a = off + ra * cmPerPx
      let b = off + (rb + 1) * cmPerPx
      if (b - a > 100) continue
      // 직교 벽 몸통과 겹치는 부분을 빼고 남는 '가시 토막'으로 판단 —
      // 벽 선이 직교 벽 몸통을 그냥 통과하는 지점은 가시 토막이 0이라 걸러진다
      let va = a
      let vb = b
      for (const { cc, half } of crossers) {
        if (cc - half <= va && va < cc + half) va = Math.min(cc + half, vb)
        if (cc - half < vb && vb <= cc + half) vb = Math.max(cc - half, va)
      }
      if (vb - va < 2) continue
      // 가시 토막의 벽다운 열 밀도 — 가구 모서리선이 벽 선을 스치는 지점(밀도 낮음) 배제
      {
        const pa = Math.max(0, Math.round((va - off) / cmPerPx))
        const pb = Math.min(N - 1, Math.round((vb - off) / cmPerPx) - 1)
        let on = 0
        for (let i = pa; i <= pb; i++) if (colOK(i)) on++
        if (pb < pa || on / (pb - pa + 1) < 0.6) continue
      }
      const covered = same.some(o => {
        const [lo, hi] = span(o, vertical)
        return Math.min(vb, hi) - Math.max(va, lo) > (vb - va) * 0.5
      })
      if (covered) continue
      const near = crossers.filter(({ cc }) => cc > a - 15 && cc < b + 15)
      const touchesSame = same.some(o => {
        const [lo, hi] = span(o, vertical)
        return Math.abs(va - hi) <= 4 || Math.abs(vb - lo) <= 4
      })
      if (!near.length && !touchesSame) continue
      // 코너 마감: 인접 직교 벽의 중심선까지 끝을 연장(일반 벽과 같은 규약)
      for (const { cc } of near) {
        if (cc >= vb && cc <= vb + t + 4) vb = cc
        if (cc <= va && cc >= va - t - 4) va = cc
      }
      if (vb - va < 8) continue
      added.push(vertical
        ? { from: { x: Math.round(c), z: Math.round(va) }, to: { x: Math.round(c), z: Math.round(vb) }, thickness: t }
        : { from: { x: Math.round(va), z: Math.round(c) }, to: { x: Math.round(vb), z: Math.round(c) }, thickness: t })
    }
  }
  walls.push(...added)
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
  for (const c of comps.values()) {
    // 코너 있는 성분 + '강한 벽 증거'(두께 18cm+ & 길이 200cm+) 성분은 유지.
    // 실전 도면은 새시·창 박스가 벽 끝을 갉아 코너 접점이 끊기는 일이 흔한데,
    // 치수선(얇음)·소파 이중선(t~10)·표제 텍스트는 이 기준에 못 미친다.
    const strong = c.idx.some(i => {
      const w2 = walls[i]
      const len = Math.abs(w2.to.x - w2.from.x) + Math.abs(w2.to.z - w2.from.z)
      return w2.thickness >= 18 && len >= 200
    })
    // 총 길이 400cm+ 성분도 유지: 실전 도면은 외벽 조각이 게이트에서 떨어지면 내벽 무리가
    // '코너 없는 고아'로 연쇄 사멸한다. 소파 이중선(~240)·여백 표제(~255)는 이 기준 미달.
    const totalLen = c.idx.reduce((s2, i) => {
      const w2 = walls[i]
      return s2 + Math.abs(w2.to.x - w2.from.x) + Math.abs(w2.to.z - w2.from.z)
    }, 0)
    if ((c.h && c.v) || strong || totalLen >= 400) kept.push(...c.idx)
  }
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
        // 면 일치: 벽 두께가 변해도(기둥 접합 등) 한쪽 면은 평평하게 이어지는 게 보통 —
        // 중심선이 어긋나도 어느 한 면이 맞으면 같은 벽의 연속으로 본다(실전 도면 조각화 대응)
        const edgeFlush =
          Math.abs((A.c - A.t / 2) - (B.c - B.t / 2)) <= 6 ||
          Math.abs((A.c + A.t / 2) - (B.c + B.t / 2)) <= 6
        const joinable = (Math.abs(A.c - B.c) <= 6 || edgeFlush) && -ov <= JOIN_GAP_CM &&
          (Math.abs(A.t - B.t) <= 10 || edgeFlush)
        const overlapping = Math.abs(A.c - B.c) < (A.t + B.t) / 2 &&
          ov >= 0.5 * Math.min(A.p2 - A.p1, B.p2 - B.p1)
        if (!joinable && !overlapping) continue
        const main = (A.p2 - A.p1) * A.t >= (B.p2 - B.p1) * B.t ? A : B
        A.p1 = Math.min(A.p1, B.p1)
        A.p2 = Math.max(A.p2, B.p2)
        A.c = main.c
        A.t = main.t
        list.splice(j, 1)
        changed = true
        break outer
      }
    }
  }
  return list
}

// 배경(테두리 픽셀 중앙값)과 다른 픽셀들의 bbox — 저해상 프리스캔으로 계산
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
  for (let x = 0; x < pw; x++) { border.push(lum(x), lum((ph - 1) * pw + x)) }
  for (let y = 0; y < ph; y++) { border.push(lum(y * pw), lum(y * pw + pw - 1)) }
  border.sort((a, b) => a - b)
  const bg = border[Math.floor(border.length / 2)]
  let x1 = pw, y1 = ph, x2 = -1, y2 = -1
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (Math.abs(lum(y * pw + x) - bg) > 28) {
        if (x < x1) x1 = x
        if (x > x2) x2 = x
        if (y < y1) y1 = y
        if (y > y2) y2 = y
      }
    }
  }
  if (x2 < 0 || (x2 - x1) < pw * 0.2 || (y2 - y1) < ph * 0.2) {
    return { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight } // 내용이 없거나 이상 → 크롭 안 함
  }
  // 여백이 클 때만 크롭한다. 크롭은 내용부 해상도를 바꿔 경계 위 띠들의 판정을 흔들 수 있어,
  // 본래 목적(여백 과다 도면의 히스토그램·해상도 구제)이 필요한 경우로 한정한다.
  const areaFrac = ((x2 - x1 + 1) * (y2 - y1 + 1)) / (pw * ph)
  if (areaFrac >= 0.55) {
    return { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }
  }
  const padX = Math.round((x2 - x1) * 0.02) + 1
  const padY = Math.round((y2 - y1) * 0.02) + 1
  const fx = v => Math.round(v / s)
  return {
    x: Math.max(0, fx(x1 - padX)),
    y: Math.max(0, fx(y1 - padY)),
    w: Math.min(img.naturalWidth, fx(x2 + padX)) - Math.max(0, fx(x1 - padX)),
    h: Math.min(img.naturalHeight, fx(y2 + padY)) - Math.max(0, fx(y1 - padY)),
  }
}

// 같은 선상 벽 조각 사이 '문 개구부' 폭 중앙값(cm). 엄격 필터: 양쪽 조각 100cm+ &
// 두께 유사(같은 벽의 연속) & 갭 40~200cm — 창 구간·미검출 틈 같은 잡갭을 배제한다.
function medianDoorGap(walls) {
  const isV = s => s.from.x === s.to.x
  const len = s => Math.abs(s.to.x - s.from.x) + Math.abs(s.to.z - s.from.z)
  const gaps = []
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const A = walls[i], B = walls[j]
      if (isV(A) !== isV(B)) continue
      if (len(A) < 100 || len(B) < 100) continue
      if (Math.abs(A.thickness - B.thickness) > 6) continue
      const cA = isV(A) ? A.from.x : A.from.z
      const cB = isV(B) ? B.from.x : B.from.z
      if (Math.abs(cA - cB) > 8) continue
      const a2 = isV(A) ? Math.max(A.from.z, A.to.z) : Math.max(A.from.x, A.to.x)
      const a1 = isV(A) ? Math.min(A.from.z, A.to.z) : Math.min(A.from.x, A.to.x)
      const b1 = isV(B) ? Math.min(B.from.z, B.to.z) : Math.min(B.from.x, B.to.x)
      const b2 = isV(B) ? Math.max(B.from.z, B.to.z) : Math.max(B.from.x, B.to.x)
      const gap = Math.max(a1, b1) - Math.min(a2, b2)
      if (gap > 40 && gap < 200) gaps.push(gap)
    }
  }
  if (gaps.length < 3) return null
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

// 실제 폭 자동 추정(파일명 힌트가 없을 때).
// 1) 시드 스캔: 각 시드에서 인식을 돌리고 '구조 정합' 점수 = (두꺼운 구조 커버리지 ×
//    두꺼운 구조 위 정밀도)로 채점한다. 과소 보정은 벽이 게이트에 걸려 커버리지가 죽고,
//    과대 보정은 글자·가구가 벽으로 둔갑해 정밀도가 죽어 — 정답 근처에서만 정점이 선다.
//    (벽 '개수'는 과대 보정 쪽으로 게임되므로 점수로 쓰지 않는다 — 실측으로 확인됨)
// 2) 문 갭 보정: 정점 시드에서 문 개구부 중앙값이 표준 문폭 85cm가 되도록 미세 역산(±35% 한도).
export async function autoCalibrateWidth(src) {
  const img = await loadImage(src)
  // 채점용 마스크(시드와 무관): detectWalls와 동일한 크롭·정규화·이진화
  const crop = findContentBox(img)
  const scale = MAX_SIDE / Math.max(crop.w, crop.h)
  const w = Math.max(1, Math.round(crop.w * scale))
  const h = Math.max(1, Math.round(crop.h * scale))
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h).data
  const lum = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
  const sorted = Float32Array.from(lum).sort()
  const lo = sorted[Math.floor(sorted.length * 0.05)]
  const hi = sorted[Math.floor(sorted.length * 0.95)]
  if (hi - lo < 30) return null
  const thr = (lo + hi) / 2
  let dark = 0
  for (let i = 0; i < lum.length; i++) if (lum[i] < thr) dark++
  const darkIsWall = dark <= lum.length / 2
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < lum.length; i++) {
    if ((lum[i] < thr) !== darkIsWall) continue
    const ch = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) - Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])
    if (ch <= MAX_CHROMA) mask[i] = 1
  }
  const thick = new Uint8Array(w * h)
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      if (!mask[y * w + x]) continue
      let c = 0
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) c += mask[(y + dy) * w + (x + dx)]
      if (c >= 22) thick[y * w + x] = 1
    }
  }
  let thickN = 0
  for (let i = 0; i < w * h; i++) thickN += thick[i]
  if (thickN < 500) return null

  const fullCmPerPx = wcm => wcm / img.naturalWidth
  const scoreWalls = (walls, wcm) => {
    const cmPerPx = (crop.w * fullCmPerPx(wcm)) / w
    const offX = crop.x * fullCmPerPx(wcm)
    const offZ = crop.y * fullCmPerPx(wcm)
    const det = new Uint8Array(w * h)
    for (const s of walls) {
      const vert = s.from.x === s.to.x
      const c = Math.round(((vert ? s.from.x : s.from.z) - (vert ? offX : offZ)) / cmPerPx)
      const ht = Math.max(1, Math.round(s.thickness / cmPerPx / 2))
      const a = Math.round((Math.min(vert ? s.from.z : s.from.x, vert ? s.to.z : s.to.x) - (vert ? offZ : offX)) / cmPerPx)
      const b = Math.round((Math.max(vert ? s.from.z : s.from.x, vert ? s.to.z : s.to.x) - (vert ? offZ : offX)) / cmPerPx)
      for (let i = Math.max(0, a); i <= Math.min((vert ? h : w) - 1, b); i++) {
        for (let L = Math.max(0, c - ht); L <= Math.min((vert ? w : h) - 1, c + ht); L++) {
          det[vert ? i * w + L : L * w + i] = 1
        }
      }
    }
    let detN = 0
    let cov = 0
    for (let i = 0; i < w * h; i++) {
      if (det[i]) { detN++; if (thick[i]) cov++ }
    }
    if (!detN) return 0
    return (cov / thickN) * (cov / detN) // 커버리지 × 정밀도
  }

  let best = null
  const tryWidth = async wcm => {
    const walls = await detectWalls(src, { x: 0, z: 0, widthCm: wcm })
    const s = walls.length >= 6 ? scoreWalls(walls, wcm) : 0
    if (!best || s > best.s) best = { wcm, s, walls }
  }
  for (const s of [700, 1100, 1700, 2600, 4000]) await tryWidth(s)
  if (!best || best.s === 0) return null
  // 정점이 이동하는 동안 근방을 반복 탐색(지역 정점 탈출, 최대 3라운드)
  const tried = new Set()
  for (let round = 0; round < 3; round++) {
    const center = best.wcm
    for (const f of [0.78, 1.28]) {
      const wcm = Math.round(center * f / 10) * 10
      if (!tried.has(wcm)) { tried.add(wcm); await tryWidth(wcm) }
    }
    if (best.wcm === center) break
  }
  const med = medianDoorGap(best.walls)
  let est = best.wcm
  if (med) est *= Math.max(0.65, Math.min(1.35, 85 / med))
  return Math.round(est / 10) * 10
}

// (하위호환) 이전 이름 유지
export function estimateWidthCm(walls, assumedWidthCm) {
  const med = medianDoorGap(walls)
  return med ? Math.round(assumedWidthCm * (85 / med) / 10) * 10 : null
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error('이미지를 읽을 수 없어요'))
    img.src = src
  })
}
