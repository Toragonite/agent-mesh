# 라우팅

`Fleet`은 어떤 어댑터(와 계정)가 작업을 실행할지 고릅니다. 라우팅은 모든 어댑터가
보고할 수 있는 세 신호에 대한 정책입니다: **쿼터 여유**, **도메인 강점**, **지연시간
클래스**.

```ts
const result = await fleet.run(
  { prompt: '이 모듈을 리팩터링해줘.' },
  { policy: { prefer: ['claude', 'codex'], quotaCeiling: 80 } },
)
```

## 신호

- **쿼터 여유** — 윈도우가 한도(`quotaCeiling`)에 가까운 계정은 건너뛰어, 긴 세션이 한
  로그인만 소진하고 다른 계정은 놀지 않게 합니다. 값은 각 어댑터의 `quota()`에서 옵니다.
- **강점** — 도메인별 우선순위. 기본은 정적 `prefer` 목록이며, 작업이 이를 재정의할 수
  있습니다.
- **지연시간** — `availableModels()`가 주는 `fast`/`slow`. 인터랙티브 작업은 `fast`,
  깊은 추론은 `slow`도 허용합니다.

## 전략

라우터는 정책으로 고르는 여러 전략을 제공합니다:

- **`prefer-order`**(기본) — 우선순위 목록을 훑어 쿼터 게이트를 처음 통과하는 어댑터.
- **`most-quota`** — 지금 남은 여유가 가장 많은 어댑터.
- **`lowest-latency`** — 적격한 것 중 가장 빠른 모델.

::: tip 설계 노트
기본 전략은 의도적으로 단순하고 예측 가능합니다. 어떤 전략을 기본으로 할지 — 그리고
도메인→벤더 강점 매핑 — 는 아직 튜닝 중인 제품 결정입니다.
:::

## 전부 게이트에 걸릴 때

모든 후보가 쿼터 한도를 넘으면, 라우터는 실패시키는 대신 첫 우선순위로
폴백합니다 — 워크플로우 중간에 하드 스톱하는 것보다 최선의 실행이 낫습니다.
이 폴백은 `route()`가 반환하는 `RouteDecision.note`에만 남습니다;
`Fleet.run()`은 곧바로 `RunResult`로 귀결되며 이를 버립니다. 이번 실행이
게이트로 인한 폴백이었는지 알아야 한다면, 직접 `route()`를 호출하고 선택된
어댑터를 실행하세요:

```ts
const decision = await fleet.route(task, { prefer: ['claude', 'codex'], quotaCeiling: 80 })
if (decision.note) {
  console.warn(decision.note) // 예: 모든 후보가 게이트됨, 최선의 폴백 실행
}
const result = await decision.adapter.run(task)
```

## `permissionMode`는 벤더마다 다릅니다

`RunTask.permissionMode`는 하위 CLI로 그대로 전달되며, 각 벤더가 자신만의
어휘를 정의합니다 — Claude Code는 `'acceptEdits'` 같은 값을, Codex는
`'workspace-write'` 같은 샌드박스 모드를 기대합니다. 따라서 Fleet이 라우팅한
작업에 `permissionMode`를 설정하면 벤더 간 이식성이 없습니다: 한 어댑터에서
성공하는 값이 다른 어댑터에서는 오류가 날 수 있습니다. 라우팅이 여러 벤더에
열려 있는 작업이 아니라, `task.account`로 특정 벤더를 고정한 작업에만
설정하세요.
