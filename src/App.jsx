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

function Viewer() {
  const [scene, setScene] = useState(null)     // items 제외 원본 (walls/floors/spawn)
  const [items, setItems] = useState(null)     // 편집 가능한 가구 목록
  const [catalog, setCatalog] = useState(null)
  const [customItems, setCustomItems] = useState({}) // 사용자 정의 가구 타입 (내보내기에 포함)
  const [error, setError] = useState(null)
  const [locked, setLocked] = useState(false)
  const [view, setView] = useState(VIEWER_ONLY ? 'walk' : 'plan') // 'plan'=어드민 도면 / 'walk'=3D 체험
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
        const { items: sceneItems, customCatalog, ...rest } = s
        setScene(rest)
        setItems(sceneItems ?? [])
        setCustomItems(customCatalog ?? {})
        setCatalog(c)
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
    return { ...scene, floors: floors ?? [], items }
  }, [scene, items])
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
      setItems(prev => prev.filter(i => i.catalogId !== id)) // 그 타입으로 배치된 가구도 제거
    },
    customIds: new Set(Object.keys(customItems)),
  }), [customItems])

  const itemsApi = useMemo(() => ({
    remove: id => setItems(prev => prev.filter(i => i.id !== id)),
    add: item => setItems(prev => {
      const id = item.id ?? `n-${Date.now().toString(36)}`
      return [...prev, { ...item, id }]
    }),
    update: (id, patch) => setItems(prev => prev.map(i => (i.id === id ? { ...i, ...patch } : i))),
  }), [])

  const sceneApi = useMemo(() => ({
    addWall: wall => setScene(p => ({ ...p, walls: [...(p.walls ?? []), wall] })),
    removeWall: idx => setScene(p => ({ ...p, walls: (p.walls ?? []).filter((_, i) => i !== idx) })),
    addZone: zone => setScene(p => ({ ...p, zones: [...(p.zones ?? []), zone] })),
    updateZone: (id, patch) => setScene(p => ({
      ...p, zones: (p.zones ?? []).map(z => (z.id === id ? { ...z, ...patch } : z)),
    })),
    removeZone: id => setScene(p => ({ ...p, zones: (p.zones ?? []).filter(z => z.id !== id) })),
    setSpawn: spawn => setScene(p => ({ ...p, spawn })),
    setUnderlay: underlay => setScene(p => ({ ...p, underlay })),
    reset: () => {
      setScene({ version: 0, name: '새 도면', wallHeight: 250, spawn: { x: 200, z: 200, yawDeg: 0 }, walls: [], floors: [], zones: [] })
      setItems([])
    },
  }), [])

  const importScene = useCallback(async file => {
    try {
      const j = JSON.parse(await file.text())
      if (!Array.isArray(j.walls)) throw new Error('walls 배열이 없음 — 씬 JSON이 아님')
      const { items: importedItems, customCatalog, ...rest } = j
      setScene(rest)
      setItems(importedItems ?? [])
      setCustomItems(customCatalog ?? {})
      if (j.name) sceneName.current = String(j.name).replace(/[^\w가-힣-]+/g, '_')
      return null
    } catch (e) {
      return String(e.message ?? e)
    }
  }, [])

  const exportScene = useCallback(() => {
    const payload = { ...scene, items }
    if (Object.keys(customItems).length) payload.customCatalog = customItems
    const json = JSON.stringify(payload, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${sceneName.current}.edited.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [scene, items, customItems])

  if (error) return <div className="overlay"><div className="panel"><h1>로드 실패</h1><p>{error}</p></div></div>
  if (!sceneData || !catalogMerged) return <div className="overlay"><div className="panel"><p>로딩중…</p></div></div>

  if (view === 'plan') {
    return (
      <Editor2D
        scene={scene}
        items={items}
        catalog={catalogMerged}
        catalogApi={catalogApi}
        itemsApi={itemsApi}
        sceneApi={sceneApi}
        onEnter3D={() => setView('walk')}
        onExport={exportScene}
        onImport={importScene}
      />
    )
  }

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
              <button className="panel-btn" onClick={() => setView('plan')}>2D 도면으로 (Tab)</button>
            )}
          </div>
        </div>
      )}

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
