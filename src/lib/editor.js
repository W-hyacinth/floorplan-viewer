// 배치 모드 상태. holding 교체만 React에 알리고,
// 고스트 좌표(ghost)는 매 프레임 mutable로만 갱신한다(리렌더 금지).
let listeners = new Set()

export const editor = {
  holding: null, // { catalogId, rotationY, id } — id!=null이면 기존 가구 재배치
  ghost: { x: 0, z: 0, valid: false }, // cm, Ghost가 매 프레임 씀 / place가 읽음
}

export function setHolding(holding) {
  editor.holding = holding
  listeners.forEach(l => l())
}

export function rotateHolding() {
  if (editor.holding)
    editor.holding.rotationY = (editor.holding.rotationY + 90) % 360
}

export function subscribeEditor(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getEditorSnapshot() {
  return editor.holding
}
