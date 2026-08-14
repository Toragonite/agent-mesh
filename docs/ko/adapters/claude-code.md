# Claude Code

Claude Code 어댑터는 Anthropic의 공식 `claude` CLI를 [Adapter 계약](/ko/guide/architecture)
뒤에서 헤드리스로 구동합니다: 원샷 JSON 실행에는 `claude -p`, 대화 수정에는
`claude --resume`, 증분 이벤트에는 `claude -p --output-format stream-json`을
사용하며 — 모두 본인 로그인으로 동작합니다.

또한 **`claude-mesh`를 흡수**합니다: 백그라운드 에이전트 생명주기, 세션 탐색,
세션 간 메시징 게이트웨이, 계정 간 브리지가 같은 패키지에 들어 있고 직접 사용할
수도 있습니다.

::: warning 비공식
Anthropic과 제휴하거나 그로부터 승인받지 않았습니다. 이 패키지는 본인 로그인으로
로컬 `claude` CLI를 실행하고 로컬 파일을 읽습니다 — 자격증명을 읽거나, 프록시하거나,
로깅하지 않으며 자체적으로 네트워크 호출을 만들지 않습니다.
:::

## 설치

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-claude
```

Node ≥ 18.17과 `PATH`상의 Claude Code CLI가 필요합니다(또는 `binary` 경로를
직접 지정하세요).

## 옵션

`new ClaudeAdapter(options?)` — 모든 옵션은 실제 구현으로 기본 설정되며 테스트를
위해 재정의할 수 있습니다:

| 옵션 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `exec` | `ExecFn` | `nodeExec` | 완료까지 실행하는 프로세스 seam. |
| `lineStream` | `LineStreamFn` | `nodeLineStream` | `stream()`을 뒷받침하는 스트리밍 프로세스 seam. |
| `binary` | `string` | `'claude'` | claude 실행 파일 경로 또는 명령 이름. |
| `defaultAccount` | `Account` | — | 호출이 계정을 넘기지 않을 때 사용할 계정. `configDir`이 `CLAUDE_CONFIG_DIR`을 설정합니다. |
| `gateway` | `MeshGateway` | — | 라이브 메시 게이트웨이. `steer()`(피어 웨이크)에 필수. |
| `readTextFile` | `(path) => Promise<string \| null>` | fs 읽기 | `authStatus()`가 사용하는 텍스트 파일 리더. |
| `getUsage` | `typeof getLiveUsage` | `getLiveUsage` | `quota()`를 뒷받침하는 라이브 사용량 프로브. |

## 실행과 재개

```ts
import { Fleet } from '@toragonite/agent-mesh'
import { ClaudeAdapter } from '@toragonite/agent-mesh-claude'

const fleet = new Fleet().register(new ClaudeAdapter())

// 원샷 실행 — 여기서는 등록된 벤더가 하나뿐이라 그대로 라우팅됩니다.
const res = await fleet.run({ prompt: '저장소 README를 3개 항목으로 요약해줘.' })
console.log(res.text, res.conversationId)

// 같은 대화를 이어서 수정합니다.
const followUp = await fleet.resume('claude', res.conversationId, '이제 1개 항목으로 줄여줘.')
console.log(followUp.text)
```

`resume()`은 스폰하기 전에 `-`로 시작하는 `conversationId`를 거부합니다 — 그런
형태는 세션 id가 아니라 CLI 플래그로 읽히므로, 어댑터는 이를 `claude --resume`으로
넘기지 않습니다.

[모델](#모델)의 고정 목록 밖에 있는 id를 `task.model`에 넣어도 막히지 않습니다:
어댑터는 그대로 `--model`에 전달하고, 요청한 모델이 알려진 카탈로그 밖이었다는
사실을 `RunResult`에 주석으로 남깁니다.

## 쿼터

`quota()`는 흡수된 사용량 프로브(`getLiveUsage`)를 통해 실시간 claude.ai 플랜
사용량을 읽으며, 로컬 `claude` CLI의 설정 디렉터리를 대상으로 **본인 런타임에서**
전부 동작합니다 — 프록시되지 않습니다. 어댑터의 `binary` 옵션을 그대로 따르므로,
프로브는 `run()`과 같은 CLI 경로/명령을 스폰합니다. 프로브가 실패하거나 계정에
플랜 한도가 없을 때(예: `ANTHROPIC_API_KEY` 로그인) `null`을 반환하며, 환경적
실패에 대해 절대 예외를 던지지 않습니다.

계정에 `configDir`이 없는 경우 — 즉 앰비언트 로그인 — `quota()`와 `authStatus()`는
격리된 `CLAUDE_CONFIG_DIR`을 강제하는 대신 `~/.claude.json`을 읽고 앰비언트
환경을 그대로 물려받습니다. 덕분에 흔한 "그냥 로그인된 내 CLI를 쓰겠다" 설정이
신규 설치처럼 보이지 않고 제대로 읽힙니다.

`QuotaSnapshot.capturedAt`은 이 어댑터가 찍지 않습니다 — 캡처 시각을 기록하고
싶다면 호출부에서 직접 찍으세요.

## 조종(Steer)

`capabilities.steer`는 `'mid-run'`이지만, 실제로는 라이브 `MeshGateway`가
필요합니다 — 생성자에 하나를 넘기지 않으면 `steer()`가 예외를 던집니다.
`conversationId` 인자는 실행 id가 아니라 메시 세션 **이름**입니다: Claude Code에는
대화 id→소켓 매핑이 없어서, 어댑터가 로컬 세션 레지스트리에서 이름으로 대상을
찾습니다.

`createGateway()`는 `cwd`(게이트웨이 세션이 동작할 워크스페이스)를 필수로
받으며, 게이트웨이는 사용 전에 반드시 시작(start)해야 합니다:

```ts
import { ClaudeAdapter, createGateway } from '@toragonite/agent-mesh-claude'

const gateway = createGateway({ cwd: process.cwd() })
await gateway.start()

const adapter = new ClaudeAdapter({ gateway })

// 메시 이름으로 실행 중인 백그라운드 세션을 깨워 지침을 주입합니다.
await adapter.steer('my-background-session', '다음엔 인증 모듈에 집중해줘.')

await gateway.stop()
```

## 흡수된 메시 레이어

이 패키지는 `Adapter` 계약을 거치지 않고 직접 쓰고 싶은 호출자를 위해 전체
`claude-mesh` 표면을 다시 내보냅니다:

- **백그라운드 에이전트** — `spawnAgent`, `listAgents`, `stopAgent`, `agentLogs`, `attachCommand`
- **세션 탐색** — `listSessions`, `findSession`, `isSessionAlive`
- **메시징 게이트웨이** — `MeshGateway`, `createGateway`
- **계정 간 브리지** — `MeshBridge`

다시 내보내는 타입과 프로토콜 헬퍼의 전체 목록은 패키지의 익스포트
(`packages/claude/src/index.ts`)를 참고하세요.

## 모델

Claude Code는 인증 모드 게이팅이 없습니다 — 아래 모델은 어떤 로그인에서도 선택할
수 있습니다. 이 목록 밖의 모델 id를 넣어도 오류가 아닙니다([실행과 재개](#실행과-재개)
참고) — 어댑터가 그대로 전달하고 폴백 사실을 주석으로 남깁니다.

| 모델 | 지연시간 | 기본값 |
|---|---|---|
| `claude-opus-4-8` | slow | |
| `claude-sonnet-5` | fast | ✅ |
| `claude-haiku-4-5` | fast | |
| `claude-fable-5` | slow | |
