import { useEffect, useMemo, useRef, useState } from 'react'
import { buildColliders, obbOverlapsObb, obbIntersectsSegment } from '../lib/collision.js'
import { CM, deg } from '../lib/units.js'
import { detectEnclosedArea } from '../lib/area.js'
import { zonePoints, zoneCentroid } from '../lib/zone.js'
import { detectWalls } from '../lib/trace.js'

// 2D 탑뷰 도면 에디터. 도면 좌표(cm, +z=아래)가 SVG 좌표와 1:1 — 변환 없음.
const SNAP = 5 // cm

export function Editor2D({ buildingName, levels, activeLevel, levelsApi, scene, items, catalog, catalogApi, itemsApi, sceneApi, onEnter3D, onEnterPreview, onExport, onImport }) {
  const [tool, setTool] = useState('select') // 'select' | 'wall' | 'zone'
  const [selected, setSelected] = useState(null) // { kind: 'item'|'zone'|'wall', id }
  const [cursor, setCursor] = useState(null)     // 도면 좌표 (벽/구역 미리보기용)
  const [wallStart, setWallStart] = useState(null)
  const [zoneStart, setZoneStart] = useState(null)
  const [zoneMsg, setZoneMsg] = useState(null)
  const [importErr, setImportErr] = useState(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmLevelDel, setConfirmLevelDel] = useState(false)
  const [tracing, setTracing] = useState(false)
  const [confirmTrace, setConfirmTrace] = useState(false)
  const [traceInfo, setTraceInfo] = useState(null)
  const [pendingUnderlay, setPendingUnderlay] = useState(null) // 배치가 있는 층에 새 밑그림 → 경고 후 진행
  const svgRef = useRef(null)
  const fileRef = useRef(null)
  const imgRef = useRef(null)
  const dragRef = useRef(null) // { kind:'item'|'zone'|'spawn'|'pan', ... }
  const [view, setView] = useState(null) // null = 도면 전체 맞춤 / 값 = 줌·팬된 viewBox
  const viewRef = useRef(null)           // 휠 연타 시 렌더 지연 없이 최신 뷰 참조
  const spaceRef = useRef(false)

  const bounds = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    const eat = (x, z) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
    }
    for (const w of scene.walls ?? []) { eat(w.from.x, w.from.z); eat(w.to.x, w.to.z) }
    const u = scene.underlay
    if (u) { eat(u.x, u.z); eat(u.x + u.widthCm, u.z + u.heightCm) }
    if (!isFinite(minX)) { minX = 0; maxX = 1000; minZ = 0; maxZ = 1000 }
    return { minX, maxX, minZ, maxZ }
  }, [scene])
  const M = 100
  const fitBox = {
    x: bounds.minX - M, y: bounds.minZ - M,
    w: bounds.maxX - bounds.minX + 2 * M, h: bounds.maxZ - bounds.minZ + 2 * M,
  }
  const fitRef = useRef(fitBox)
  fitRef.current = fitBox
  const vb = view ?? fitBox
  const viewBox = `${vb.x} ${vb.y} ${vb.w} ${vb.h}`
  const zoomPct = Math.round((fitBox.w / vb.w) * 100)

  const applyView = nv => { viewRef.current = nv; setView(nv) }
  // k > 1 = 축소, k < 1 = 확대. 앵커(도면 좌표) 고정 줌
  const zoomAt = (px, py, k) => {
    const v = viewRef.current ?? fitRef.current
    const w = Math.min(Math.max(v.w * k, 150), fitRef.current.w * 4)
    const kk = w / v.w
    applyView({ x: px - (px - v.x) * kk, y: py - (py - v.y) * kk, w, h: v.h * kk })
  }
  const zoomStep = k => {
    const v = viewRef.current ?? fitRef.current
    zoomAt(v.x + v.w / 2, v.y + v.h / 2, k)
  }
  const resetView = () => { viewRef.current = null; setView(null) }
  // 배율 직접 입력: pct% → viewBox 폭 = fit폭 × 100/pct (뷰 중앙 앵커, zoomAt이 클램프)
  const [pctEdit, setPctEdit] = useState(null) // null = 표시 모드, 문자열 = 편집 중
  const pctCancelRef = useRef(false)
  const setZoomTo = pct => {
    const v = viewRef.current ?? fitRef.current
    zoomAt(v.x + v.w / 2, v.y + v.h / 2, (fitRef.current.w * 100 / pct) / v.w)
  }

  // 휠 줌(커서 기준) — preventDefault가 필요해 native non-passive로 부착
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = e => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const v = viewRef.current ?? fitRef.current
      const s = Math.min(rect.width / v.w, rect.height / v.h)
      const px = v.x + (e.clientX - rect.left - (rect.width - v.w * s) / 2) / s
      const py = v.y + (e.clientY - rect.top - (rect.height - v.h * s) / 2) / s
      zoomAt(px, py, Math.pow(1.0015, e.deltaY))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 벽 콜라이더(가구 제외) — 겹침 경고용, 3D와 동일 판정
  const wallSegs = useMemo(
    () => buildColliders({ ...scene, items: [], zones: [] }, catalog).segments,
    [scene, catalog],
  )

  const invalidIds = useMemo(() => {
    const obbs = items
      .map(it => {
        const c = catalog.items[it.catalogId]
        if (!c) return null
        return {
          id: it.id,
          cx: it.position.x * CM, cz: it.position.z * CM,
          hw: (c.size.w / 2) * CM, hd: (c.size.d / 2) * CM,
          rotY: deg(it.rotationY ?? 0),
        }
      })
      .filter(Boolean)
    const bad = new Set()
    for (let i = 0; i < obbs.length; i++) {
      for (const s of wallSegs)
        if (obbIntersectsSegment(obbs[i], s.ax, s.az, s.bx, s.bz, s.pad)) { bad.add(obbs[i].id); break }
      for (let j = i + 1; j < obbs.length; j++)
        if (obbOverlapsObb(obbs[i], obbs[j])) { bad.add(obbs[i].id); bad.add(obbs[j].id) }
    }
    return bad
  }, [items, catalog, wallSegs])

  const toPlan = e => {
    const svg = svgRef.current
    const pt = svg.createSVGPoint()
    pt.x = e.clientX; pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM().inverse())
    return { x: p.x, z: p.y }
  }
  const snap = v => Math.round(v / SNAP) * SNAP
  // 휠클릭 또는 Space 홀드 = 팬 — 개체 핸들러는 양보하고 svg까지 버블시킨다
  const isPan = e => e.button === 1 || spaceRef.current

  // ---- 포인터 ----
  const onItemDown = (e, it) => {
    if (isPan(e)) return
    if (tool !== 'select') return
    e.stopPropagation()
    setSelected({ kind: 'item', id: it.id })
    const p = toPlan(e)
    dragRef.current = { kind: 'item', id: it.id, dx: it.position.x - p.x, dz: it.position.z - p.z }
    capture(e)
  }
  const onZoneDown = (e, zn) => {
    if (isPan(e)) return
    if (tool !== 'select') return
    e.stopPropagation()
    setSelected({ kind: 'zone', id: zn.id })
    const p = toPlan(e)
    if (zn.points) {
      dragRef.current = { kind: 'zonepoly', id: zn.id, start: p, orig: zn.points }
    } else {
      dragRef.current = { kind: 'zone', id: zn.id, dx: zn.x - p.x, dz: zn.z - p.z }
    }
    capture(e)
  }
  const onVertexDown = (e, zn, idx) => {
    if (isPan(e)) return
    e.stopPropagation()
    dragRef.current = { kind: 'zonevert', id: zn.id, idx }
    capture(e)
  }
  // 변 중간점 핸들 드래그 = 그 자리에 꼭짓점 삽입 후 바로 이동
  const onMidDown = (e, zn, idx) => {
    if (isPan(e)) return
    e.stopPropagation()
    const p = toPlan(e)
    const pts = [...zn.points]
    pts.splice(idx + 1, 0, { x: snap(p.x), z: snap(p.z) })
    sceneApi.updateZone(zn.id, { points: pts })
    dragRef.current = { kind: 'zonevert', id: zn.id, idx: idx + 1 }
    capture(e)
  }
  const removeVertex = (zn, idx) => {
    if (zn.points.length <= 3) return
    sceneApi.updateZone(zn.id, { points: zn.points.filter((_, i) => i !== idx) })
  }
  const onWallDown = (e, idx) => {
    if (isPan(e)) return
    if (tool !== 'select') return
    e.stopPropagation()
    setSelected({ kind: 'wall', id: idx })
  }
  const onSpawnDown = e => {
    if (isPan(e)) return
    if (tool !== 'select') return
    e.stopPropagation()
    dragRef.current = { kind: 'spawn' }
    capture(e)
  }
  const capture = e => {
    try { svgRef.current.setPointerCapture(e.pointerId) } catch { /* 합성 이벤트는 캡처 불가 */ }
  }

  const onSvgDown = e => {
    if (isPan(e)) {
      e.preventDefault()
      dragRef.current = { kind: 'pan', cx: e.clientX, cy: e.clientY, v: viewRef.current ?? fitRef.current }
      capture(e)
      return
    }
    const p = toPlan(e)
    if (tool === 'wall') {
      const pt = { x: snap(p.x), z: snap(p.z) }
      if (!wallStart) setWallStart(pt)
      else if (pt.x !== wallStart.x || pt.z !== wallStart.z) {
        sceneApi.addWall({ from: wallStart, to: pt, thickness: 12 })
        setWallStart(pt) // 연속 그리기
      }
      return
    }
    if (tool === 'zone') {
      setZoneStart({ x: snap(p.x), z: snap(p.z) })
      capture(e)
      return
    }
    setSelected(null)
  }
  const onSvgMove = e => {
    if (dragRef.current?.kind === 'pan') {
      const d = dragRef.current
      const rect = svgRef.current.getBoundingClientRect()
      const s = Math.min(rect.width / d.v.w, rect.height / d.v.h)
      applyView({ x: d.v.x - (e.clientX - d.cx) / s, y: d.v.y - (e.clientY - d.cy) / s, w: d.v.w, h: d.v.h })
      return
    }
    const p = toPlan(e)
    if (tool !== 'select' || zoneStart) setCursor(p)
    const d = dragRef.current
    if (!d) return
    if (d.kind === 'item') itemsApi.update(d.id, { position: { x: snap(p.x + d.dx), z: snap(p.z + d.dz) } })
    else if (d.kind === 'zone') sceneApi.updateZone(d.id, { x: snap(p.x + d.dx), z: snap(p.z + d.dz) })
    else if (d.kind === 'zonepoly') {
      const dx = snap(p.x - d.start.x), dz = snap(p.z - d.start.z)
      sceneApi.updateZone(d.id, { points: d.orig.map(q => ({ x: q.x + dx, z: q.z + dz })) })
    }
    else if (d.kind === 'zonevert') {
      const zn = (scene.zones ?? []).find(z => z.id === d.id)
      if (zn?.points) {
        sceneApi.updateZone(d.id, {
          points: zn.points.map((q, i) => (i === d.idx ? { x: snap(p.x), z: snap(p.z) } : q)),
        })
      }
    }
    else if (d.kind === 'spawn') sceneApi.setSpawn({ ...(scene.spawn ?? { yawDeg: 0 }), x: snap(p.x), z: snap(p.z) })
  }
  const onSvgUp = e => {
    dragRef.current = null
    if (tool === 'zone' && zoneStart) {
      const p = toPlan(e)
      const moved = Math.hypot(p.x - zoneStart.x, p.z - zoneStart.z)
      if (moved < 10) {
        // 클릭 = 벽으로 닫힌 영역 자동 감지 → 다각형 구역
        const points = detectEnclosedArea(scene, zoneStart.x, zoneStart.z)
        if (points) {
          const id = `zone-${Date.now().toString(36)}`
          sceneApi.addZone({ id, points })
          setSelected({ kind: 'zone', id })
          setTool('select')
          setZoneMsg(null)
        } else {
          setZoneMsg('닫힌 영역이 아니에요 — 벽으로 둘러싸인 곳을 클릭하거나, 드래그로 직접 지정하세요')
          setTimeout(() => setZoneMsg(null), 4000)
        }
      } else {
        const x1 = snap(Math.min(zoneStart.x, p.x)), x2 = snap(Math.max(zoneStart.x, p.x))
        const z1 = snap(Math.min(zoneStart.z, p.z)), z2 = snap(Math.max(zoneStart.z, p.z))
        if (x2 - x1 >= 30 && z2 - z1 >= 30) {
          const id = `zone-${Date.now().toString(36)}`
          sceneApi.addZone({ id, x: x1, z: z1, w: x2 - x1, d: z2 - z1 })
          setSelected({ kind: 'zone', id })
          setTool('select')
        }
      }
      setZoneStart(null)
    }
  }

  // ---- 선택 대상 조작 ----
  const rotateSelected = () => {
    if (selected?.kind !== 'item') return
    const it = items.find(i => i.id === selected.id)
    if (it) itemsApi.update(it.id, { rotationY: ((it.rotationY ?? 0) + 90) % 360 })
  }
  const deleteSelected = () => {
    if (!selected) return
    if (selected.kind === 'item') itemsApi.remove(selected.id)
    else if (selected.kind === 'zone') sceneApi.removeZone(selected.id)
    else if (selected.kind === 'wall') sceneApi.removeWall(selected.id)
    setSelected(null)
  }

  useEffect(() => {
    const onKey = e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.code === 'KeyR') rotateSelected()
      if (e.code === 'Delete' || e.code === 'Backspace') deleteSelected()
      if (e.code === 'Escape') {
        setWallStart(null); setZoneStart(null); setTool('select'); setSelected(null)
      }
      if (e.code === 'Space') { spaceRef.current = true; e.preventDefault() }
    }
    const onKeyUp = e => { if (e.code === 'Space') spaceRef.current = false }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  })

  const addItem = cid => {
    const id = `n-${Date.now().toString(36)}`
    itemsApi.add({
      id,
      catalogId: cid,
      position: {
        x: snap((bounds.minX + bounds.maxX) / 2),
        z: snap((bounds.minZ + bounds.maxZ) / 2),
      },
      rotationY: 0,
    })
    setSelected({ kind: 'item', id })
    setTool('select')
  }

  const loadUnderlay = file => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        // 파일명에 실제 폭 단서가 있으면 자동 보정 (예: "사무실_폭1200cm.png", "plan-1500cm.png", "w1240")
        const m = file.name.match(/폭\s*(\d{3,5})\s*cm/) ||
          file.name.match(/(\d{3,5})\s*cm/) ||
          file.name.match(/[wW](\d{3,5})/)
        const hinted = m ? Number(m[1]) : 0
        const widthCm = hinted >= 100 && hinted <= 10000 ? hinted : 1000 // 기본 10m — 아래 입력으로 보정
        sceneApi.setUnderlay({
          src: reader.result,
          x: 0, z: 0,
          widthCm,
          heightCm: Math.round(widthCm * (img.naturalHeight / img.naturalWidth)),
          ratio: img.naturalHeight / img.naturalWidth,
          opacity: 0.5,
          visible: true,
        })
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  }

  // 밑그림에서 벽 자동 인식 — 기존 벽이 있으면 2클릭 확인 후 전체 교체
  const runTrace = async () => {
    if (tracing || !scene.underlay) return
    if ((scene.walls?.length ?? 0) > 0 && !confirmTrace) {
      setConfirmTrace(true)
      setTimeout(() => setConfirmTrace(false), 2500)
      return
    }
    setConfirmTrace(false)
    setTracing(true)
    setTraceInfo(null)
    try {
      const walls = await detectWalls(scene.underlay.src, scene.underlay)
      if (!walls.length) {
        setTraceInfo('벽을 찾지 못했어요 — 실제 폭(cm) 보정과 도면 대비를 확인하세요')
      } else {
        sceneApi.setWalls(walls)
        setSelected(null)
        setTraceInfo(walls.length < 8
          ? `벽 ${walls.length}개 인식 — 벽이 적게 잡히면 실제 폭(cm) 보정이 정확한지 먼저 확인하세요 (보정이 작으면 얇은 내벽이 걸러집니다)`
          : `벽 ${walls.length}개 인식 — 잘못 잡힌 벽은 클릭해서 삭제하세요`)
      }
    } catch (err) {
      setTraceInfo(`인식 실패: ${err.message}`)
    }
    setTracing(false)
  }

  const selectedItem = selected?.kind === 'item' ? items.find(i => i.id === selected.id) : null
  const selectedItemCat = selectedItem ? catalog.items[selectedItem.catalogId] : null
  const underlay = scene.underlay

  const activeLv = levels[activeLevel]

  return (
    <div className="editor">
      <div className="editor-top">
        <b>2D 도면 · {buildingName}</b>
        <div className="toolbar">
          <button className={tool === 'select' ? 'tool on' : 'tool'} onClick={() => setTool('select')}>선택</button>
          <button className={tool === 'wall' ? 'tool on' : 'tool'} onClick={() => { setTool('wall'); setSelected(null) }}>벽 그리기</button>
          <button className={tool === 'zone' ? 'tool on' : 'tool'} onClick={() => { setTool('zone'); setSelected(null) }}>🚫 금지구역</button>
        </div>
        <span className="hint">
          {tool === 'wall' ? '클릭-클릭으로 벽 연속 그리기 · ESC 끝내기'
            : tool === 'zone' ? (zoneMsg ?? '클릭 = 닫힌 영역 자동 감지(다각형) · 드래그 = 사각형 지정')
            : '드래그 이동 · R 회전 · Delete 삭제 · 휠 줌 · Space/휠클릭 드래그 팬 · 빨강 = 겹침'}
          {importErr && <em className="import-err"> — 불러오기 실패: {importErr}</em>}
        </span>
        <div className="editor-actions">
          <input
            ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
            onChange={async e => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              const err = await onImport(f)
              setImportErr(err)
              if (!err) setSelected(null)
            }}
          />
          <input
            ref={imgRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              const hasContent = (scene.walls?.length ?? 0) + items.length + (scene.zones?.length ?? 0) > 0
              if (hasContent) setPendingUnderlay(f)
              else loadUnderlay(f)
            }}
          />
          <button className="ghostbtn" onClick={() => imgRef.current?.click()}>도면 이미지</button>
          <button className="ghostbtn" onClick={() => fileRef.current?.click()}>JSON 불러오기</button>
          <button className="ghostbtn" onClick={onExport}>JSON 내보내기</button>
          <button
            className={confirmReset ? 'ghostbtn danger' : 'ghostbtn'}
            onClick={() => {
              if (confirmReset) { sceneApi.reset(); setSelected(null); setConfirmReset(false) }
              else { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 2500) }
            }}
          >
            {confirmReset ? '정말 초기화?' : '새 도면'}
          </button>
          <button className="primary" onClick={onEnter3D}>▶ 3D로 체험 (Tab)</button>
          <button className="primary customer" title="비공개 층을 숨긴, 실제 고객 화면 그대로의 미리보기" onClick={onEnterPreview}>👁 고객 체험</button>
        </div>
      </div>

      {/* 층 탭: 어드민은 전 층을 보고 편집하지만, 🔒 층은 고객 3D 투어에서 존재 자체가 숨겨진다 */}
      <div className="editor-levels">
        {levels.map((lv, i) => (
          <button
            key={lv.id}
            className={i === activeLevel ? 'lvtab on' : 'lvtab'}
            onClick={() => { levelsApi.setActive(i); setSelected(null); setWallStart(null); setZoneStart(null) }}
          >
            {lv.restricted ? '🔒 ' : ''}{lv.name}
          </button>
        ))}
        <button className="lvtab lvadd" onClick={levelsApi.add}>+ 층 추가</button>
        <span className="lv-spacer" />
        <label className="lv-restrict" title="켜면 고객용 3D 투어에서 이 층이 목록에서 사라집니다">
          <input
            type="checkbox"
            checked={!!activeLv?.restricted}
            onChange={() => levelsApi.toggleRestricted(activeLevel)}
          />
          이 층 고객 비공개
        </label>
        {levels.length > 1 && (
          <button
            className={confirmLevelDel ? 'lvtab lvdanger' : 'lvtab'}
            onClick={() => {
              if (confirmLevelDel) { levelsApi.remove(activeLevel); setSelected(null); setConfirmLevelDel(false) }
              else { setConfirmLevelDel(true); setTimeout(() => setConfirmLevelDel(false), 2500) }
            }}
          >
            {confirmLevelDel ? '정말 삭제?' : '층 삭제'}
          </button>
        )}
      </div>

      <div className="editor-body">
        <div className="editor-side">
          <div className="side-title">가구 카탈로그</div>
          <div className="side-grid">
            {Object.entries(catalog.items).map(([cid, c]) => {
              const isCustom = catalogApi?.customIds.has(cid)
              return (
                <div key={cid} className="palette-wrap">
                  <button className="palette-card" onClick={() => addItem(cid)}>
                    <span className="swatch" style={{ background: c.color }} />
                    <span className="cardname">{isCustom ? `★ ${c.name}` : c.name}</span>
                    <small>{c.size.w}×{c.size.d}</small>
                  </button>
                  {isCustom && (
                    <button className="card-x" title="타입 삭제(배치된 것 포함)" onClick={() => catalogApi.removeCustom(cid)}>×</button>
                  )}
                </div>
              )
            })}
          </div>
          <CustomItemForm onAdd={def => { const id = catalogApi.addCustom(def); return id }} onPlaced={addItem} />
          {underlay && (
            <div className="side-underlay">
              <div className="side-title">도면 밑그림</div>
              <label>
                실제 폭(cm)
                <input
                  type="number" value={underlay.widthCm} min="100" step="10"
                  onChange={e => {
                    const w = Number(e.target.value) || underlay.widthCm
                    sceneApi.setUnderlay({ ...underlay, widthCm: w, heightCm: Math.round(w * underlay.ratio) })
                  }}
                />
              </label>
              <div className="sel-row">
                <button onClick={() => sceneApi.setUnderlay({ ...underlay, visible: !underlay.visible })}>
                  {underlay.visible ? '숨기기' : '보이기'}
                </button>
                <button className="danger" onClick={() => sceneApi.setUnderlay(null)}>제거</button>
              </div>
              <div className="sel-row">
                <button
                  className={confirmTrace ? 'danger' : ''}
                  disabled={tracing}
                  title="밑그림의 어두운 선을 벽으로 자동 추출합니다 — 실제 폭(cm)을 먼저 맞춘 뒤 실행하세요"
                  onClick={runTrace}
                >
                  {tracing ? '인식 중…' : confirmTrace ? `기존 벽 ${scene.walls?.length ?? 0}개 교체?` : '🧱 벽 자동 인식'}
                </button>
              </div>
              {traceInfo && <small className="trace-info">{traceInfo}</small>}
            </div>
          )}
          <div className="side-sel">
            {selectedItem && selectedItemCat ? (
              <>
                <div className="sel-name">{selectedItemCat.name} <small>({selectedItem.id})</small></div>
                <div className="sel-row">
                  <button onClick={rotateSelected}>R 회전</button>
                  <button className="danger" onClick={deleteSelected}>삭제</button>
                </div>
              </>
            ) : selected?.kind === 'zone' ? (
              <>
                <div className="sel-name">🚫 출입금지 구역</div>
                {(() => {
                  const zn = (scene.zones ?? []).find(z => z.id === selected.id)
                  if (zn?.points) {
                    return <small>꼭짓점 드래그 = 이동 · 변 중간점 드래그 = 꼭짓점 추가 · 꼭짓점 더블클릭 = 삭제</small>
                  }
                  return (
                    <div className="sel-row" style={{ marginBottom: 8 }}>
                      <button onClick={() => sceneApi.updateZone(zn.id, { points: zonePoints(zn) })}>다각형으로 변환</button>
                    </div>
                  )
                })()}
                <div className="sel-row"><button className="danger" onClick={deleteSelected}>삭제</button></div>
              </>
            ) : selected?.kind === 'wall' ? (
              <>
                <div className="sel-name">벽 #{selected.id + 1}</div>
                <div className="sel-row"><button className="danger" onClick={deleteSelected}>삭제</button></div>
              </>
            ) : (
              <small>가구·벽·구역 클릭 = 선택 · 시작 마커도 드래그 가능</small>
            )}
          </div>
        </div>

        <div className="editor-main">
          {pendingUnderlay && (
            <div className="underlay-confirm">
              <b>새 밑그림 불러오기</b>
              <p>
                이 층에는 벽 {scene.walls?.length ?? 0} · 가구 {items.length} · 구역 {(scene.zones ?? []).length}개가 있어요.
                새 도면 기반으로 다시 시작하면 기존 배치는 사라집니다.
              </p>
              <div className="row">
                <button
                  className="primary"
                  onClick={() => {
                    sceneApi.clearLevel()
                    setSelected(null); setWallStart(null); setZoneStart(null); setTraceInfo(null)
                    resetView()
                    loadUnderlay(pendingUnderlay)
                    setPendingUnderlay(null)
                  }}
                >초기화 후 불러오기</button>
                <button onClick={() => { loadUnderlay(pendingUnderlay); setPendingUnderlay(null) }}>배치 유지, 밑그림만 교체</button>
                <button onClick={() => setPendingUnderlay(null)}>취소</button>
              </div>
            </div>
          )}
          <div className="zoom-ctl">
            <button onClick={() => zoomStep(1 / 1.3)} title="확대 (휠 위)">＋</button>
            <input
              className="pct"
              type="text" inputMode="numeric"
              value={pctEdit ?? String(zoomPct)}
              title="배율 직접 입력 · Enter 적용 · ESC 취소"
              onFocus={e => { setPctEdit(String(zoomPct)); e.target.select() }}
              onChange={e => setPctEdit(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={() => {
                if (!pctCancelRef.current) {
                  const n = Number(pctEdit)
                  if (n > 0) setZoomTo(n)
                }
                pctCancelRef.current = false
                setPctEdit(null)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') { pctCancelRef.current = true; e.currentTarget.blur() }
              }}
            />
            <span className="unit">%</span>
            <button onClick={() => zoomStep(1.3)} title="축소 (휠 아래)">－</button>
            <button className="fit" onClick={resetView} disabled={!view} title="도면 전체가 보이게 되돌리기">전체</button>
          </div>
          <svg
            ref={svgRef}
            viewBox={viewBox}
            onPointerMove={onSvgMove}
            onPointerUp={onSvgUp}
            onPointerDown={onSvgDown}
          >
            <defs>
              <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
                <path d="M50 0H0V50" fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="1" />
              </pattern>
              <pattern id="hatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="14" height="14" fill="rgba(214,69,69,0.12)" />
                <line x1="0" y1="0" x2="0" y2="14" stroke="rgba(214,69,69,0.55)" strokeWidth="4" />
              </pattern>
            </defs>

            {underlay?.visible && (
              <image
                href={underlay.src}
                x={underlay.x} y={underlay.z}
                width={underlay.widthCm} height={underlay.heightCm}
                opacity={underlay.opacity}
                preserveAspectRatio="none"
                pointerEvents="none"
              />
            )}

            {(scene.floors ?? []).map((f, i) => (
              <g key={i} pointerEvents="none">
                <rect x={f.x} y={f.z} width={f.w} height={f.d} fill="#d9c8a8" opacity={underlay?.visible ? 0.35 : 1} />
                <rect x={f.x} y={f.z} width={f.w} height={f.d} fill="url(#grid)" />
              </g>
            ))}

            {(scene.walls ?? []).map((w, i) => (
              <WallPlan key={i} wall={w} selected={selected?.kind === 'wall' && selected.id === i} onDown={e => onWallDown(e, i)} />
            ))}

            {/* 출입금지 구역 (사각형·다각형 공용 — 다각형은 선택 시 꼭짓점 편집) */}
            {(scene.zones ?? []).map(zn => {
              const pts = zonePoints(zn)
              const sel = selected?.kind === 'zone' && selected.id === zn.id
              const c = zoneCentroid(zn)
              return (
                <g key={zn.id} onPointerDown={e => onZoneDown(e, zn)} style={{ cursor: tool === 'select' ? 'grab' : 'default' }}>
                  <polygon
                    points={pts.map(q => `${q.x},${q.z}`).join(' ')}
                    fill="url(#hatch)"
                    stroke={sel ? '#2f6fed' : '#d64545'}
                    strokeWidth={sel ? 5 : 3}
                  />
                  <text x={c.x} y={c.z + 5} textAnchor="middle" fontSize="15" fill="#d64545" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                    출입금지
                  </text>
                  {sel && zn.points && pts.map((q, i) => {
                    const n = pts[(i + 1) % pts.length]
                    return (
                      <circle
                        key={`m${i}`}
                        cx={(q.x + n.x) / 2} cy={(q.z + n.z) / 2} r="8"
                        fill="rgba(47,111,237,0.45)" stroke="#fff" strokeWidth="2"
                        onPointerDown={e => onMidDown(e, zn, i)}
                        style={{ cursor: 'copy' }}
                      />
                    )
                  })}
                  {sel && zn.points && pts.map((q, i) => (
                    <circle
                      key={`v${i}`}
                      cx={q.x} cy={q.z} r="10"
                      fill="#fff" stroke="#2f6fed" strokeWidth="3"
                      onPointerDown={e => onVertexDown(e, zn, i)}
                      onDoubleClick={e => { e.stopPropagation(); removeVertex(zn, i) }}
                      style={{ cursor: 'move' }}
                    />
                  ))}
                </g>
              )
            })}

            {items.map(it => {
              const c = catalog.items[it.catalogId]
              if (!c) return null
              const bad = invalidIds.has(it.id)
              const sel = selected?.kind === 'item' && selected.id === it.id
              return (
                <g
                  key={it.id}
                  data-id={it.id}
                  transform={`translate(${it.position.x} ${it.position.z}) rotate(${-(it.rotationY ?? 0)})`}
                  onPointerDown={e => onItemDown(e, it)}
                  style={{ cursor: tool === 'select' ? 'grab' : 'default' }}
                >
                  <rect
                    x={-c.size.w / 2} y={-c.size.d / 2}
                    width={c.size.w} height={c.size.d}
                    rx="4"
                    fill={c.color}
                    stroke={bad ? '#d64545' : sel ? '#2f6fed' : 'rgba(0,0,0,0.35)'}
                    strokeWidth={bad || sel ? 5 : 1.5}
                  />
                  <line
                    x1={-c.size.w * 0.3} y1={-c.size.d / 2 - 5}
                    x2={c.size.w * 0.3} y2={-c.size.d / 2 - 5}
                    stroke="#2c2c30" strokeWidth="5" strokeLinecap="round"
                  />
                  <text y="5" textAnchor="middle" fontSize="14" fill="rgba(0,0,0,0.65)" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                    {c.name}
                  </text>
                </g>
              )
            })}

            {/* 그리기 미리보기 */}
            {tool === 'wall' && wallStart && cursor && (
              <line x1={wallStart.x} y1={wallStart.z} x2={snap(cursor.x)} y2={snap(cursor.z)} stroke="#2f6fed" strokeWidth="12" opacity="0.6" />
            )}
            {tool === 'zone' && zoneStart && cursor && (
              <rect
                x={Math.min(zoneStart.x, cursor.x)} y={Math.min(zoneStart.z, cursor.z)}
                width={Math.abs(cursor.x - zoneStart.x)} height={Math.abs(cursor.z - zoneStart.z)}
                fill="url(#hatch)" stroke="#d64545" strokeWidth="3" strokeDasharray="10 6"
              />
            )}

            {/* 스폰 지점 (드래그 가능) */}
            {scene.spawn && (
              <g
                transform={`translate(${scene.spawn.x} ${scene.spawn.z})`}
                onPointerDown={onSpawnDown}
                style={{ cursor: tool === 'select' ? 'grab' : 'default' }}
              >
                <circle r="16" fill="rgba(47,111,237,0.25)" stroke="#2f6fed" strokeWidth="2" />
                <text y="5" textAnchor="middle" fontSize="12" fill="#2f6fed" style={{ pointerEvents: 'none', userSelect: 'none' }}>시작</text>
              </g>
            )}
          </svg>
        </div>
      </div>
    </div>
  )
}

