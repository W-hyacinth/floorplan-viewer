# floorplan-viewer

**어드민이 2D 도면에서 배치 → 고객이 3D로 게임하듯 체험**하는 뷰어.

## 실행

```bash
npm install
npm run dev
# → http://localhost:5173
# ?scene=이름   → public/scenes/이름.json 로드
# ?viewer=1    → 고객용: 3D 체험만, 도면 편집 접근 불가
```

**2D 도면(어드민, 기본 화면)**: 가구 드래그·R 회전·Delete 삭제 / 카탈로그 클릭=추가 / **커스텀 가구 만들기**(이름·크기·색·앉기) / **벽 그리기**(클릭-클릭 연속) / **🚫 금지구역**(드래그 지정→3D 진입 불가) / **도면 이미지** 밑그림(실제 폭 cm 보정) / 시작 마커 드래그 / JSON 불러오기·내보내기(커스텀 타입 포함) / Tab=3D 전환

**3D 체험(고객)**: 화면 클릭=시작 · WASD 이동 · 마우스 시선 · Shift 달리기 · **E 상호작용**(의자·소파·침대·스툴 앉기, 스탠드 조명 토글) · ESC 해제. 벽·가구·금지구역 충돌. **우상단 미니맵**에 현재 위치·시선 방향 표시.

⚠️ 탭이 백그라운드면 rAF가 멈춰 캔버스가 안 그려진다(버그 아님). 자동 검증은 chrome-devtools MCP 별도 창으로.

## 구조

```
SCHEMA.md               좌표계 규칙 + 씬/카탈로그 JSON 스키마 v0 ← 심장
public/scenes/demo.json 손으로 쓴 데모 씬 (거실+침실, 문 2·창 2, 가구 14)
public/catalog/catalog.json  가구 카탈로그 (Phase 0 = 컬러 박스 10종)
src/lib/units.js        cm·xz ↔ m·y-up 변환 (toWorld는 여기 한 곳에만)
src/lib/collision.js    씬→콜라이더 빌드 + 원vs선분/회전박스 충돌 (물리엔진 없음)
src/viewer/Scene.jsx    벽(개구부 쪼개기)·바닥·천장·가구 렌더
src/viewer/Player.jsx   1인칭 이동 (시선 160cm, 1.4m/s, 반지름 30cm)
```

## Phase 0 go/no-go 체크리스트

- [ ] 문으로만 방을 오갈 수 있다 (벽·창은 뚫리지 않는다)
- [ ] 가구에 막힌다 / 코너에서 떨리지 않는다
- [ ] 정면 마커(가구 바닥의 어두운 띠)가 SCHEMA.md 회전표와 일치한다 — 거울상 버그 검증
- [ ] 걸어다니는 게 "재밌다" (이게 no-go 기준)
- [ ] 의자 겨눠 E로 앉기 → 시점 낮아지고 E로 복귀 / 스탠드 E로 조명 온오프

## 로드맵

Phase 0 ✅면 → Phase 1 MVP 에디터(React+Konva, 사각방+가구 드래그 90도 스냅) → Phase 2 자유 벽·문창·재질(GLB) → Phase 3 카탈로그 어드민·조명베이킹·모바일 둘러보기 모드.
