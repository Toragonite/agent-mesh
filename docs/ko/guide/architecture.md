# 아키텍처

agent-mesh는 **얇은 코어**와 **벤더별 어댑터**로 구성됩니다. 코어는 벤더별 세부사항을
전혀 모르며, 각 어댑터가 한 벤더의 공식 CLI를 구동하는 법을 코어에 알려줍니다.

## 다섯 가지 공통 표면

오케스트레이션할 가치가 있는 헤드리스 코딩 에이전트는 모두 같은 형태를 노출합니다.
그 형태 — 특정 벤더가 아니라 — 를 `Adapter` 인터페이스가 동결합니다:

| 표면 | 메서드 |
|---|---|
| 원샷 실행 → 최종 텍스트 + 대화 id | `run(task)` |
| 기존 대화 이어가기 / 수정 | `resume(id, message)` |
| 실행별 토큰 사용량 | `RunResult.usage` |
| 남은 쿼터 | `quota(account)` |
| 현재 로그인이 고를 수 있는 모델 | `availableModels(account)` |

두 가지 기능은 선택적이며 어댑터별로 선언됩니다: 실행 중 **조종(steer)**과 네이티브
**피어 메시(peer mesh)**.

## Adapter 인터페이스

```ts
interface Adapter {
  readonly vendor: Vendor
  readonly capabilities: AdapterCapabilities

  authStatus(account?: Account): Promise<AuthStatus>
  availableModels(account?: Account): Promise<ModelInfo[]>
  quota(account?: Account): Promise<QuotaSnapshot | null>

  run(task: RunTask): Promise<RunResult>
  resume(conversationId: string, message: string, opts?: ResumeOptions): Promise<RunResult>

  stream?(task: RunTask): AsyncIterable<RunEvent>
  steer?(conversationId: string, message: string): Promise<void>
  stop?(conversationId: string): Promise<void>
}
```

`quota()`는 값을 정말 알 수 없을 때(미로그인, 엔드포인트 불가) `null`을 반환하며,
"모름"을 이유로 예외를 던지지 않습니다. 덕분에 라우팅이 단순해집니다 — 스냅샷이
없으면 "여유를 확인할 수 없음"이지 "크래시"가 아닙니다.

## Capabilities는 어댑터가 무엇을 할 수 있는지 알릴 뿐 — 확인은 호출자의 몫

```ts
interface AdapterCapabilities {
  resume: boolean
  steer: 'mid-run' | 'turn' | 'none'
  peerMesh: boolean
  quota: boolean
  stream: boolean
}
```

Fleet 자체는 `capabilities`를 전혀 읽지 않습니다 — 라우팅은 오직 쿼터 여유,
`policy.prefer` 순서, `policy.latency`([라우팅](/ko/guide/routing) 참고)로만
결정됩니다. 선택된 어댑터가 실제로 실행 중 조종이나 스트리밍을 할 수 있는지는
**호출자**의 몫입니다: `steer()`나 `stream()`을 부르기 전에 직접
`capabilities.steer === 'mid-run'` / `capabilities.stream`을 확인하거나 —
`@toragonite/agent-mesh`가 내보내는 `canSteer`/`canStream` 타입 가드를
사용하세요. 어댑터가 진짜 실행 중 조종을 못 하면 `resume()`으로 턴 사이에
수정하는 쪽으로 폴백하세요.

## 계정과 격리

`Account`는 로그인을 지칭하며, 선택적으로 격리된 설정 디렉터리(`CLAUDE_CONFIG_DIR`,
`CODEX_HOME` 등)를 가집니다. 생략하면 앰비언트 CLI 로그인을 사용합니다. 한 벤더가 여러
계정을 가질 수 있고 각자 쿼터가 따로인데 — 그게 바로 핵심입니다.
