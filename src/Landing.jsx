const BASE = import.meta.env.BASE_URL
const GITHUB_URL = 'https://github.com/W-hyacinth/floorplan-viewer'
const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches

export function Landing() {
  return (
    <div className="landing">
      <main className="landing-inner">
        <header className="landing-hero">
          <p className="landing-eyebrow">floorplan-viewer</p>
          <h1>어드민이 2D 도면을 그리면,<br />고객이 3D로 걸어본다</h1>
          <p className="landing-sub">
            공유오피스 홈페이지를 만들면서 아쉬웠던 게 하나 있었어요. 지점 소개가 사진 몇 장과
            평면도 한 장으로 끝난다는 것. 그래서 운영자가 도면을 그리면 그대로 고객용
            3D 투어가 되는 빌더를 만들었습니다. 에디터와 뷰어는 씬 JSON 스키마 하나로 연결됩니다.
          </p>
          {IS_TOUCH && (
            <p className="landing-touch-note">
              지금 터치 기기로 보고 계시네요 — 3D 투어는 궤도 둘러보기로 열리고,
              1인칭 걷기는 데스크톱(키보드+마우스)에서 체험할 수 있어요.
            </p>
          )}
          <div className="landing-cta">
            <a className="cta cta-primary" href={`${BASE}?viewer=1`}>
              🚶 고객 모드 — 3D 투어 시작
            </a>
            <a className="cta cta-secondary" href={`${BASE}?mode=admin`}>
              🛠️ 어드민 모드 — 2D 도면 에디터
            </a>
          </div>
        </header>

        <a href={`${BASE}?viewer=1`} className="landing-shot">
          <img src={`${BASE}og.jpg`} alt="공유오피스 데모 지점의 3D 워크스루 화면 — 세이지색 파티션과 데스크, 천장 조명 패널이 보이는 1인칭 시점" />
          <span className="shot-caption">고객 모드 · 1인칭 워크스루 (WASD + 마우스)</span>
        </a>

        <section className="landing-section">
          <h2>어떻게 동작하나요</h2>
          <ol className="landing-steps">
            <li>
              <strong>1 · 어드민이 도면을 그립니다.</strong> 벽을 클릭-클릭으로 잇고, 카탈로그에서
              가구를 골라 드래그하고, 출입금지 구역을 지정합니다. 도면 이미지를 밑그림으로 깔 수도 있어요.
            </li>
            <li>
              <strong>2 · 씬이 JSON으로 저장됩니다.</strong> 벽·문·창·가구·금지구역이 전부
              구조화된 데이터입니다. 에디터와 뷰어 어느 쪽도 이 스키마 계약을 어기지 않습니다.
            </li>
            <li>
              <strong>3 · 고객이 3D로 체험합니다.</strong> 같은 데이터가 그대로 1인칭 워크스루가
              됩니다. 문으로만 드나들 수 있고, 의자에 앉아보고, 조명을 켜볼 수 있어요.
            </li>
          </ol>
        </section>

        <a href={`${BASE}?mode=admin`} className="landing-shot">
          <img src={`${BASE}shot-editor.jpg`} alt="2D 도면 에디터 화면 — 왼쪽 가구 카탈로그, 가운데 공유오피스 평면도, 붉은 빗금의 출입금지 구역" />
          <span className="shot-caption">어드민 모드 · 2D 도면 에디터 (지금 보는 데모 씬도 이 에디터로 그렸습니다)</span>
        </a>

        <section className="landing-section">
          <h2>조작법</h2>
          <div className="landing-controls">
            <table>
              <caption>3D 투어 (고객 모드)</caption>
              <tbody>
                <tr><th>화면 클릭</th><td>시작 (마우스 잠금)</td></tr>
                <tr><th>W A S D</th><td>걷기 · <kbd>Shift</kbd> 달리기</td></tr>
                <tr><th>마우스</th><td>시선</td></tr>
                <tr><th>E</th><td>의자 앉기 · 조명 켜고 끄기</td></tr>
                <tr><th>ESC</th><td>마우스 잠금 해제</td></tr>
              </tbody>
            </table>
            <table>
              <caption>2D 에디터 (어드민 모드)</caption>
              <tbody>
                <tr><th>드래그</th><td>가구 이동 · <kbd>R</kbd> 회전 · <kbd>Delete</kbd> 삭제</td></tr>
                <tr><th>카탈로그 클릭</th><td>가구 추가 (커스텀 가구 제작 가능)</td></tr>
                <tr><th>벽 그리기</th><td>클릭-클릭 연속 · 금지구역 드래그 지정</td></tr>
                <tr><th>JSON</th><td>씬 내보내기 · 불러오기</td></tr>
                <tr><th>Tab</th><td>도면 ↔ 3D 즉시 전환</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="landing-section">
          <h2>만듦새</h2>
          <ul className="landing-facts">
            <li><strong>React 18 + React Three Fiber.</strong> 외부 의존성은 three · drei까지 5개뿐입니다.</li>
            <li><strong>물리엔진 없는 자체 충돌.</strong> 평면 이동에는 원 vs 선분·회전박스 2D 충돌이면 충분해서, 수백 KB의 물리엔진 대신 직접 구현했습니다.</li>
            <li><strong>캔버스 라이브러리 없는 SVG 에디터.</strong> 도면 좌표와 SVG 좌표를 1:1로 맞춰 변환 계층을 없앴습니다.</li>
            <li><strong>cm → m 좌표 변환은 단 한 곳.</strong> 2D와 3D의 좌표계 규칙을 문서(SCHEMA.md)로 먼저 정하고, 변환 코드를 한 지점에 강제해 거울상 버그를 원천 차단했습니다.</li>
            <li><strong>60fps 루프와 React 렌더 분리.</strong> 매 프레임 데이터는 mutable 스토어로, UI 갱신은 useSyncExternalStore로 필요할 때만.</li>
          </ul>
          <p className="landing-links">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub에서 코드 보기 →</a>
            <a href={`${BASE}?viewer=1&scene=demo`}>다른 씬(아파트)도 걸어보기 →</a>
          </p>
          <p className="landing-note">
            알려진 제한: 문·창 편집은 아직 JSON에서만 가능합니다 · 모바일 1인칭 걷기는 준비 중입니다.
          </p>
        </section>
      </main>
    </div>
  )
}
