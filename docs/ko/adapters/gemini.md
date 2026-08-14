# Antigravity (Gemini)

Antigravity 어댑터는 Google의 공식 `agy` CLI를 [Adapter 계약](/ko/guide/architecture)
뒤에서 헤드리스로 구동합니다: 원샷 실행에는 `agy --output-format json -p`, 대화
수정에는 `agy --conversation <id> -p`, 증분 이벤트에는 `agy --output-format
stream-json -p`를 사용하며 — 모두 본인 Google 로그인으로 동작합니다.

::: warning 비공식
Google과 제휴하거나 그로부터 승인받지 않았습니다. 이 패키지는 이미 설치되고
인증된 `agy` 바이너리를 그대로 실행합니다 — 서비스를 사칭하거나, 자격증명을
공유하거나, 레이트리밋을 우회하지 않습니다.
:::

## 설치

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-gemini
```

`agy` CLI가 설치되고 로그인되어 있어야 합니다. Antigravity는 자격증명을 Electron
앱의 데이터 디렉터리에 보관합니다 — CLI `login`/`status` 서브커맨드가 없으므로,
아래 [인증](#인증)은 파일을 읽는 대신 CLI를 직접 실행합니다.

## 옵션

`new GeminiAdapter(options?)` — 모든 옵션은 실제 구현으로 기본 설정되며 테스트를
위해 재정의할 수 있습니다:

| 옵션 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `exec` | `ExecFn` | `nodeExec` | 완료까지 실행하는 프로세스 seam. |
| `lineStream` | `LineStreamFn` | `nodeLineStream` | `stream()`을 뒷받침하는 스트리밍 프로세스 seam. |
| `binary` | `string` | `'agy'` | agy 실행 파일 경로 또는 명령 이름. |
| `defaultAccount` | `Account` | — | 호출이 계정을 넘기지 않을 때 사용할 계정. `configDir`이 `AGY_HOME`을 설정합니다(`agy`에는 문서화되지 않은 변수 — [동작 참고사항](#동작-참고사항) 참고). |
| `env` | `Record<string, string \| undefined>` | `process.env` | 환경 변수 seam — 모든 자식 프로세스 환경과 모든 환경 읽기의 기반. |
| `authTimeoutMs` | `number` | `20000` | `agy models` 인증 프로브의 최대 대기 시간. |

## 실행과 재개

```ts
import { Fleet } from '@toragonite/agent-mesh'
import { GeminiAdapter } from '@toragonite/agent-mesh-gemini'

const fleet = new Fleet().register(new GeminiAdapter())

// Antigravity는 한 단어 답변에 약 12-15초가 걸립니다 — timeoutMs를 넉넉하게
// 설정하세요(아래 지연시간 참고).
const res = await fleet.run(
  { prompt: 'Reply with exactly: MESH-OK', timeoutMs: 60_000 },
  { policy: { prefer: ['gemini'] } },
)
console.log(res.status, res.conversationId, res.text)

