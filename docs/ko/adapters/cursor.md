# Cursor

Cursor 어댑터는 Cursor의 공식 `cursor-agent` CLI를 [Adapter
계약](/ko/guide/architecture) 뒤에서 헤드리스로 구동합니다: 원샷 실행에는
`cursor-agent -p --output-format json`, 대화 수정에는 `--resume <id>`, 증분
이벤트에는 `-p --output-format stream-json --stream-partial-output`을 사용하며
— 모두 본인 Cursor 로그인으로 동작합니다.

::: warning 비공식
Cursor와 제휴하거나, 그로부터 승인받거나, 지원받지 않습니다. 이 패키지는 본인
로그인으로 벤더의 공식 `cursor-agent` CLI를 그대로 실행합니다. 자격증명
공유도, 사칭도, 레이트리밋 우회도 없습니다.
:::

## 설치

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-cursor
```

Node ≥ 18.17과, `PATH`상에서 로그인된 `cursor-agent`가 필요합니다
(`cursor-agent status`가 `✓ Logged in as …`를 출력해야 합니다).

## 옵션

`new CursorAdapter(options?)` — 모든 옵션은 실제 구현으로 기본 설정되며
테스트를 위해 재정의할 수 있습니다:

| 옵션 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `exec` | `ExecFn` | `nodeExec` | 완료까지 실행하는 프로세스 seam. |
| `lineStream` | `LineStreamFn` | `nodeLineStream` | `stream()`을 뒷받침하는 스트리밍 프로세스 seam. |
| `binary` | `string` | `'cursor-agent'` | cursor-agent 실행 파일 경로 또는 명령 이름. |
| `defaultAccount` | `Account` | — | 호출이 계정을 넘기지 않을 때 사용할 계정. |
| `env` | `Record<string, string \| undefined>` | `process.env` | 환경 변수 seam — 모든 자식 프로세스 환경의 기반. |
| `trust` | `boolean` | `true` | `--trust`를 전달할지 여부. [trust 옵션](#trust-옵션) 참고. |
| `models` | `ModelInfo[]` | — | 라이브 `cursor-agent models` 조회를 건너뜁니다(오프라인 사용, hermetic 테스트, 또는 고정 카탈로그). |
| `authTimeoutMs` | `number` | `20000` | `authStatus()` CLI 프로브의 최대 대기 시간. |
| `modelsTimeoutMs` | `number` | `20000` | `availableModels()` CLI 프로브의 최대 대기 시간. |

## 실행과 재개

```ts
import { Fleet } from '@toragonite/agent-mesh'
import { CursorAdapter } from '@toragonite/agent-mesh-cursor'

const fleet = new Fleet().register(new CursorAdapter())

// Cursor는 플릿에서 가장 느린 벤더입니다(한 단어 답변에 약 30초) — timeoutMs를
// 넉넉하게 설정하세요(아래 지연시간 참고).
const result = await fleet.run(
  { prompt: 'Summarize the changes in this repo.', cwd: process.cwd(), timeoutMs: 120_000 },
  { policy: { prefer: ['cursor'] } },
)
console.log(result.text, result.conversationId)

