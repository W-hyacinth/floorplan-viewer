// 씬에 배치된 모든 가구의 3D 오브젝트 레지스트리
// (Item이 등록 / Player가 E·G·X 레이캐스트에 사용)
export const itemObjects = new Map() // id -> { item, cat, object, toggle? }

export function registerItemObject(id, entry) {
  entry.object.userData.itemId = id
  itemObjects.set(id, entry)
  return () => itemObjects.delete(id)
}

// 레이캐스트 히트 메시에서 등록된 조상 엔트리 찾기
export function findEntryFromHit(object) {
  let o = object
  while (o) {
    const id = o.userData?.itemId
    if (id !== undefined) return itemObjects.get(id)
    o = o.parent
  }
  return null
}
