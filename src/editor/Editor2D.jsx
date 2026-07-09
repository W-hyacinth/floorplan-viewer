import { useEffect, useMemo, useRef, useState } from 'react'
import { buildColliders, obbOverlapsObb, obbIntersectsSegment } from '../lib/collision.js'
import { CM, deg } from '../lib/units.js'

// 2D 탑뷰 도면 에디터. 도면 좌표(cm, +z=아래)가 SVG 좌표와 1:1 — 변환 없음.
const SNAP = 5 // cm

export function Editor2D({ scene, items, catalog, catalogApi, itemsApi, sceneApi, onEnter3D, onExport, onImport }) {
  const [tool, setTool] = useState('select') // 'select' | 'wall' | 'zone'
  const [selected, setSelected] = useState(null) // { kind: 'item'|'zone'|'wall', id }
  const [cursor, setCursor] = useState(null)     // 도면 좌표 (벽/구역 미리보기용)
  const [wallStart, setWallStart] = useState(null)
  const [zoneStart, setZoneStart] = useState(null)
  const [importErr, setImportErr] = useState(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const svgRef = useRef(null)
  const fileRef = useRef(null)
  const imgRef = useRef(null)
  const dragRef = useRef(null) // { kind:'item'|'zone'|'spawn', id, dx, dz }

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
  const viewBox = `${bounds.minX - M} ${bounds.minZ - M} ${bounds.maxX - bounds.minX + 2 * M} ${bounds.maxZ - bounds.minZ + 2 * M}`

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

  // ---- 포인터 ----
  const onItemDown = (e, it) => {
    if (tool !== 'select') return
    e.stopPropagation()
    setSelected({ kind: 'item', id: it.id })
    const p = toPlan(e)
    dragRef.current = { kind: 'item', id: it.id, dx: it.position.x - p.x, dz: it.position.z - p.z }
    capture(e)
  }
  const onZoneDown = (e, zn) => {
    if (tool !== 'select') return
    e.stopPropagation()
    setSelected({ kind: 'zone', id: zn.id })
    const p = toPlan(e)
    dragRef.current = { kind: 'zone', id: zn.id, dx: zn.x - p.x, dz: zn.z - p.z }
    capture(e)
  }
  const onWallDown = (e, idx) => {
    if (tool !== 'select') return
    e.stopPropagation()
    setSelected({ kind: 'wall', id: idx })
  }
  const onSpawnDown = e => {
    if (tool !== 'select') return
    e.stopPropagation()
    dragRef.current = { kind: 'spawn' }
    capture(e)
  }
  const capture = e => {
    try { svgRef.current.setPointerCapture(e.pointerId) } catch { /* 합성 이벤트는 캡처 불가 */ }
  }

  const onSvgDown = e => {
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
    const p = toPlan(e)
    if (tool !== 'select' || zoneStart) setCursor(p)
    const d = dragRef.current
    if (!d) return
    if (d.kind === 'item') itemsApi.update(d.id, { position: { x: snap(p.x + d.dx), z: snap(p.z + d.dz) } })
    else if (d.kind === 'zone') sceneApi.updateZone(d.id, { x: snap(p.x + d.dx), z: snap(p.z + d.dz) })
    else if (d.kind === 'spawn') sceneApi.setSpawn({ ...(scene.spawn ?? { yawDeg: 0 }), x: snap(p.x), z: snap(p.z) })
  }
  const onSvgUp = e => {
    dragRef.current = null
    if (tool === 'zone' && zoneStart) {
      const p = toPlan(e)
      const x1 = snap(Math.min(zoneStart.x, p.x)), x2 = snap(Math.max(zoneStart.x, p.x))
      const z1 = snap(Math.min(zoneStart.z, p.z)), z2 = snap(Math.max(zoneStart.z, p.z))
      if (x2 - x1 >= 30 && z2 - z1 >= 30) {
        const id = `zone-${Date.now().toString(36)}`
        sceneApi.addZone({ id, x: x1, z: z1, w: x2 - x1, d: z2 - z1 })
        setSelected({ kind: 'zone', id })
        setTool('select')
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
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
        const widthCm = 1000 // 기본 10m — 아래 입력으로 보정
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

  const selectedItem = selected?.kind === 'item' ? items.find(i => i.id === selected.id) : null
  const selectedItemCat = selectedItem ? catalog.items[selectedItem.catalogId] : null
  const underlay = scene.underlay

  return (
    <div className="editor">
      <div className="editor-top">
        <b>2D 도면 · {scene.name}</b>
        <div className="toolbar">
          <button className={tool === 'select' ? 'tool on' : 'tool'} onClick={() => setTool('select')}>선택</button>
          <button className={tool === 'wall' ? 'tool on' : 'tool'} onClick={() => { setTool('wall'); setSelected(null) }}>벽 그리기</button>
          <button className={tool === 'zone' ? 'tool on' : 'tool'} onClick={() => { setTool('zone'); setSelected(null) }}>🚫 금지구역</button>
        </div>
        <span className="hint">
          {tool === 'wall' ? '클릭-클릭으로 벽 연속 그리기 · ESC 끝내기'
            : tool === 'zone' ? '드래그로 출입금지 구역 지정'
            : '드래그 이동 · R 회전 · Delete 삭제 · 빨강 = 겹침'}
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
              if (f) loadUnderlay(f)
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
        </div>
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

            {/* 출입금지 구역 */}
            {(scene.zones ?? []).map(zn => (
              <g key={zn.id} onPointerDown={e => onZoneDown(e, zn)} style={{ cursor: tool === 'select' ? 'grab' : 'default' }}>
                <rect
                  x={zn.x} y={zn.z} width={zn.w} height={zn.d}
                  fill="url(#hatch)"
                  stroke={selected?.kind === 'zone' && selected.id === zn.id ? '#2f6fed' : '#d64545'}
                  strokeWidth={selected?.kind === 'zone' && selected.id === zn.id ? 5 : 3}
                />
                <text x={zn.x + zn.w / 2} y={zn.z + zn.d / 2 + 5} textAnchor="middle" fontSize="15" fill="#d64545" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  출입금지
                </text>
              </g>
            ))}

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
