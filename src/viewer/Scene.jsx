import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { CM, deg } from '../lib/units.js'
import { registerItemObject } from '../lib/interact.js'
import { editor, subscribeEditor, getEditorSnapshot } from '../lib/editor.js'
import { setPrompt } from '../lib/hud.js'
import { obbOverlapsObb, obbIntersectsSegment, circleOverlapsObb } from '../lib/collision.js'

const WALL_COLOR = '#eae6df'
const FLOOR_COLORS = { wood: '#c09a6e', tile: '#d8d4cb', carpet: '#7f8d84', default: '#b9a98f' }
const CEILING_COLOR = '#f4f2ed'

export function SceneRoot({ scene, catalog }) {
  const wallMeshes = useMemo(() => buildWalls(scene), [scene])
  const bounds = useMemo(() => sceneBounds(scene), [scene])

  return (
    <group>
      <hemisphereLight intensity={0.55} color="#ffffff" groundColor="#8a7a66" />
      <ambientLight intensity={0.25} />
      <SunLight bounds={bounds} />

      {/* 바깥 지면 (현관으로 나갔을 때 허공 방지) */}
      <mesh position={[bounds.cx, -0.03, bounds.cz]} receiveShadow>
        <boxGeometry args={[bounds.w + 40, 0.02, bounds.d + 40]} />
        <meshStandardMaterial color="#9aa98a" />
      </mesh>

      {(scene.floors ?? []).map((f, i) => (
        <Floor key={i} f={f} wallHeight={scene.wallHeight ?? 250} ceiling={scene.ceiling !== false} />
      ))}

      {wallMeshes.map((w, i) => (
        <mesh key={i} position={w.position} rotation={[0, w.angle, 0]} castShadow receiveShadow>
          <boxGeometry args={w.size} />
          <meshStandardMaterial color={WALL_COLOR} />
        </mesh>
      ))}

      {/* 출입금지 구역: 고객에겐 그냥 막힌 벽 덩어리 — 금지구역임을 드러내지 않는다 */}
      {(scene.zones ?? []).map(zn => (
        <mesh
          key={zn.id}
          position={[(zn.x + zn.w / 2) * CM, ((scene.wallHeight ?? 250) / 2) * CM, (zn.z + zn.d / 2) * CM]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[zn.w * CM, (scene.wallHeight ?? 250) * CM, zn.d * CM]} />
          <meshStandardMaterial color={WALL_COLOR} />
        </mesh>
      ))}

      {/* 천장 조명 패널 (시각 전용 — 실광원은 태양광이 담당) */}
      {(scene.lights ?? []).map((l, i) => (
        <mesh key={i} position={[(l.x) * CM, (scene.wallHeight ?? 250) * CM - 0.04, (l.z) * CM]}>
          <boxGeometry args={[(l.w ?? 120) * CM, 0.05, (l.d ?? 60) * CM]} />
          <meshStandardMaterial color="#ffffff" emissive="#fff4dd" emissiveIntensity={1.6} />
        </mesh>
      ))}

      {(scene.items ?? []).map(item => (
        <Item
          key={item.id}
          item={item}
          cat={catalog.items[item.catalogId]}
          interactable={!inAnyZone(item.position, scene.zones)}
        />
      ))}
    </group>
  )
}

// 금지구역 내부 가구는 벽 덩어리에 가려진다 — 상호작용(E)·조명도 함께 꺼야 존재가 새지 않는다
function inAnyZone(pos, zones) {
  for (const zn of zones ?? []) {
    if (pos.x >= zn.x && pos.x <= zn.x + zn.w && pos.z >= zn.z && pos.z <= zn.z + zn.d) return true
  }
  return false
}

// 태양광: 씬 크기에 맞춰 그림자 절두체를 산출 (고정 ±12m는 큰 씬에서 그림자가 잘린다)
function SunLight({ bounds }) {
  const ref = useRef()
  const half = Math.max(bounds.w, bounds.d) / 2 + 3 // 바깥 지면 여유분
  useEffect(() => {
    const light = ref.current
    if (!light) return
    light.target.position.set(bounds.cx, 0, bounds.cz)
    light.target.updateMatrixWorld()
  }, [bounds])
  return (
    <directionalLight
      ref={ref}
      castShadow
      position={[bounds.cx + 6, 9 + half * 0.4, bounds.cz + 4]}
      intensity={1.1}
      shadow-mapSize={[2048, 2048]}
      shadow-camera-left={-half}
      shadow-camera-right={half}
      shadow-camera-top={half}
      shadow-camera-bottom={-half}
      shadow-camera-far={half * 4 + 20}
    />
  )
}

