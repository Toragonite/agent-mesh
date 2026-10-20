# Codex

Codex 어댑터는 OpenAI의 공식 `codex` CLI를 [Adapter 계약](/ko/guide/architecture)
뒤에서 헤드리스로 구동합니다: 원샷 실행, 대화 id로 재개, 인증 모드 게이팅이 적용된
모델 조회, 런타임 로컬 쿼터 조회를 제공합니다.

::: warning 비공식
OpenAI와 제휴하거나 그로부터 승인받지 않았습니다. 이 패키지는 본인 로그인으로
로컬 `codex` CLI를 구동합니다 — 자격증명 공유도, 레이트리밋 우회도 없습니다.
:::

## 설치

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-codex
```

`codex` CLI가 설치되고 로그인(ChatGPT 로그인 또는 `OPENAI_API_KEY`)되어 있어야
합니다. Node.js ≥ 18.17.

## 옵션

`new CodexAdapter(options?)` — 모든 옵션은 실제 구현으로 기본 설정되며 테스트를
위해 재정의할 수 있습니다:

| 옵션 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `exec` | `ExecFn` | `nodeExec` | 프로세스 실행 seam. |
| `binary` | `string` | `'codex'` | CLI 실행 파일 이름/경로. |
| `defaultAccount` | `Account` | — | 작업/호출이 계정을 지정하지 않을 때 사용할 계정. |
| `readTextFile` | `ReadTextFile` | fs 읽기 | `authStatus()`와 `quota()`가 사용하는 파일 읽기 seam. |
| `fetchFn` | `typeof fetch` | 전역 `fetch` | 쿼터 엔드포인트용 fetch seam. |
| `env` | `NodeJS.ProcessEnv` | `process.env` | 환경 변수 seam. |
| `quotaTimeoutMs` | `number` | `10000` | 쿼터 조회의 최대 대기 시간. |
| `modelsTimeoutMs` | `number` | `15000` | `codex app-server` 모델 목록 조회의 최대 대기 시간. 넘기면 프로세스 그룹을 종료합니다. |
| `modelsCacheMs` | `number` | `60000` | 조회에 실패한 뒤 CLI에 다시 묻기 전까지 정적 카탈로그를 돌려주는 시간. |
| `spawn` | `SpawnFn` | `child_process.spawn` | `codex app-server` 모델 목록 조회용 프로세스 생성 seam(0.1.4부터). 기본값이면 실패나 타임아웃 때 app-server의 프로세스 그룹을 종료하고, 주입한 spawner의 자식은 그 자식만 종료합니다. |

## 실행과 재개

```ts
import { Fleet } from '@toragonite/agent-mesh'
import { CodexAdapter } from '@toragonite/agent-mesh-codex'

const fleet = new Fleet().register(new CodexAdapter())

const result = await fleet.run({ prompt: '이 저장소를 한 줄로 요약해줘.' })
console.log(result.text, result.conversationId)