// 같은 대화를 이어갑니다.
const followUp = await fleet.resume('cursor', result.conversationId, 'Now list the risks.')
console.log(followUp.text)
```

어댑터를 직접 사용할 수도 있습니다:

```ts
const cursor = new CursorAdapter()
const r = await cursor.run({ prompt: 'hello', timeoutMs: 120_000 })
const r2 = await cursor.resume(r.conversationId, 'again')
```

`resume()`은 스폰하기 전에 `-`로 시작하는 `conversationId`를 거부합니다 — 그런
형태는 세션 id가 아니라 CLI 플래그로 읽히기 때문입니다.

## 스트림

```ts
for await (const ev of cursor.stream({ prompt: 'Explain this file.', timeoutMs: 120_000 })) {
  switch (ev.type) {
    case 'text':  process.stdout.write(ev.text); break        // 점진적인 답변 델타
    case 'usage': console.log('\n', ev.usage); break           // 토큰 사용량
    case 'done':  console.log('\n', ev.result.status); break   // 최종 RunResult
    case 'error': console.error(ev.message); break
  }
}
```

CLI는 점진적인 `assistant` 델타를 내보낸 뒤, 마지막에 완전한 답변을 반복하는
`assistant` 이벤트를 하나 더 내보냅니다. 어댑터는 그 반복을 억제합니다
(`timestamp_ms`가 없고, 텍스트가 지금까지 누적된 답변과 같다는 두 조건으로
확인합니다) — 그래서 연결된 `text` 이벤트는 답변을 정확히 한 번만 담습니다.
타임아웃은 부분 텍스트를 담은 `status: 'incomplete'`인 `done` 이벤트로
스트림을 끝냅니다(`run()`과 마찬가지로 절대 `error` 이벤트가 아닙니다). 결과
없이 종료 코드가 0이 아니거나 trust 거부가 발생하면 `error` 이벤트로
끝납니다.

### thinking 이벤트는 버려집니다(알려진 한계)

스트림에는 `thinking` 이벤트가 포함되어 있습니다. 코어 `RunEvent` 타입에는
thinking 채널이 없고, 추론 텍스트를 `text`에 섞으면 답변이 오염되므로
`thinking` 이벤트는 **건너뜁니다**. 이는 실수가 아니라 코어 계약 개정을
기다리는 의도적인 한계입니다.

## `trust` 옵션

`cursor-agent`는 작업을 **워크스페이스 신뢰(workspace-trust)** 검사 뒤에
둡니다. 신뢰되지 않은 디렉터리에서는 멈추지 않고 약 21초 후 `⚠ Workspace Trust
Required`로 **종료**됩니다.

이 어댑터는 기본값으로 `trust: true`를 사용해 `--trust`를 전달합니다. 근거:
**호출자**가 고른 디렉터리에서 헤드리스 에이전트를 구동하는 라이브러리가
작업당 약 21초씩 인터랙티브 trust 프롬프트로 멈춰서는 안 됩니다 — **그
`cwd`에서 코딩 에이전트를 실행하기로 한 선택 자체가 이미 trust 결정**입니다.

```ts
new CursorAdapter()                  // trust: true  → --trust 전달(기본값)
new CursorAdapter({ trust: false })  // --trust를 보내지 않음; 거부가 그대로 드러남
```

`--force`/`--yolo`는 **다르고 더 강력한** 허가입니다("모든 것을 실행"). 이
어댑터는 이를 절대 전달하지 않고 기본값으로도 노출하지 않습니다. `trust:
false` 상태에서 CLI가 거부하면, `run()`은 `cwd`를 명시하고 `{ trust: true
}`(또는 Cursor에서 해당 디렉터리를 신뢰 설정)를 안내하는 `AdapterExecError`를
던지고, `stream()`은 같은 내용을 `error` 이벤트로 드러냅니다.

## 모델: 라이브 조회와 메모이즈

`cursor-agent models`는 약 193개의 `id - Display Name` 항목을 나열합니다 —
하드코딩하기에는 너무 많고 너무 자주 바뀝니다. 그래서 `availableModels()`는
CLI를 통해 **라이브** 목록을 읽고 인스턴스에 **메모이즈**합니다(반복되는
`Fleet.route()` 호출이 다시 스폰하지 않습니다). 실패하면(스폰 오류, 타임아웃,
빈 출력) 작은 큐레이션된 정적 목록(`auto`, `composer-2.5`,
`cursor-grok-4.5-high`, `cursor-grok-4.5-high-fast`)으로 대체되어,
`availableModels()`는 **절대 예외를 던지지 않고** 오프라인에서도 라우팅이
동작합니다.

이는 카탈로그가 정적인 Gemini 어댑터와 의도적으로 다릅니다: Gemini는 소수의
안정적인 항목뿐이지만, Cursor는 193개의 변동성 큰 항목입니다.

서브프로세스를 아예 건너뛰려면(오프라인 사용 또는 고정 카탈로그) `models`를
넘기세요:

```ts
new CursorAdapter({ models: [{ id: 'auto', latencyClass: 'fast', default: true }] })
```

**네이티브 vs 리셀.** `auto`이거나 `composer` 또는 `cursor-`로 시작하는 id는
Cursor 네이티브입니다. 그 외의 모든 id는 다른 벤더의 모델을 리셀합니다. 리셀
항목에는 선택 시 Cursor가 아니라 그 벤더의 쿼터를 소모한다는 `label` 경고가
붙습니다 — 이는 멀티 벤더 플릿의 취지를 무색하게 합니다. `auto`는 기본값으로
표시되며(CLI가 현재 기본값으로 보고합니다), 라우터가 스스로 리셀된 프론티어
모델을 고를 수 있다는 점이 label에 안내됩니다.

**지연시간**은 잠정적인 휴리스틱입니다(미측정): id에 `xhigh`, `high`,
`thinking`, `max`, `opus` 중 하나가 포함되면 `slow`로, 그 외에는 `fast`로
분류됩니다.

**파라미터화된 모델 id**는 그대로(verbatim) 전달되므로, CLI의 파라미터화된
형태가 그대로 동작합니다:

```ts
await cursor.run({ prompt: '…', model: 'claude-opus-4-8[context=1m,effort=high,fast=false]' })
```

해석된 카탈로그에 없는 `model`(파라미터화된 형태 포함 — 이런 형태는 어떤 id와도
매치되지 않습니다)도 그대로 **실행**됩니다 — `model <id> not in known
catalog`라는 `RunResult.note`가 붙을 뿐, 막히지 않습니다.

## `createChat()`

`createChat()`은 `cursor-agent create-chat`을 실행해 얻은 순수 UUID를
반환합니다(어떤 실패에도 `null` — 절대 예외를 던지지 않습니다). 첫 실행 전에
대화 id를 미리 발급하려면 이렇게 사용하세요:

```ts
import { createChat } from '@toragonite/agent-mesh-cursor'

