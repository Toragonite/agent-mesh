# 어댑터

각 어댑터는 본인 로그인으로 한 벤더의 **공식 CLI**를 구동하며,
[Adapter 계약](/ko/guide/architecture)에 매핑합니다. 사용하는 것만 설치하세요.

## 상태

| 어댑터 | 패키지 | 구동 CLI | 상태 |
|---|---|---|---|
| Claude Code | `@toragonite/agent-mesh-claude` | `claude` | ✅ v0.1.0 |
| Codex | `@toragonite/agent-mesh-codex` | `codex` | ✅ v0.1.0 |
| Antigravity | `@toragonite/agent-mesh-gemini` | `agy` | ✅ v0.1.0 |
| Cursor | `@toragonite/agent-mesh-cursor` | `cursor-agent` | ✅ v0.1.0 |

네 어댑터 모두 구현이 끝났고 각자 벤더의 CLI를 대상으로 검증되었으며, 코어와
함께 v0.1.0으로 모두 배포됩니다. Antigravity와 Cursor는 넷 중 가장 최근에
추가된 어댑터라, 모델별 지연 시간 등급은 아직 잠정치입니다.

## Capabilities

모든 어댑터는 원샷 `run()`, 대화 id로 `resume()`, 토큰 사용량(필수 표면)을
지원합니다. 나머지는 어댑터마다 `capabilities`로 선언됩니다:

| 어댑터 | resume | steer | peerMesh | quota | stream |
|---|---|---|---|---|---|
| Claude Code | ✅ | `mid-run` | ✅ | ✅ | ✅ |
| Codex | ✅ | `turn` | — | ✅ | — |
| Antigravity | ✅ | `turn` | — | — | ✅ |
| Cursor | ✅ | `turn` | — | — | ✅ |

Antigravity와 Cursor는 둘 다 `quota: false`입니다 — 두 벤더 모두 검증된 사용량
엔드포인트를 노출하지 않으므로, `quota()`는 스냅샷을 임의로 만들어내는 대신
의도적으로 `null`을 반환합니다(각 어댑터 페이지의 쿼터 절 참고).

## Claude Code

Anthropic의 CLI. 네이티브 **피어 메시**를 가진 유일한 어댑터 — 세션끼리 서로 깨우고
조종할 수 있습니다. 앞서 만든 `@toragonite/claude-mesh` 작업을 흡수합니다.
자세한 내용은 [Claude Code 어댑터 페이지](/ko/adapters/claude-code)를 참고하세요.

## Codex

OpenAI의 CLI. `resume()`을 통한 턴 단위 조종. 모델 선택은 인증 모드에 따라 달라지며
(ChatGPT 로그인과 API 키가 서로 다른 모델셋을 노출), `availableModels()`가 이를
반영합니다. 자세한 내용은 [Codex 어댑터 페이지](/ko/adapters/codex)를 참고하세요.

## Antigravity

Google의 소비자용 코딩 에이전트(`agy`)입니다. 정적 모델 카탈로그(세 항목은
다른 벤더의 모델을 리셀), `stream()` 지원, 대화 id 재개를 통한 수정을
제공합니다. `quota()`는 의도적으로 `null`을 반환합니다. 자세한 내용은
[Antigravity 어댑터 페이지](/ko/adapters/gemini)를 참고하세요.

## Cursor

Cursor의 CLI로, Cursor 네이티브 모델과 리셀 모델(Composer, Grok 등)로 구성된
라이브·메모이즈 카탈로그를 구동합니다. 헤드리스 실행은 기본적으로 `trust:
true`를 사용해 워크스페이스 신뢰 프롬프트로 실행이 멈추지 않게 합니다.
`quota()`는 의도적으로 `null`을 반환합니다. 자세한 내용은 [Cursor 어댑터
페이지](/ko/adapters/cursor)를 참고하세요.

::: warning 비공식
agent-mesh는 Anthropic, OpenAI, Google, Cursor와 제휴 관계가 없습니다. 각 어댑터는 본인
계정으로 해당 벤더의 공식 CLI를 사용하며, 사용자는 각 벤더의 약관을 준수해야 합니다.
:::