function Floor({ f, wallHeight, ceiling }) {
  const color = FLOOR_COLORS[f.material] ?? FLOOR_COLORS.default
  const cx = (f.x + f.w / 2) * CM
  const cz = (f.z + f.d / 2) * CM
  return (
    <group>
      <mesh position={[cx, -0.01, cz]} receiveShadow>
        <boxGeometry args={[f.w * CM, 0.02, f.d * CM]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {ceiling && (
        <mesh position={[cx, wallHeight * CM, cz]}>
          <boxGeometry args={[f.w * CM, 0.02, f.d * CM]} />
          {/* 아랫면은 직사광을 못 받아 탁해진다 — 약한 자체발광으로 실내 천장 톤 유지 */}
          <meshStandardMaterial color={CEILING_COLOR} emissive={CEILING_COLOR} emissiveIntensity={0.35} />
        </mesh>
      )}
    </group>
  )
}

function Item({ item, cat, interactable = true }) {
  const groupRef = useRef()
  const lightRef = useRef()
  const shadeRef = useRef()
  const isLamp = !!cat?.interactions?.toggle && interactable

  useEffect(() => {
    if (!groupRef.current || !interactable) return
    return registerItemObject(item.id, {
      item,
      cat,
      object: groupRef.current,
      toggle: isLamp
        ? () => {
            if (lightRef.current) lightRef.current.visible = !lightRef.current.visible
            if (shadeRef.current)
              shadeRef.current.emissiveIntensity = lightRef.current?.visible ? 0.7 : 0.03
          }
        : undefined,
    })
  }, [item, cat, isLamp, interactable])

  if (!cat) return null
  const { w, d, h } = cat.size
  return (
    <group
      ref={groupRef}
      position={[item.position.x * CM, 0, item.position.z * CM]}
      rotation={[0, deg(item.rotationY ?? 0), 0]}
    >
      {isLamp ? (
        <>
          <mesh position={[0, (h / 2) * CM, 0]} castShadow>
            <boxGeometry args={[6 * CM, h * CM, 6 * CM]} />
            <meshStandardMaterial color="#55555c" />
          </mesh>
          <mesh position={[0, (h - 22) * CM, 0]}>
            <boxGeometry args={[w * CM, 32 * CM, d * CM]} />
            <meshStandardMaterial ref={shadeRef} color="#f2e2c4" emissive="#ffd9a0" emissiveIntensity={0.7} />
          </mesh>
          <pointLight
            ref={lightRef}
            position={[0, (h - 4) * CM, 0]}
            intensity={6}
            distance={7}
            decay={2}
            color="#ffdfae"
          />
        </>
      ) : (
        <mesh position={[0, (h / 2) * CM, 0]} castShadow receiveShadow>
          <boxGeometry args={[w * CM, h * CM, d * CM]} />
          <meshStandardMaterial color={cat.color ?? '#999'} />
        </mesh>
      )}
      {/* 정면(-z) 마커: rotationY 규약 검증용 어두운 띠 */}
      <mesh position={[0, 0.02, -(d / 2) * CM - 0.005]}>
        <boxGeometry args={[w * 0.6 * CM, 0.03, 0.01]} />
        <meshStandardMaterial color="#2c2c30" />
      </mesh>
    </group>
  )
}

// 배치 모드 고스트: 크로스헤어가 가리키는 바닥 지점을 따라다니는 반투명 프리뷰
const GHOST_MAX_DIST = 4.5 // m
const GHOST_SNAP = 5       // cm 그리드

export function Ghost({ catalog, colliders }) {
  const holding = useSyncExternalStore(subscribeEditor, getEditorSnapshot)
  const groupRef = useRef()
  const matRef = useRef()
  const { camera } = useThree()
  const tmpDir = useRef(new THREE.Vector3())

  useFrame(() => {
    const h = editor.holding
    const g = groupRef.current
    if (!h || !g) return
    const cat = catalog.items[h.catalogId]
    if (!cat) return

    // 크로스헤어 → 바닥(y=0) 교점. 수평/위를 보면 3m 앞 바닥으로 폴백
    const dir = tmpDir.current
    camera.getWorldDirection(dir)
    let px, pz
    if (dir.y < -0.08) {
      const t = Math.min(-camera.position.y / dir.y, GHOST_MAX_DIST / Math.max(Math.hypot(dir.x, dir.z), 0.01))
      px = camera.position.x + dir.x * t
      pz = camera.position.z + dir.z * t
    } else {
      const l = Math.hypot(dir.x, dir.z) || 1
      px = camera.position.x + (dir.x / l) * 3
      pz = camera.position.z + (dir.z / l) * 3
    }
    // cm 스냅
    const cmX = Math.round(px / CM / GHOST_SNAP) * GHOST_SNAP
    const cmZ = Math.round(pz / CM / GHOST_SNAP) * GHOST_SNAP

    const obb = {
      cx: cmX * CM, cz: cmZ * CM,
      hw: (cat.size.w / 2) * CM, hd: (cat.size.d / 2) * CM,
      rotY: deg(h.rotationY ?? 0),
    }
    let valid = !circleOverlapsObb(camera.position.x, camera.position.z, 0.35, obb)
    if (valid && colliders) {
      for (const s of colliders.segments) {
        if (obbIntersectsSegment(obb, s.ax, s.az, s.bx, s.bz, s.pad)) { valid = false; break }
      }
      if (valid) {
        for (const b of colliders.boxes) {
          if (obbOverlapsObb(obb, b)) { valid = false; break }
        }
      }
    }

    g.position.set(cmX * CM, 0, cmZ * CM)
    g.rotation.y = deg(h.rotationY ?? 0)
    if (matRef.current) matRef.current.color.set(valid ? cat.color ?? '#999' : '#d64545')

    editor.ghost.x = cmX
    editor.ghost.z = cmZ
    editor.ghost.valid = valid
    setPrompt(
      valid ? '클릭/E · 배치 · R 회전 · X 취소' : '겹침 — 배치 불가 · R 회전 · X 취소',
      valid ? 'info' : 'bad',
    )
  })

  if (!holding) return null
  const cat = catalog.items[holding.catalogId]
  if (!cat) return null
  const { w, d, h } = cat.size
  return (
    <group ref={groupRef}>
      <mesh position={[0, (h / 2) * CM, 0]}>
        <boxGeometry args={[w * CM, h * CM, d * CM]} />
        <meshStandardMaterial ref={matRef} color={cat.color ?? '#999'} transparent opacity={0.55} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.02, -(d / 2) * CM - 0.005]}>
        <boxGeometry args={[w * 0.6 * CM, 0.03, 0.01]} />
        <meshStandardMaterial color="#2c2c30" transparent opacity={0.7} />
      </mesh>
    </group>
  )
}

