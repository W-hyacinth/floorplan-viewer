import { useEffect, useMemo, useRef } from 'react'
import { pose } from '../lib/pose.js'
import { zonePoints } from '../lib/zone.js'

// 3D 체험 중 우상단 미니맵 — 정적 도면은 React가 한 번 그리고,
// 플레이어 마커만 rAF로 transform 갱신한다.
export function Minimap({ scene, items, catalog }) {
  const markerRef = useRef(null)

  const bounds = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const w of scene.walls ?? [])
      for (const p of [w.from, w.to]) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
      }
    if (!isFinite(minX)) { minX = 0; maxX = 1000; minZ = 0; maxZ = 1000 }
    return { minX, maxX, minZ, maxZ }
  }, [scene])
  const M = 60
  const w = bounds.maxX - bounds.minX + 2 * M
  const d = bounds.maxZ - bounds.minZ + 2 * M
  const viewBox = `${bounds.minX - M} ${bounds.minZ - M} ${w} ${d}`

  useEffect(() => {
    let raf
    const tick = () => {
      const g = markerRef.current
      if (g) {
        const ang = (Math.atan2(pose.dz, pose.dx) * 180) / Math.PI
        g.setAttribute('transform', `translate(${pose.x} ${pose.z}) rotate(${ang})`)
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="minimap" style={{ aspectRatio: `${w} / ${d}` }}>
      <svg viewBox={viewBox}>
        {(scene.floors ?? []).map((f, i) => (
          <rect key={i} x={f.x} y={f.z} width={f.w} height={f.d} fill="#3d434c" />
        ))}

        {items.map(it => {
          const c = catalog.items[it.catalogId]
          if (!c) return null
          return (
            <g key={it.id} transform={`translate(${it.position.x} ${it.position.z}) rotate(${-(it.rotationY ?? 0)})`}>
              <rect
                x={-c.size.w / 2} y={-c.size.d / 2}
                width={c.size.w} height={c.size.d}
                fill={c.color} opacity="0.85" rx="4"
              />
            </g>
          )
        })}

        {/* 금지구역: 고객 미니맵에선 벽과 같은 톤의 막힌 덩어리 — 가구 위에 그려 내부를 가린다 */}
        {(scene.zones ?? []).map(zn => (
          <polygon key={zn.id} points={zonePoints(zn).map(p => `${p.x},${p.z}`).join(' ')} fill="#cdd6e0" />
        ))}

        {(scene.walls ?? []).map((wall, i) => <MiniWall key={i} wall={wall} />)}

        {/* 플레이어: 위치 점 + 시선 방향 화살표 (기본 +x 방향) */}
        <g ref={markerRef}>
          <polygon points="52,0 14,26 24,0 14,-26" fill="rgba(47,111,237,0.85)" />
          <circle r="20" fill="#2f6fed" stroke="#fff" strokeWidth="6" />
        </g>
      </svg>
    </div>
  )
}

function MiniWall({ wall }) {
  const t = Math.max(wall.thickness ?? 12, 10)
  const dx = wall.to.x - wall.from.x
  const dz = wall.to.z - wall.from.z
  const len = Math.hypot(dx, dz)
  if (len === 0) return null
  const ux = dx / len, uz = dz / len
  const at = o => [wall.from.x + ux * o, wall.from.z + uz * o]
  return (
    <g>
      <line x1={wall.from.x} y1={wall.from.z} x2={wall.to.x} y2={wall.to.z} stroke="#cdd6e0" strokeWidth={t} />
      {(wall.openings ?? []).filter(o => o.type === 'door').map((o, j) => {
        const [x1, z1] = at(o.offset)
        const [x2, z2] = at(o.offset + o.width)
        return <line key={j} x1={x1} y1={z1} x2={x2} y2={z2} stroke="#3d434c" strokeWidth={t + 2} strokeLinecap="butt" />
      })}
    </g>
  )
}
