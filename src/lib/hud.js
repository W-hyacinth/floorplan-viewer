// Canvas 안(3D)에서 밖(HTML HUD)으로 프롬프트를 내보내는 최소 스토어
let listeners = new Set()
let snapshot = { prompt: null, tone: 'info' }

export function setPrompt(prompt, tone = 'info') {
  if (snapshot.prompt === prompt && snapshot.tone === tone) return
  snapshot = { prompt, tone }
  listeners.forEach(l => l())
}

export function subscribeHud(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getHudSnapshot() {
  return snapshot
}