// 같은 대화를 id로 이어갑니다.
const more = await fleet.resume('gemini', res.conversationId, 'Now say it backwards.', {
  timeoutMs: 60_000,
})
console.log(more.text)
```

어댑터를 직접 사용할 수도 있습니다:

```ts
const agy = new GeminiAdapter({ binary: 'agy' /* 기본값 */ })
const res = await agy.run({ prompt: 'hello', model: 'gemini-3.6-flash-high' })
```

## 스트림

```ts
const agy = new GeminiAdapter()
for await (const ev of agy.stream({ prompt: 'Write a haiku about routing.', timeoutMs: 60_000 })) {
  if (ev.type === 'text') process.stdout.write(ev.text)
  else if (ev.type === 'usage') console.error('usage', ev.usage)
  else if (ev.type === 'done') console.error('\ndone', ev.result.status, ev.result.conversationId)
  else if (ev.type === 'error') console.error('error', ev.message)
}
```

스트리밍은 `agy --output-format stream-json`을 agent-mesh `RunEvent`로
매핑합니다: `init` 이벤트는 대화 id만 기록합니다. `agent_response` 단계에서 비어
있지 않은 `text_delta`가 있을 때만 `text` 이벤트가 됩니다(`user_input`,
`checkpoint` 등 다른 단계 타입은 건너뜁니다 — 계약에 해당 이벤트가 없고,
단계별 `usage`는 부분값이라 권위 있는 값이 아니기 때문입니다). 마지막 `result`
이벤트는 `usage` 이벤트를 내보낸 뒤, 스트리밍이 아닌 `run()`이 만드는 것과 같은
`RunResult`를 담은 `done` 이벤트를 내보냅니다. 빈 프롬프트는 프로세스가 스폰되기
전, `stream()` 호출 시점에 동기적으로 예외를 던집니다. `result` 이벤트 없이
스트림이 끝나면: 타임아웃은 `status: 'incomplete'`인 `done` 결과를
내보내고(절대 `error` 이벤트가 아닙니다), 0이 아닌 종료 코드는 종료 코드와 자식
프로세스의 stderr 꼬리를 담은 `error` 이벤트를 내보냅니다.

## 모델

`availableModels()`는 **정적** 카탈로그를 반환하며 아무것도 스폰하지 않습니다 —
`Fleet.route()`가 라우팅 핫 패스에서 이 메서드를 호출하기 때문입니다:

| id | 지연시간 | 비고 |
| --- | --- | --- |
| `gemini-3.6-flash-high` | fast | |
| `gemini-3.6-flash-medium` | fast | |
| `gemini-3.6-flash-low` | fast | |
| `gemini-3.5-flash-high` | fast | |
| `gemini-3.5-flash-medium` | fast | |
| `gemini-3.5-flash-low` | fast | |
| `gemini-3.1-pro-high` | slow | |
| `gemini-3.1-pro-low` | slow | |
| `claude-sonnet-4-6` | fast | **리셀** — 선택하면 Gemini가 아니라 Anthropic의 쿼터를 소모합니다 |
| `claude-opus-4-6-thinking` | slow | **리셀** — 선택하면 Gemini가 아니라 Anthropic의 쿼터를 소모합니다 |
| `gpt-oss-120b-medium` | fast | **리셀** — 선택하면 Gemini가 아니라 해당 제공사의 쿼터를 소모합니다 |

::: warning 리셀 모델
카탈로그 항목 중 세 개는 `agy`를 통해 접근할 수 있지만 Google이 아닌 **다른**
벤더의 쿼터를 청구합니다. Gemini 어댑터로 다른 벤더의 쿼터를 라우팅하는 것은
멀티 벤더 플릿의 취지를 무색하게 합니다 — 그 벤더 자신의 어댑터를 등록하는 편이
낫습니다.
:::

인증 모드 게이팅은 없습니다 — 모든 항목이 하나의 Google 로그인에서 선택
가능합니다. `latency` 클래스는 잠정적인 추정치입니다(인터랙티브 대 심층 추론
행동에 대한 최선의 추측이며, 실측이 아닙니다). 어떤 항목도 `default`로 표시되지
않습니다: 작업이 모델을 지정하지 않으면 `run()`은 `--model`을 생략하고 CLI가
자체 기본값을 적용합니다 — 여기서 기본값을 표시하면 거짓이 됩니다. 이 카탈로그
밖의 모델 id도 그대로 실행되며, 결과에 `model <id> not in known catalog`
주석이 남습니다.

### 정적 vs 라이브

`availableModels()`는 라우팅을 위한 빠르고 hermetic한 경로입니다. 느리지만
권위 있는 대응은 `fetchLiveModels()`로, `agy models`를 실행하고 `Fetching
available models...` 안내 줄을 건너뛴 뒤 TAB으로 구분된 `id\tlabel` 행을 각각
파싱합니다:

```ts
import { fetchLiveModels } from '@toragonite/agent-mesh-gemini'
const live = await fetchLiveModels() // ModelInfo[] — 실패 시 []
```

어떤 실패든(스폰 오류, 0이 아닌 종료 코드, 타임아웃, 파싱 불가능한 출력) `[]`로
귀결됩니다 — 절대 예외를 던지지 않습니다.

## 인증

`authStatus()`는 `agy models`를 실행합니다 — 읽을 수 있는 로컬 자격증명 파일도,
`status`/`login` 서브커맨드도 없기 때문에 Antigravity가 노출하는 유일한 인증
프로브입니다. 종료 코드 0이고 파싱 가능한 모델 줄이 하나 이상이면 `{ loggedIn:
true, mode: 'google' }`를 반환합니다. 그 외(0이 아닌 종료 코드, 바이너리 없음,
타임아웃, 파싱 불가능한 출력)는 `{ loggedIn: false }`를 반환합니다. 절대
예외를 던지지 않고, `detail`도 반환하지 않습니다 — CLI가 계정 식별자를 노출하지
않기 때문입니다.

**이 호출은 네트워크 왕복이 발생하므로**, 의도적으로 라우팅 경로에는 포함되지
않습니다 — 라우팅에는 정적인 `availableModels()`만 쓰입니다.

## 쿼터

`quota()`는 무조건 `null`을 반환하며, `capabilities.quota`는 `false`입니다.
Antigravity는 검증된 사용량 엔드포인트를 노출하지 않습니다. 이는 그냥 채워 넣은
스텁이 아니라 의도적인 "헤드룸 알 수 없음" 신호입니다: `{ allowed: true,
windows: [] }`를 임의로 만들어 반환하면 Fleet의 라우터에게 소진된 계정이 여유가
가득 있다고 알리는 셈이 됩니다. 대신 `null`을 반환함으로써 라우터는 Gemini의
헤드룸을 가짜 만탱크로 믿는 대신 **확인되지 않음**으로 취급합니다 — 어댑터를
후보에서 제외하지는 않지만, 실제 사용량을 보고하는 벤더와 쿼터 기준으로
비교하지는 않습니다. 절대 예외를 던지지 않습니다.

## 동작 참고사항

- **후행 개행 정규화.** `agy`는 다른 agent-mesh 벤더들과 달리 출력한 답변 끝에
  개행을 하나 붙입니다. 벤더 간 비교 가능성을 위해 `run()`/`resume()`과
  스트림의 `done` 결과는 최종 텍스트에서 후행 개행(`\r\n` 또는 `\n`)을 정확히
  하나만 제거합니다. 중간의 개행은 그대로 유지되며, 두 번째 후행 개행도
  그대로 남습니다. 스트리밍 `text` 델타는 가공하지 않고 그대로 전달됩니다 —
  최종 조립된 텍스트만 정규화됩니다.
- **`allowedTools`는 무시됩니다.** `agy`에는 대응하는 플래그가 없으므로
  `task.allowedTools`는 버려지고, 결과에는 `allowedTools not supported by agy;
  ignored` 주석이 남습니다.
- **`account.configDir` → `AGY_HOME`.** `agy`에는 문서화된 config-dir 환경
  변수가 없습니다. `account.configDir`을 넘기면 어댑터가 이를 `AGY_HOME`으로
  설정하고, Antigravity의 계정 격리가 이 변수로 이루어지는지는 **검증되지
  않았다**는 주석을 추가합니다. `configDir` 없이 명시적으로 넘긴 `account`는
  앰비언트 로그인을 의미하며 기본 계정의 디렉터리를 물려받지 않습니다.
- **지연시간.** 한 단어 답변이 **12–15초**로 관측되었습니다(Claude
  Code/Codex의 약 5초와 대비됩니다). `agy` 자체의 `--print-timeout` 기본값은
  `5m0s`입니다. `timeoutMs`를 넉넉하게 설정하세요 — 타임아웃은 `status:
  'incomplete'`로 해석되므로(절대 예외를 던지지 않습니다) 너무 짧게 잡으면
  실제 답변이 조용히 잘려나갈 수 있습니다.
- **비밀값 없음.** 어떤 결과, 주석, `detail`, 오류, `raw`에도 토큰이나
  자격증명 값이 등장하지 않습니다. 이 경로에는 애초에 토큰이 없지만, 규칙은
  변함없이 적용됩니다.
