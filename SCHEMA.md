# 씬 JSON 스키마 v0 — 좌표계 규칙 (1일차 확정본)

> 이 문서가 이 프로젝트의 심장. 에디터·뷰어 어느 쪽도 이 규칙을 어기면 안 된다.
> 2D↔3D 변환 코드는 `src/lib/units.js`의 `toWorld()` **한 곳에만** 존재한다.

## 좌표계

| 항목 | 규칙 |
|---|---|
| 단위 | **cm** (JSON 안의 모든 길이·좌표) |
| 평면 | **xz 평면**. 2D 도면에서 +x = 오른쪽(동), +z = 아래(남) |
| 3D 변환 | 뷰어(three.js)는 **y-up, 미터**. `world = (x/100, y/100, z/100)` — x·z 부호 그대로 (미러링 없음) |
| 원점 | 씬마다 자유. 관례상 도면 좌상단 부근 (0,0) |
| 회전 | `rotationY` = **도(degree)**. three.js `rotation.y`와 동일 부호 → **2D 도면(z 아래) 기준 반시계(CCW)가 양수** |
| 정면 | `rotationY: 0`일 때 아이템 정면은 **-z** (도면에서 위쪽/북쪽) |

회전 빠른표 (도면에서 정면이 향하는 방향): `0`=북(위) · `90`=서(왼쪽) · `-90` 또는 `270`=동(오른쪽) · `180`=남(아래)

## 씬 JSON 구조

```jsonc
{
  "version": 0,
  "name": "demo-apartment",
  "wallHeight": 250,              // 기본 벽 높이 cm (벽별 height로 덮어쓰기 가능)
  "spawn": { "x": 250, "z": 380, "yawDeg": 0 },   // 플레이어 시작 위치·방향(rotationY와 같은 규약)
  "walls": [
    {
      "from": { "x": 0, "z": 0 },
      "to":   { "x": 800, "z": 0 },
      "thickness": 15,            // cm, 선분 중심 기준 양쪽으로 절반씩
      "openings": [               // 벽에 뚫린 문·창
        {
          "type": "door",         // door=통과 가능 / window=통과 불가
          "offset": 340,          // from→to 방향으로 개구부 시작점까지 거리 cm
          "width": 100,
          "height": 210,
          "sillHeight": 0         // 바닥에서 개구부 하단까지. 생략 시 door=0, window=90
        }
      ]
    }
  ],
  "floors": [                     // 사각형만. **생략하면 벽 바운딩박스로 자동 생성**
    { "x": 0, "z": 0, "w": 800, "d": 500, "material": "wood" }
  ],
  "zones": [                      // 출입금지 구역 — 3D·미니맵에선 벽과 같은 막힌 덩어리로 보임(금지구역임을 드러내지 않음).
    { "id": "zone-abc", "x": 300, "z": 100, "w": 150, "d": 120 }   // 진입 불가 + 내부 가구는 상호작용·조명 비활성. 붉은 표시는 어드민 에디터 전용.
  ],
  "lights": [                     // 천장 조명 패널 (시각 전용, 충돌·실광원 없음. w/d 생략 시 120×60)
    { "x": 460, "z": 800, "w": 120, "d": 60 }
  ],
  "underlay": {                   // 도면 이미지 밑그림 (에디터용, dataURL이라 JSON 용량 큼)
    "src": "data:image/png;base64,...",
    "x": 0, "z": 0, "widthCm": 1000, "heightCm": 700, "ratio": 0.7,
    "opacity": 0.5, "visible": true
  },
  "customCatalog": {              // 에디터에서 만든 커스텀 가구 타입 (내보내기 시 포함, 불러오면 병합)
    "c-abc": { "name": "회의용 의자", "size": { "w": 55, "d": 55, "h": 90 }, "color": "#5d6875",
               "interactions": { "sit": { "height": 46 } } }
  },
  "items": [
    {
      "id": "sofa-1",             // 인스턴스 id (씬 안 유일)
      "catalogId": "sofa",        // 생김새·크기는 카탈로그가 보유
      "position": { "x": 70, "z": 250 },   // 풋프린트 **중심**, 바닥 기준
      "rotationY": -90
    }
  ]
}
```

## 카탈로그 JSON 구조 (`public/catalog/catalog.json`)

```jsonc
{
  "items": {
    "sofa": {
      "name": "소파",
      "size": { "w": 200, "d": 90, "h": 78 },  // cm. w=로컬x, d=로컬z(정면방향), h=높이
      "color": "#6f8aa5"                        // Phase 0은 컬러 박스. Phase 2+에서 glb 필드 추가
    }
  }
}
```

- 가구 인스턴스는 `catalogId + position + rotationY`만 저장. 크기·색·(미래의)GLB는 카탈로그 소유.
- **상호작용(affordance)도 카탈로그 소유** — 씬 JSON은 그대로 두고 카탈로그에만 추가한다:

```jsonc
"interactions": {
  "sit":    { "height": 45 },      // E로 앉기. height=앉는 면 높이 cm (앉은 시선 = height+70)
  "toggle": { "what": "light" }    // E로 온오프 (Phase 0.5: floor_lamp 조명)
}
```

뷰어의 상호작용 규칙: 크로스헤어 레이캐스트, 사거리 2.2m, E키 실행. 앉은 상태에선 E로만 일어남(시선은 자유).
- GLB 등록 시 정규화 강제: **원점=바닥 중심, 정면=-z**, Draco 압축 1~2MB 이하. (박스 규약과 동일하게 맞춰 교체 비용 0)

## 뷰어 물리 상수 (스키마는 아니지만 체감 결정 요소)

- 시선 높이 **160cm**, 이동 **1.4 m/s** (Shift 달리기 2.8 m/s)
- 플레이어 = 반지름 **30cm** 원기둥 (2D 원 충돌)
- 벽 충돌 = 선분 vs 원 (door 개구부 구간만 통과 허용, window는 차단)
- 가구 충돌 = 회전 바운딩박스 vs 원. 물리엔진 금지.
