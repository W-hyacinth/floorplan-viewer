import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, PointerLockControls } from '@react-three/drei'
import { SceneRoot } from './viewer/Scene.jsx'
import { Player } from './viewer/Player.jsx'
import { Minimap } from './viewer/Minimap.jsx'
import { Editor2D } from './editor/Editor2D.jsx'
import { buildColliders } from './lib/collision.js'
import { subscribeHud, getHudSnapshot } from './lib/hud.js'
import { Landing } from './Landing.jsx'

// 파라미터 없음 → 랜딩 / ?viewer=1 → 고객용 3D 전용 / ?mode=admin 또는 ?scene= → 에디터
const PARAMS = new URLSearchParams(location.search)
const VIEWER_ONLY = PARAMS.has('viewer')
const IS_LANDING = !VIEWER_ONLY && PARAMS.get('mode') !== 'admin' && !PARAMS.has('scene')
// 터치 기기: 포인터락 1인칭이 불가능 → 천장 없는 궤도 둘러보기로 폴백
const IS_TOUCH = window.matchMedia?.('(pointer: coarse)').matches ?? false

export default function App() {
  if (IS_LANDING) return <Landing />
  return <Viewer />
}

// 씬 JSON 정규화: v0(단층) → v1(levels[]) — 하위호환은 여기 한 곳에서 흡수한다
function normalizeDoc(j) {
  const { customCatalog, ...rest } = j
  if (Array.isArray(j.levels)) {
    return {
      name: j.name ?? '이름 없는 건물',
      customCatalog: customCatalog ?? {},
      levels: j.levels.map((lv, i) => {
        const { items, id, name, restricted, ...sceneFields } = lv
        return {
          id: id ?? `lv${i}`,
          name: name ?? `${i + 1}층`,
          restricted: !!restricted,
          scene: sceneFields,
          items: items ?? [],
        }
      }),
    }
  }
  const { items, name, version, ...sceneFields } = rest
  return {
    name: name ?? '이름 없는 도면',
    customCatalog: customCatalog ?? {},
    levels: [{ id: 'lv0', name: '1층', restricted: false, scene: sceneFields, items: items ?? [] }],
  }
}

const EMPTY_LEVEL_SCENE = () => ({
  version: 0, wallHeight: 250,
  spawn: { x: 200, z: 200, yawDeg: 0 },
  walls: [], floors: [], zones: [],
})