const chatId = await createChat()
if (chatId) await cursor.resume(chatId, 'first message')
```

## 인증

`authStatus()`는 `cursor-agent status`를 실행합니다(`~/.cursor/cli-config.json`에는
UI/모델 설정만 있고 인증 상태는 없으므로 파일 읽기로는 답할 수 없습니다). 성공한
`✓ Logged in as someone@example.com`은 `{ loggedIn: true, mode: 'cursor',
detail: 'someone@example.com' }`을 반환합니다. 0이 아닌 종료 코드, 바이너리
없음, 또는 타임아웃은 `{ loggedIn: false }`를 반환합니다. 절대 예외를 던지지
않고 토큰 정보를 노출하지 않습니다.

## 쿼터

`quota()`는 무조건 `null`을 반환하며, `capabilities.quota`는 `false`입니다.
Cursor는 검증된 사용량 엔드포인트를 노출하지 않습니다. `{ allowed: true,
windows: [] }`를 임의로 만들어 반환하면 Fleet의 라우터에게 소진된 계정이
여유가 가득 있다고 알리는 셈이 됩니다. `null`은 정직한 "헤드룸 알 수 없음"
신호입니다 — Fleet은 이를 "제외되지 않음"으로 취급하므로 Cursor 어댑터는
여전히 라우팅 대상이 되지만, 실제 사용량을 보고하는 벤더와 쿼터 기준으로
비교되지는 않습니다.

## 참고사항

- **`allowedTools`**는 `cursor-agent`에 대응하는 기능이 없어 무시되며, 결과에
  `allowedTools not supported by cursor-agent; ignored` 주석이 남습니다.
- **`account.configDir`**은 지원되지 않습니다(`cursor-agent`에는 config-dir
  환경 변수가 없습니다) — 무시되며 `account.configDir is not supported by
  cursor-agent; ignored` 주석이 남습니다. 여러 주석은 `'; '`로 이어붙입니다.
- **지연시간.** 한 단어 답변에 **약 30초**가 걸립니다 — Cursor는 이 저장소에서
  가장 느린 벤더입니다. `timeoutMs`를 그에 맞게 설정하세요(위 예제는 120초를
  사용합니다).