// 벽 하나 → 개구부(문·창)를 비켜간 박스 조각들
function buildWalls(scene) {
  const meshes = []
  const defaultH = scene.wallHeight ?? 250
  for (const wall of scene.walls ?? []) {
    const H = wall.height ?? defaultH
    const t = wall.thickness ?? 12
    const dx = wall.to.x - wall.from.x
    const dz = wall.to.z - wall.from.z
    const len = Math.hypot(dx, dz)
    if (len === 0) continue
    const angle = -Math.atan2(dz, dx) // 로컬 +x를 선분 방향으로
    const ux = dx / len, uz = dz / len

    const pieces = []
    const ops = [...(wall.openings ?? [])].sort((a, b) => a.offset - b.offset)
    let cursor = 0
    for (const o of ops) {
      const sill = o.sillHeight ?? (o.type === 'window' ? 90 : 0)
      const top = sill + o.height
      if (o.offset > cursor) pieces.push({ s: cursor, e: o.offset, y0: 0, y1: H })
      if (sill > 0) pieces.push({ s: o.offset, e: o.offset + o.width, y0: 0, y1: sill })
      if (top < H) pieces.push({ s: o.offset, e: o.offset + o.width, y0: top, y1: H })
      cursor = o.offset + o.width
    }
    if (cursor < len) pieces.push({ s: cursor, e: len, y0: 0, y1: H })

    for (const p of pieces) {
      const mid = (p.s + p.e) / 2
      meshes.push({
        position: [
          (wall.from.x + ux * mid) * CM,
          ((p.y0 + p.y1) / 2) * CM,
          (wall.from.z + uz * mid) * CM,
        ],
        size: [(p.e - p.s) * CM, (p.y1 - p.y0) * CM, t * CM],
        angle,
      })
    }
  }
  return meshes
}

function sceneBounds(scene) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const w of scene.walls ?? []) {
    for (const pt of [w.from, w.to]) {
      minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x)
      minZ = Math.min(minZ, pt.z); maxZ = Math.max(maxZ, pt.z)
    }
  }
  if (!isFinite(minX)) { minX = 0; maxX = 0; minZ = 0; maxZ = 0 }
  return {
    cx: ((minX + maxX) / 2) * CM,
    cz: ((minZ + maxZ) / 2) * CM,
    w: (maxX - minX) * CM,
    d: (maxZ - minZ) * CM,
  }
}