function Viewer() {
  const [doc, setDoc] = useState(null)          // { name, levels: [{id,name,restricted,scene,items}] }
  const [active, setActive] = useState(0)       // 현재 층 인덱스 (doc.levels 기준)
  const [catalog, setCatalog] = useState(null)
  const [customItems, setCustomItems] = useState({}) // 사용자 정의 가구 타입 (내보내기에 포함)
  const [error, setError] = useState(null)
  const [locked, setLocked] = useState(false)
  const [view, setView] = useState(VIEWER_ONLY ? 'walk' : 'plan') // 'plan'=어드민 도면 / 'walk'=어드민 3D / 'preview'=고객 시점 시뮬레이션
  const { prompt, tone } = useSyncExternalStore(subscribeHud, getHudSnapshot)
  const sceneName = useRef('office')

  useEffect(() => {
    const name = new URLSearchParams(location.search).get('scene') || 'office'
    sceneName.current = name
    Promise.all([
      fetch(`${import.meta.env.BASE_URL}scenes/${name}.json`).then(r => { if (!r.ok) throw new Error(`scenes/${name}.json ${r.status}`); return r.json() }),
      fetch(`${import.meta.env.BASE_URL}catalog/catalog.json`).then(r => { if (!r.ok) throw new Error(`catalog.json ${r.status}`); return r.json() }),
    ])
      .then(([s, c]) => {
        const d = normalizeDoc(s)
        setDoc(d)
        setCustomItems(d.customCatalog)
        setCatalog(c)
        // 고객 모드: 비공개 층은 존재 자체를 숨긴다 → 첫 공개 층에서 시작
        if (VIEWER_ONLY) {
          const first = d.levels.findIndex(lv => !lv.restricted)
          setActive(first >= 0 ? first : 0)
        }
      })
      .catch(e => setError(String(e)))
  }, [])

  // Tab = 도면 ↔ 3D 전환 (고객용 모드에선 잠금)
  useEffect(() => {
    if (VIEWER_ONLY) return
    const onKey = e => {
      if (e.code !== 'Tab') return
      e.preventDefault()
      setView(v => {
        if (v === 'walk') document.exitPointerLock?.()
        return v === 'plan' ? 'walk' : 'plan'
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const level = doc?.levels[active] ?? null
  const scene = level?.scene ?? null
  const items = level?.items ?? null
  // 고객 시점 여부: 실제 고객 모드거나, 어드민의 '고객 체험' 시뮬레이션
  const isCustomerView = VIEWER_ONLY || view === 'preview'
  // 고객에게 보이는 층 목록 (어드민 3D는 전부)
  const visibleLevels = useMemo(
    () => (doc ? doc.levels.map((lv, i) => ({ ...lv, index: i })).filter(lv => !isCustomerView || !lv.restricted) : []),
    [doc, isCustomerView],
  )

  // 고객 체험 진입: 고객과 동일하게 첫 공개 층에서 시작 (비공개 층에 있었다면 강제 이동)
  const enterPreview = useCallback(() => {
    if (doc && doc.levels[active]?.restricted) {
      const first = doc.levels.findIndex(lv => !lv.restricted)
      if (first >= 0) setActive(first)
    }
    setView('preview')
  }, [doc, active])

  const updateLevel = useCallback(fn => {
    setDoc(d => ({ ...d, levels: d.levels.map((lv, i) => (i === active ? fn(lv) : lv)) }))
  }, [active])

  const catalogMerged = useMemo(
    () => (catalog ? { ...catalog, items: { ...catalog.items, ...customItems } } : null),
    [catalog, customItems],
  )

  const sceneData = useMemo(() => {
    if (!scene || !items) return null
    let floors = scene.floors
    if (!floors?.length && scene.walls?.length) {
      // 바닥 미지정 씬(직접 그린 도면)은 벽 바운딩박스로 자동 바닥
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (const w of scene.walls)
        for (const p of [w.from, w.to]) {
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
          minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
        }
      floors = [{ x: minX, z: minZ, w: maxX - minX, d: maxZ - minZ, material: 'wood' }]
    }
    return { ...scene, name: doc ? `${doc.name} · ${level.name}` : scene.name, floors: floors ?? [], items }
  }, [scene, items, doc, level])
  const colliders = useMemo(
    () => (sceneData && catalogMerged ? buildColliders(sceneData, catalogMerged) : null),
    [sceneData, catalogMerged],
  )

  const catalogApi = useMemo(() => ({
    addCustom: def => {
      const id = `c-${Date.now().toString(36)}`
      setCustomItems(prev => ({ ...prev, [id]: def }))
      return id
    },
    removeCustom: id => {
      setCustomItems(prev => { const n = { ...prev }; delete n[id]; return n })
      // 그 타입으로 배치된 가구는 모든 층에서 제거
      setDoc(d => ({ ...d, levels: d.levels.map(lv => ({ ...lv, items: lv.items.filter(i => i.catalogId !== id) })) }))
    },
    customIds: new Set(Object.keys(customItems)),
  }), [customItems])

  const itemsApi = useMemo(() => ({
    remove: id => updateLevel(lv => ({ ...lv, items: lv.items.filter(i => i.id !== id) })),
    add: item => updateLevel(lv => {
      const id = item.id ?? `n-${Date.now().toString(36)}`
      return { ...lv, items: [...lv.items, { ...item, id }] }
    }),
    update: (id, patch) => updateLevel(lv => ({
      ...lv, items: lv.items.map(i => (i.id === id ? { ...i, ...patch } : i)),
    })),
  }), [updateLevel])

  const patchScene = useCallback(fn => updateLevel(lv => ({ ...lv, scene: fn(lv.scene) })), [updateLevel])
  const sceneApi = useMemo(() => ({
    addWall: wall => patchScene(s => ({ ...s, walls: [...(s.walls ?? []), wall] })),
    setWalls: walls => patchScene(s => ({ ...s, walls })),
    removeWall: idx => patchScene(s => ({ ...s, walls: (s.walls ?? []).filter((_, i) => i !== idx) })),
    addZone: zone => patchScene(s => ({ ...s, zones: [...(s.zones ?? []), zone] })),
    updateZone: (id, patch) => patchScene(s => ({
      ...s, zones: (s.zones ?? []).map(z => (z.id === id ? { ...z, ...patch } : z)),
    })),
    removeZone: id => patchScene(s => ({ ...s, zones: (s.zones ?? []).filter(z => z.id !== id) })),
    setSpawn: spawn => patchScene(s => ({ ...s, spawn })),
    setUnderlay: underlay => patchScene(s => ({ ...s, underlay })),
    clearLevel: () => updateLevel(lv => ({ ...lv, scene: EMPTY_LEVEL_SCENE(), items: [] })),
    reset: () => {
      setDoc({ name: '새 도면', levels: [{ id: 'lv0', name: '1층', restricted: false, scene: EMPTY_LEVEL_SCENE(), items: [] }] })
      setActive(0)
    },
  }), [patchScene, updateLevel])

  const levelsApi = useMemo(() => ({
    setActive,
    add: () => {
      if (!doc) return
      const n = doc.levels.length
      setDoc(d => ({
        ...d,
        levels: [...d.levels, {
          id: `lv-${Date.now().toString(36)}`,
          name: `${d.levels.length + 1}층`,
          restricted: false,
          scene: EMPTY_LEVEL_SCENE(),
          items: [],
        }],
      }))
      setActive(n)
    },
    remove: idx => {
      if (!doc || doc.levels.length <= 1) return
      setDoc(d => ({ ...d, levels: d.levels.filter((_, i) => i !== idx) }))
      setActive(a => Math.max(0, Math.min(a > idx ? a - 1 : a, doc.levels.length - 2)))
    },
    toggleRestricted: idx => setDoc(d => ({
      ...d,
      levels: d.levels.map((lv, i) => (i === idx ? { ...lv, restricted: !lv.restricted } : lv)),
    })),
  }), [doc])

  const importScene = useCallback(async file => {
    try {
      const j = JSON.parse(await file.text())
      if (!Array.isArray(j.walls) && !Array.isArray(j.levels)) throw new Error('walls/levels 배열이 없음 — 씬 JSON이 아님')
      const d = normalizeDoc(j)
      setDoc(d)
      setCustomItems(d.customCatalog)
      setActive(0)
      if (j.name) sceneName.current = String(j.name).replace(/[^\w가-힣-]+/g, '_')
      return null
    } catch (e) {
      return String(e.message ?? e)
    }
  }, [])

  const exportScene = useCallback(() => {
    const payload = {
      version: 1,
      name: doc.name,
      levels: doc.levels.map(lv => ({
        id: lv.id,
        name: lv.name,
        ...(lv.restricted ? { restricted: true } : {}),
        ...lv.scene,
        items: lv.items,
      })),
    }
    if (Object.keys(customItems).length) payload.customCatalog = customItems
    const json = JSON.stringify(payload, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${sceneName.current}.edited.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [doc, customItems])

  if (error) return <div className="overlay"><div className="panel"><h1>로드 실패</h1><p>{error}</p></div></div>
  if (!sceneData || !catalogMerged) return <div className="overlay"><div className="panel"><p>로딩중…</p></div></div>
  // 공개된 층이 하나도 없는 경우 — 고객은 안내만, 어드민 미리보기는 복귀 버튼 제공
  if (isCustomerView && visibleLevels.length === 0) {
    return (
      <div className="overlay">
        <div className="panel">
          <h1>{doc.name}</h1>
          <p>지금은 둘러볼 수 있는 층이 없습니다.</p>
          {view === 'preview' && (
            <button className="panel-btn" onClick={() => setView('plan')}>에디터로 돌아가기 (Tab)</button>
          )}
        </div>
      </div>
    )
  }

  if (view === 'plan') {
    return (
      <Editor2D
        buildingName={doc.name}
        levels={doc.levels}
        activeLevel={active}
        levelsApi={levelsApi}
        scene={scene}
        items={items}
        catalog={catalogMerged}
        catalogApi={catalogApi}
        itemsApi={itemsApi}
        sceneApi={sceneApi}
        onEnter3D={() => setView('walk')}
        onEnterPreview={enterPreview}
        onExport={exportScene}
        onImport={importScene}
      />
    )
  }

  const floorSwitch = visibleLevels.length > 1 && (
    <div className="floor-switch">
      {visibleLevels.map(lv => (
        <button
          key={lv.id}
          className={lv.index === active ? 'on' : ''}
          onClick={() => { setActive(lv.index); document.exitPointerLock?.() }}
        >
          {lv.name}{!isCustomerView && lv.restricted ? ' 🔒' : ''}
        </button>
      ))}
    </div>
  )

  // 어드민이 비공개 층을 미리보는 중임을 명확히 — 고객용 투어에선 이 층 자체가 목록에 없다
  const restrictedBadge = !isCustomerView && level?.restricted && (
    <div className="restricted-badge">
      🔒 고객 비공개 층 — 고객용 3D 투어에는 나타나지 않습니다 (어드민 미리보기)
    </div>
  )

  // 고객 체험 시뮬레이션 중 표시 (실제 고객 화면엔 없음)
  const previewBadge = view === 'preview' && (
    <div className="preview-badge">
      👁 고객 체험 — 실제 고객에게 보이는 그대로입니다 · Tab = 에디터로
    </div>
  )

  if (IS_TOUCH) {
    return (
      <>
        <Canvas shadows camera={{ fov: 60, near: 0.05, far: 200 }}>
          <color attach="background" args={['#ccd6d0']} />
          <fog attach="fog" args={['#ccd6d0', 40, 120]} />
          {/* 위에서 내려다보는 돌하우스 뷰 — 천장을 벗겨 실내가 보이게 */}
          <SceneRoot scene={{ ...sceneData, ceiling: false }} catalog={catalogMerged} />
          <OrbitViewer scene={sceneData} />
        </Canvas>
        {floorSwitch}
        {restrictedBadge}
        {previewBadge}
        <div className="touch-banner">
          한 손가락 회전 · 두 손가락 확대/이동 — 1인칭 걷기 투어는 데스크톱에서 열려요
        </div>
      </>
    )
  }

  return (
    <>
      <Canvas shadows camera={{ fov: 70, near: 0.05, far: 200 }}>
        {/* attach="background"는 부모가 scene이어야 먹는다 — group 안에 넣으면 no-op */}
        <color attach="background" args={['#ccd6d0']} />
        <fog attach="fog" args={['#ccd6d0', 30, 90]} />
        <SceneRoot scene={sceneData} catalog={catalogMerged} />
        <Player scene={sceneData} colliders={colliders} />
        <PointerLockControls onLock={() => setLocked(true)} onUnlock={() => setLocked(false)} />
      </Canvas>

      {locked ? (
        <div className="crosshair" />
      ) : (
        <div className="overlay">
          <div className="panel">
            <h1>{sceneData.name}</h1>
            <p>화면 클릭 = 시작</p>
            <p className="keys">WASD 이동 · 마우스 시선 · Shift 달리기 · E 상호작용 · ESC 해제</p>
            {!VIEWER_ONLY && (
              <button className="panel-btn" onClick={() => setView('plan')}>
                {view === 'preview' ? '에디터로 돌아가기 (Tab)' : '2D 도면으로 (Tab)'}
              </button>
            )}
          </div>
        </div>
      )}

      {floorSwitch}
      {restrictedBadge}
      {previewBadge}

      <Minimap scene={sceneData} items={items} catalog={catalogMerged} />

      {prompt && <div className={tone === 'bad' ? 'prompt prompt--bad' : 'prompt'}>{prompt}</div>}
    </>
  )
}

// 터치 폴백: 씬 바운즈 기준으로 카메라를 띄우고 궤도 컨트롤로 둘러본다
function OrbitViewer({ scene }) {
  const { camera } = useThree()
  const b = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const f of scene.floors ?? []) {
      minX = Math.min(minX, f.x); maxX = Math.max(maxX, f.x + f.w)
      minZ = Math.min(minZ, f.z); maxZ = Math.max(maxZ, f.z + f.d)
    }
    if (!isFinite(minX)) { minX = 0; maxX = 1000; minZ = 0; maxZ = 800 }
    return {
      cx: ((minX + maxX) / 2) / 100, cz: ((minZ + maxZ) / 2) / 100,
      w: (maxX - minX) / 100, d: (maxZ - minZ) / 100,
    }
  }, [scene])
  useEffect(() => {
    camera.position.set(b.cx + b.w * 0.45, Math.max(b.w, b.d) * 0.55 + 3, b.cz + b.d * 0.95)
  }, [b, camera])
  return (
    <OrbitControls
      makeDefault
      target={[b.cx, 0.8, b.cz]}
      maxPolarAngle={Math.PI / 2 - 0.08}
      minDistance={2}
      maxDistance={Math.max(b.w, b.d) * 3}
    />
  )
}