// 커스텀 가구 타입 생성 폼 (이름·크기·색·앉기)
function CustomItemForm({ onAdd, onPlaced }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [w, setW] = useState(60)
  const [d, setD] = useState(60)
  const [h, setH] = useState(90)
  const [color, setColor] = useState('#a08a6f')
  const [sit, setSit] = useState(false)
  const [sitH, setSitH] = useState(45)

  if (!open) {
    return <button className="ghostbtn add-custom" onClick={() => setOpen(true)}>+ 커스텀 가구 만들기</button>
  }
  return (
    <div className="custom-form">
      <div className="side-title">커스텀 가구</div>
      <input placeholder="이름 (예: 회의용 의자)" value={name} onChange={e => setName(e.target.value)} />
      <div className="dims">
        <label>W<input type="number" value={w} onChange={e => setW(+e.target.value || 0)} /></label>
        <label>D<input type="number" value={d} onChange={e => setD(+e.target.value || 0)} /></label>
        <label>H<input type="number" value={h} onChange={e => setH(+e.target.value || 0)} /></label>
      </div>
      <div className="dims">
        <label className="colorlab">색<input type="color" value={color} onChange={e => setColor(e.target.value)} /></label>
        <label className="sitlab">
          <input type="checkbox" checked={sit} onChange={e => setSit(e.target.checked)} /> 앉기
        </label>
        {sit && <label>높이<input type="number" value={sitH} onChange={e => setSitH(+e.target.value || 0)} /></label>}
      </div>
      <div className="sel-row">
        <button
          onClick={() => {
            if (!name.trim() || w < 10 || d < 10 || h < 5) return
            const def = {
              name: name.trim(),
              size: { w, d, h },
              color,
              ...(sit ? { interactions: { sit: { height: sitH } } } : {}),
            }
            const id = onAdd(def)
            onPlaced(id)
            setOpen(false); setName('')
          }}
        >추가 + 배치</button>
        <button onClick={() => setOpen(false)}>닫기</button>
      </div>
    </div>
  )
}

function WallPlan({ wall, selected, onDown }) {
  const t = wall.thickness ?? 12
  const dx = wall.to.x - wall.from.x
  const dz = wall.to.z - wall.from.z
  const len = Math.hypot(dx, dz)
  if (len === 0) return null
  const ux = dx / len, uz = dz / len
  const at = o => [wall.from.x + ux * o, wall.from.z + uz * o]
  return (
    <g onPointerDown={onDown} style={{ cursor: 'pointer' }}>
      <line
        x1={wall.from.x} y1={wall.from.z} x2={wall.to.x} y2={wall.to.z}
        stroke={selected ? '#2f6fed' : '#4a4a50'}
        strokeWidth={t}
      />
      {(wall.openings ?? []).map((o, j) => {
        const [x1, z1] = at(o.offset)
        const [x2, z2] = at(o.offset + o.width)
        const isDoor = o.type === 'door'
        return (
          <line
            key={j}
            x1={x1} y1={z1} x2={x2} y2={z2}
            stroke={isDoor ? '#efe9dc' : '#9ec7e8'}
            strokeWidth={t + 2}
            strokeLinecap="butt"
          />
        )
      })}
    </g>
  )
}
