---
layout: home

hero:
  name: agent-mesh
  text: 모든 코딩 에이전트를 위한 하나의 인터페이스
  tagline: Claude Code, Codex, Antigravity, Cursor를 헤드리스 워커처럼 구동 — 실행·수정하고 쿼터·강점·지연시간 기준으로 라우팅. 비공식 프로젝트입니다.
  actions:
    - theme: brand
      text: 시작하기
      link: /ko/guide/getting-started
    - theme: alt
      text: 아키텍처
      link: /ko/guide/architecture
    - theme: alt
      text: GitHub에서 보기
      link: https://github.com/Toragonite/agent-mesh

features:
  - title: 하나의 어댑터 계약
    details: 모든 벤더가 같은 형태(원샷 실행, id로 재개, 토큰 사용량, 쿼터, 인증모드별 모델)를 노출합니다. Adapter 인터페이스가 이를 동결해 오케스트레이터는 벤더별 세부사항을 알 필요가 없습니다.
  - title: 중요한 기준으로 라우팅
    details: 한 계정만 소진하는 대신, 쿼터 여유가 있고 도메인에 강하며 적절한 지연시간을 가진 에이전트로 각 작업을 보냅니다.
  - title: 실질적인 수정 루프
    details: 어떤 대화든 재개해 수정하고, 벤더가 지원하면 실행 중에도 조종합니다. 플릿은 벤더별·대화별로 컨텍스트를 유지합니다.
  - title: 본인 로그인 사용
    details: 각 어댑터는 본인 로그인으로 벤더의 공식 CLI를 구동합니다. 자격증명 공유·소켓 위장·레이트리밋 우회는 없습니다.
---
