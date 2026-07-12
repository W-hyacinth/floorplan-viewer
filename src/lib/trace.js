// 밑그림 이미지에서 축 정렬 벽 자동 추출.
// 접근: 휘도 이진화(배경 대비 어두운 픽셀=벽, 청사진류는 극성 반전) →
// 가로/세로로 긴 런(run)의 띠(band)를 벽 사각형으로 묶고 → 근접 띠 병합(창 이중선 등) →
// 두께·비율 필터로 글자·가구 선을 걸러 벽 세그먼트로 변환.
// 사선·곡선 벽은 다루지 않는다. cm 문턱값들은 밑그림의 '실제 폭(cm)' 보정에 의존한다.

const MAX_SIDE = 1200      // 처리 해상도 상한(px)
const MIN_LEN_CM = 100     // 이보다 짧은 띠는 벽으로 안 봄(글자 획·가구 선 배제)
const MIN_T_CM = 6         // 벽 두께 하한(가구 외곽선 2~5cm 배제)
const MAX_T_CM = 45        // 벽 두께 상한(색면·가구 채움 배제)
const MERGE_GAP_CM = 12    // 같은 줄에서 이 이하 끊김은 노이즈로 이음(문 개구부 80cm+는 유지)
const FUSE_DIST_CM = 10    // 나란한 얇은 띠(창 이중선 등)를 하나로 합칠 간격

export async function detectWalls(src, underlay) {
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
  for (let i = 0; i < lum.length; i++) mask[i] = (lum[i] < thr) === darkIsWall ? 1 : 0

  const minLen = Math.max(3, Math.round(MIN_LEN_CM / cmPerPx))
  const mergeGap = Math.max(1, Math.round(MERGE_GAP_CM / cmPerPx))
  const fuseDist = Math.max(1, Math.round(FUSE_DIST_CM / cmPerPx))

  const walls = []
  for (const vertical of [false, true]) {
    let bands = extractBands(mask, w, h, minLen, mergeGap, vertical)
    bands = fuseBands(bands, fuseDist)
    for (const bd of bands) {
      const tCm = (bd.end - bd.start + 1) * cmPerPx
      const lenCm = (bd.b - bd.a + 1) * cmPerPx
      if (tCm < MIN_T_CM || tCm > MAX_T_CM) continue
      if (lenCm < MIN_LEN_CM || lenCm / tCm < 2.5) continue
      // 짧고 두꺼운 후보는 방 이름 글자 블롭일 수 있다 — 진짜 벽은 속이 꽉 차 있음
      if (lenCm / tCm < 8 && fillRatio(mask, w, bd, vertical) < 0.8) continue
      const c = (bd.start + bd.end + 1) / 2 * cmPerPx
      const p1 = bd.a * cmPerPx
      const p2 = (bd.b + 1) * cmPerPx
      const th = Math.round(tCm)
      walls.push(vertical
        ? { from: { x: r(underlay.x + c), z: r(underlay.z + p1) }, to: { x: r(underlay.x + c), z: r(underlay.z + p2) }, thickness: th }
        : { from: { x: r(underlay.x + p1), z: r(underlay.z + c) }, to: { x: r(underlay.x + p2), z: r(underlay.z + c) }, thickness: th })
    }
  }
  return walls
}

const r = v => Math.round(v)

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

// 나란히 붙어 있는 띠(창의 2~3중 가는 선, 손그림 이중선)를 하나의 벽으로 융합
function fuseBands(bands, fuseDist) {
  const sorted = [...bands].sort((p, q) => p.start - q.start)
  const out = []
  for (const bd of sorted) {
    const prev = out.find(o =>
      bd.start - o.end - 1 <= fuseDist &&
      Math.min(bd.b, o.b) - Math.max(bd.a, o.a) + 1 >= 0.8 * Math.min(bd.b - bd.a + 1, o.b - o.a + 1))
    if (prev) {
      prev.a = Math.min(prev.a, bd.a)
      prev.b = Math.max(prev.b, bd.b)
      prev.end = Math.max(prev.end, bd.end)
    } else {
      out.push({ ...bd })
    }
  }
  return out
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error('이미지를 읽을 수 없어요'))
    img.src = src
  })
}
