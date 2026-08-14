# 시작하기

> **상태:** 코어 계약은 동결되었습니다. `@toragonite/agent-mesh-claude`,
> `@toragonite/agent-mesh-codex`, `@toragonite/agent-mesh-gemini`,
> `@toragonite/agent-mesh-cursor` 네 어댑터 모두 코어와 함께 v0.1.0으로
> 배포됩니다. 자세한 내용은 [어댑터](/ko/adapters/)를 참고하세요.

## 설치

코어와 필요한 어댑터를 함께 설치합니다:

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-claude @toragonite/agent-mesh-codex
```

코어는 벤더 의존성이 없습니다. 각 어댑터는 해당 벤더의 **공식 CLI**를 구동하므로,
그 CLI가 머신에 설치되고 로그인되어 있어야 합니다.

## 첫 실행

어댑터를 둘 이상 등록하고 `Fleet`이 작업을 라우팅하게 둡니다:

```ts
import { Fleet } from '@toragonite/agent-mesh'
import { ClaudeAdapter } from '@toragonite/agent-mesh-claude'
import { CodexAdapter } from '@toragonite/agent-mesh-codex'

const fleet = new Fleet()
  .register(new ClaudeAdapter())
  .register(new CodexAdapter())

const result = await fleet.run(
  { prompt: '쿼터에 관한 하이쿠를 써줘.' },
  { policy: { prefer: ['claude', 'codex'] } },
)

console.log(result.vendor)          // 실제로 실행한 어댑터
console.log(result.text)            // 최종 답변
console.log(result.conversationId)  // resume()에 넘길 값
```

`policy.prefer`는 그 순서를 훑어 쿼터 한도 안에 있는 첫 어댑터를 고릅니다
(기본 전략인 `prefer-order`) — 다른 전략은 [라우팅](/ko/guide/routing)을
참고하세요.

## 수정하기

```ts
const revised = await fleet.resume(
  result.vendor,
  result.conversationId,
  '대신 레이트리밋에 관한 내용으로 바꿔줘.',
)
```

## 남은 쿼터 읽기

```ts
const snapshot = await fleet.get('claude')?.quota()
// { vendor: 'claude', allowed: true, windows: [{ label, usedPercent, resetAt }] }
```

쿼터 조회는 **본인** 런타임에서 **본인** 로그인으로 이뤄집니다 — 프록시가 없습니다.

## 다음

- [어댑터](/ko/adapters/) — 어댑터별 설치 방법과 옵션.
- [아키텍처](/ko/guide/architecture) — Adapter 계약과 capabilities.
- [라우팅](/ko/guide/routing) — 플릿이 작업마다 벤더를 고르는 방식.
