# Codex RLM 설치 가이드

이 문서는 공개 Git Marketplace에서 Codex RLM을 설치하고, 정상 설치를
확인하고, 이후 업데이트하거나 제거하는 절차를 설명합니다.

Codex RLM `0.1.0-alpha.1`은 Linux용 Developer Preview입니다. 현재
Python backend는 로컬 프로세스로 실행되며 **OS 수준의 보안
sandbox가 아닙니다.** 신뢰할 수 없는 Python 코드나 production
credential이 있는 host에서는 사용하지 마세요.

## 지원 환경

- Linux
- Codex CLI 0.145.0 또는 compatibility matrix를 다시 통과한 버전
- Node.js 22 이상
- `/usr/bin/python3`에 설치된 Python 3.11 이상
- GitHub에 접근할 수 있는 네트워크

공개 Marketplace 설치에는 npm이나 소스 빌드가 필요하지 않습니다.

```bash
codex --version
node --version
/usr/bin/python3 --version
```

## 설치

### 1. 공개 Marketplace 등록

Codex가 `insung151/codex-plugins` Git Marketplace를 알 수 있도록 한
번 등록합니다.

```bash
codex plugin marketplace add insung151/codex-plugins
```

등록 상태를 확인합니다.

```bash
codex plugin marketplace list
```

출력에 `insung151` Marketplace가 나타나야 합니다.

### 2. 플러그인 설치

```bash
codex plugin add codex-rlm@insung151
```

설치와 활성화 상태를 확인합니다.

```bash
codex plugin list --marketplace insung151
```

다음 항목이 나타나야 합니다.

```text
codex-rlm@insung151  installed, enabled  0.1.0-alpha.1
```

### 3. Hook 검토 및 신뢰

새 Codex CLI 대화를 시작하고 `/hooks`를 엽니다. `codex-rlm`이 제공하는
hook source와 명령을 검토한 뒤 신뢰하세요.

RLM hook은 RLM MCP 호출에만 단기 authority를 부여합니다. Hook이
신뢰되지 않았거나 실행에 실패하면 RLM 요청은 side effect 전에
거부됩니다. 일반 Codex 도구의 기존 정책은 변경하지 않습니다.

### 4. 새 대화에서 확인

설치된 skill과 MCP schema는 새 대화에서 로드됩니다. 프로젝트
디렉터리에서 새 Codex 대화를 시작한 뒤 다음처럼 명시적으로
호출합니다.

```text
$rlm 이 프로젝트의 README를 조사하고, 확인한 사실을 persisted
evidence에 연결한 짧은 보고서를 작성해 주세요.
```

완료되면 프로젝트 아래에 결과가 생성됩니다.

```text
.codex/rlm/<session-id>/
├── metadata.json
├── master.ipynb
└── report.md
```

Notebook과 report에는 프로젝트 내용이 포함될 수 있습니다. 외부에
공유하기 전에 반드시 검토하세요.

## 업데이트

Marketplace의 최신 snapshot을 받고 플러그인을 다시 설치합니다.

```bash
codex plugin marketplace upgrade insung151
codex plugin add codex-rlm@insung151
```

업데이트 후에는 새 Codex 대화를 시작하세요. 버전이 바뀌었는지 다음
명령으로 확인할 수 있습니다.

```bash
codex plugin list --marketplace insung151
```

## 제거

플러그인만 제거하려면:

```bash
codex plugin remove codex-rlm@insung151
```

다른 플러그인에서도 `insung151` Marketplace를 사용하지 않는다면
Marketplace 등록도 제거할 수 있습니다.

```bash
codex plugin marketplace remove insung151
```

제거는 프로젝트에 이미 생성된 `.codex/rlm/` 연구 산출물을 삭제하지
않습니다. 해당 파일은 사용자가 별도로 검토하고 관리해야 합니다.

## 소스에서 개발 설치

플러그인을 수정하거나 테스트할 때만 소스 빌드와 npm이 필요합니다.

```bash
git clone https://github.com/insung151/codex-rlm.git
cd codex-rlm
npm ci
npm run build
```

`$plugin-creator`를 사용해 clone한 폴더를 personal Marketplace에
등록하고 설치합니다.

```bash
codex plugin add codex-rlm@personal
```

소스를 수정한 뒤에는 cachebuster를 갱신하고 다시 설치합니다.

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py .
codex plugin add codex-rlm@personal
```

## 문제 해결

### Marketplace 또는 플러그인이 보이지 않음

```bash
codex plugin marketplace list
codex plugin marketplace upgrade insung151
codex plugin list --marketplace insung151
```

`insung151`이 등록되지 않았다면 Marketplace 등록 명령부터 다시
실행합니다.

### 설치했지만 `$rlm`이 로드되지 않음

설치 또는 업데이트 이전에 열어 둔 대화를 닫고 새 대화를 시작하세요.
그런 다음 설치 상태를 다시 확인합니다.

```bash
codex plugin list --marketplace insung151
```

### `AUTHORITY_MISSING` 또는 `AUTHORITY_INVALID`

새 대화에서 `/hooks`를 열어 `codex-rlm` hook이 신뢰되어 있는지
확인하세요. 현재 Codex CLI가 지원 compatibility matrix를 통과한
버전인지도 확인해야 합니다.

### Node.js 또는 Python 실행 오류

```bash
node --version
/usr/bin/python3 --version
```

Node.js 22 이상과 `/usr/bin/python3`의 Python 3.11 이상이 필요합니다.
현재 릴리스는 다른 Python 경로를 자동 탐색하지 않습니다.

### `unrecognized plugin install layout`

Marketplace 설치 cache 밖에서 `scripts/run-mcp.sh`를 직접 실행하면
의도적으로 거부됩니다. 공개 Marketplace에서 플러그인을 제거한 뒤
다시 설치하세요.

```bash
codex plugin remove codex-rlm@insung151
codex plugin add codex-rlm@insung151
```

해결되지 않으면 공개
[이슈 트래커](https://github.com/insung151/codex-rlm/issues)에 Codex,
Node.js, Python 버전과 secret을 제거한 오류 메시지를 첨부하세요.