// 같은 대화를 이어갑니다:
const more = await fleet.resume('codex', result.conversationId, '이제 위험 요소를 나열해줘.')
console.log(more.text)
```

`run()`/`resume()`은 `task.model`/`opts.model`을 [인증 모드에 따른 모델
게이팅](#인증-모드에-따른-모델-게이팅)의 카탈로그와 대조합니다: `authModes`가
현재 로그인을 제외한 카탈로그 모델(예: ChatGPT 로그인에서 `gpt-5.1-codex-max`)을
지정하면, CLI가 알 수 없게 실패하도록 두는 대신 스폰 전에 `AgentMeshError`를
던집니다. 카탈로그에 아예 없는 모델 id는 막지 않습니다 — 어댑터는 그대로
`--model`에 전달하고, 알려진 카탈로그 밖이었다는 사실을 `RunResult`에 주석으로
남깁니다.

`resume()`은 스폰하기 전에 `-`로 시작하는 `conversationId`도 거부합니다 — 그런
형태는 세션 id가 아니라 CLI 플래그로 읽히므로, 어댑터는 이를 `codex exec resume`으로
넘기지 않습니다.

## 인증 모드에 따른 모델 게이팅

`availableModels()`는 인증 모드를 인식합니다. `authStatus()`는
`<CODEX_HOME>/auth.json`에 실제 OAuth 토큰이 있을 때만 `mode: 'chatgpt'`로
판단합니다 — 파싱은 되지만 토큰이 없는 파일(예: 로그아웃 후)은 로그인된 것으로
오판되지 않고 `loggedIn: false`가 됩니다. `mode: 'api-key'`는 `OPENAI_API_KEY`
환경변수뿐 아니라, `auth.json` 안에 같은 키가 들어 있는 경우에도 성립합니다.

### CLI가 직접 알려주는 목록

`availableModels(account)`는 CLI에 묻습니다. 그 계정의 `CODEX_HOME`으로
`codex app-server` 세션을 하나 열어 — stdio 위의 JSON-RPC 줄: `initialize` →
`initialized` → `model/list`, `nextCursor`를 따라 최대 10페이지 — 각 항목을
`ModelInfo`로 옮깁니다: `id`, `label`(표시 이름이 id와 다를 때), `default`(CLI의
`isDefault`), `efforts`(`supportedReasoningEfforts`). 그다음 app-server의 stdin을
닫아 세션을 끝내며, app-server가 스스로 종료해야만 목록으로 인정합니다.
`modelsTimeoutMs`(기본 15초) 안에 응답하지 않거나 종료하지 않으면 프로세스 그룹을
종료합니다. 자식 프로세스 환경은 어댑터의 env에서 `ANTHROPIC_*` / `CLAUDE_*` /
`CLAUDECODE` 변수를 모두 뺀 것입니다. 성공한 목록은 `CODEX_HOME`별로 메모이즈되고,
실패하면 `modelsCacheMs` 뒤에 다시 묻습니다.

어떤 실패든 — `codex` 미설치, JSON-RPC 오류, 깨진 줄, 이르거나 0이 아닌 종료,
타임아웃 — 아래 정적 카탈로그를 대신 반환합니다. `availableModels()`는 예외를
던지지도, 멈추지도 않습니다. `fetchLiveModels()`는 같은 조회를 단독으로 수행하며
실패하면 `[]`를 반환하므로, 호출자가 실제 응답과 대체 목록을 구분할 수 있습니다:

```ts
import { fetchLiveModels } from '@toragonite/agent-mesh-codex'
const live = await fetchLiveModels({ codexHome: '/path/to/codex-home' }) // 실패하면 []
```

이 조회는 `exec`가 시작하지 않는 유일한 프로세스라서 별도의 seam이 있습니다(0.1.4부터):
어댑터 옵션과 `fetchLiveModels()` 옵션의 `spawn`이며, 타입은 `SpawnFn` —
`child_process.spawn`의 모양이고 그것이 기본값입니다. `spawn(binary, ['app-server'], options)`로
한 번 호출되며, `stdin`/`stdout`/`stderr` 파이프가 있는 자식(`SpawnedChild`)을 돌려줘야
합니다. 호스트의 밀폐 테스트는 메모리 안의 가짜로 프로토콜에 답할 수 있습니다. 주입한
자식은 실패나 타임아웃 때 `child.kill('SIGKILL')`로 종료되며, 프로세스 그룹 단위로는 결코
종료되지 않습니다.

두 목록 모두 같은 방식으로 게이팅됩니다. ChatGPT 로그인에서는 범용 모델만 선택할
수 있고, `gpt-5.1-codex-max`와 `gpt-5.2`는 API 키가 필요합니다. 로그아웃
상태에서는 각 로그인이 무엇을 열어주는지 계속 조회할 수 있도록 주석이 달린 전체
목록을 반환합니다. 작업이 모델을 지정하지 않으면 어댑터는 `--model`을 생략하고
CLI가 자체 기본값을 적용합니다. `run()`/`resume()`의 스폰 전 검사는 정적
카탈로그를 쓰며 app-server를 띄우지 않습니다.

### 정적 카탈로그

`STATIC_MODELS` — 2026-10-14에 `codex app-server`가 알려준 목록과 API 키 전용
변형:

| 모델 | 지연시간¹ | 사용 가능한 로그인 |
|---|---|---|
| `gpt-6.1-sol` | fast | ChatGPT 로그인, API 키 (기본값) |
| `gpt-6-astra` | fast | ChatGPT 로그인, API 키 |
| `gpt-6-sol` | fast | ChatGPT 로그인, API 키 |
| `gpt-6-luna` | fast | ChatGPT 로그인, API 키 |
| `gpt-5.6-sol` | fast | ChatGPT 로그인, API 키 |
| `gpt-5.6-terra` | fast | ChatGPT 로그인, API 키 |
| `gpt-5.6-luna` | fast | ChatGPT 로그인, API 키 |
| `gpt-5.1-codex-max` | slow | API 키 전용 |
| `gpt-5.2` | slow | API 키 전용 |

¹ 지연시간 클래스는 실측이 아닌 잠정(미검증) 추정치입니다. 카탈로그에 없는 실제
목록 항목은 `fast`로 분류합니다.

## 쿼터

`quota()`는 **본인 런타임에서만** 동작하며, 로컬 CLI 로그인으로 인증됩니다 —
서버를 통해 프록시되지 않습니다. `<CODEX_HOME>/auth.json`에서 베어러 토큰을 읽어
벤더의 사용량 엔드포인트를 호출합니다. 실패(로그인 없음, 토큰 없음, 네트워크/파싱
오류)는 예외 대신 `null`을 반환하며, 토큰 자체는 로깅되거나 반환되거나 스냅샷에
포함되지 않습니다.

`QuotaSnapshot.capturedAt`은 이 어댑터가 찍지 않습니다 — 캡처 시각을 기록하고
싶다면 호출부에서 직접 찍으세요.

## `allowedTools`는 지원되지 않습니다

Codex에는 도구 허용 목록 플래그가 없습니다. `RunTask.allowedTools`가 설정되면
어댑터는 이를 무시하고 실행을 실패시키는 대신 그 사실을 설명하는 주석
(`RunResult.note`)을 붙입니다.

## 계정

`CODEX_HOME`으로 로그인을 격리하세요: `configDir`을 가진 `Account`를 넘기면
어댑터가 CLI 프로세스에 `CODEX_HOME`을 설정하고 그 디렉터리에서 인증 상태를
읽습니다. 생략하면 앰비언트 CLI 로그인을 사용합니다.
