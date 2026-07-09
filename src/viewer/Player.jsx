import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { resolveCircle } from '../lib/collision.js'
import { CM, deg } from '../lib/units.js'
import { itemObjects, findEntryFromHit } from '../lib/interact.js'
import { setPrompt } from '../lib/hud.js'
import { pose } from '../lib/pose.js'

const EYE = 1.6           // 서 있을 때 시선 높이 m
const SIT_EYE_OFFSET = 70 // 앉는 면 높이 + 70cm = 앉은 시선
const RADIUS = 0.3        // 플레이어 반지름 m
const WALK = 1.4          // m/s
const RUN = 2.8
const REACH = 2.2         // 상호작용 사거리 m

const UP = new THREE.Vector3(0, 1, 0)
const CENTER = new THREE.Vector2(0, 0)

// 3D는 "체험 전용" — 편집(집기/배치)은 2D 도면 에디터가 담당한다.
export function Player({ scene, colliders }) {
  const keys = useRef({})
  const { camera } = useThree()
  const tmp = useRef({ dir: new THREE.Vector3(), right: new THREE.Vector3() })
  const raycaster = useRef(new THREE.Raycaster())
  const targetRef = useRef(null)   // 크로스헤어가 겨눈 상호작용 대상
  const seatedRef = useRef(null)   // { prevX, prevZ } — 앉기 전 위치 (복귀용)

  useEffect(() => {
    const sit = entry => {
      const s = entry.cat.interactions.sit
      seatedRef.current = { prevX: camera.position.x, prevZ: camera.position.z }
      camera.position.set(
        entry.item.position.x * CM,
        (s.height + SIT_EYE_OFFSET) * CM,
        entry.item.position.z * CM,
      )
      camera.rotation.set(0, deg(entry.item.rotationY ?? 0), 0, 'YXZ')
      targetRef.current = null
    }
    const stand = () => {
      camera.position.x = seatedRef.current.prevX
      camera.position.z = seatedRef.current.prevZ
      camera.position.y = EYE
      seatedRef.current = null
    }
    const down = e => {
      keys.current[e.code] = true
      if (e.code === 'KeyE') {
        if (seatedRef.current) return stand()
        const entry = targetRef.current
        if (!entry) return
        if (entry.cat.interactions?.sit) sit(entry)
        else if (entry.toggle) entry.toggle()
      }
    }
    const up = e => { keys.current[e.code] = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [camera])

  useEffect(() => {
    if (import.meta.env.DEV) window.__camera = camera // 자동 테스트용 (prod 제외)
    const sp = scene.spawn ?? { x: 100, z: 100, yawDeg: 0 }
    camera.position.set(sp.x * CM, EYE, sp.z * CM)
    camera.rotation.set(0, deg(sp.yawDeg ?? 0), 0, 'YXZ')
    seatedRef.current = null
  }, [scene, camera])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const k = keys.current
    const f = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0)
    const s = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0)

    // 미니맵용 현재 위치/시선 (도면 cm)
    {
      const { dir } = tmp.current
      camera.getWorldDirection(dir)
      pose.x = camera.position.x / CM
      pose.z = camera.position.z / CM
      if (dir.x * dir.x + dir.z * dir.z > 1e-6) { pose.dx = dir.x; pose.dz = dir.z }
    }

    if (seatedRef.current) {
      // 앉은 상태: 이동·충돌 없음, 시선만. E로만 일어난다(오조작 방지).
      setPrompt('E · 일어나기')
      return
    }

    if (f || s) {
      const { dir, right } = tmp.current
      camera.getWorldDirection(dir)
      dir.y = 0
      if (dir.lengthSq() > 0) dir.normalize()
      right.crossVectors(dir, UP) // dir × up = 오른쪽
      const speed = k.ShiftLeft || k.ShiftRight ? RUN : WALK
      const mx = dir.x * f + right.x * s
      const mz = dir.z * f + right.z * s
      const ml = Math.hypot(mx, mz) || 1
      camera.position.x += (mx / ml) * speed * dt
      camera.position.z += (mz / ml) * speed * dt
    }

    if (colliders) {
      const p = resolveCircle(
        { x: camera.position.x, z: camera.position.z },
        RADIUS,
        colliders.segments,
        colliders.boxes,
      )
      camera.position.x = p.x
      camera.position.z = p.z
    }
    camera.position.y = EYE

    // 크로스헤어 레이캐스트 → 상호작용 대상 탐색 (E 대상만)
    let entry = null
    if (itemObjects.size > 0) {
      raycaster.current.setFromCamera(CENTER, camera)
      const candidates = [...itemObjects.values()].filter(v => v.cat.interactions)
      const hits = raycaster.current.intersectObjects(candidates.map(v => v.object), true)
      if (hits.length > 0 && hits[0].distance <= REACH) {
        const found = findEntryFromHit(hits[0].object)
        entry = found?.cat.interactions ? found : null
      }
    }
    targetRef.current = entry
    if (!entry) setPrompt(null)
    else if (entry.cat.interactions?.sit) setPrompt(`E · ${entry.cat.name ?? ''} 앉기`)
    else if (entry.toggle) setPrompt('E · 조명 켜기/끄기')
    else setPrompt(null)
  })

  return null
}
