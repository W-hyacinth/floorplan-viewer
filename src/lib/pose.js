// 플레이어 현재 위치/방향 (도면 cm 좌표). Player가 매 프레임 쓰고
// 미니맵이 rAF로 읽는다 — React 상태 아님(프레임당 리렌더 방지).
export const pose = { x: 0, z: 0, dx: 0, dz: -1 }
