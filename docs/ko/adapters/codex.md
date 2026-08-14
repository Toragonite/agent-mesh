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

ChatGPT 로그인에서는 범용 모델만 선택할 수 있고, `gpt-5.1-codex-max`와
`gpt-5.2`는 API 키가 필요합니다. 로그아웃 상태에서는 각 로그인이 무엇을
열어주는지 계속 조회할 수 있도록 주석이 달린 전체 카탈로그를 반환합니다. 어떤
모델도 `default`로 표시되지 않습니다 — 작업이 모델을 지정하지 않으면 어댑터는
`--model`을 생략하고 CLI가 자체 기본값을 적용합니다.

| 모델 | 지연시간¹ | 사용 가능한 로그인 |
|---|---|---|
| `gpt-5.6-sol` | fast | ChatGPT 로그인, API 키 |
| `gpt-5.6-terra` | fast | ChatGPT 로그인, API 키 |
| `gpt-5.6-luna` | fast | ChatGPT 로그인, API 키 |
| `gpt-5.5` | fast | ChatGPT 로그인, API 키 |
| `gpt-5.1-codex-max` | slow | API 키 전용 |
| `gpt-5.2` | slow | API 키 전용 |

¹ 지연시간 클래스는 실측이 아닌 잠정(미검증) 추정치입니다.

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
