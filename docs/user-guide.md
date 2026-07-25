# Codex RLM 사용 가이드

이 문서는 로컬 Codex CLI에서 Codex RLM을 설치하고, `$rlm` 연구를
실행하고, 생성된 evidence를 검토하는 방법을 설명합니다.

현재 구현은 개발용 `local-process` Python backend를 사용합니다. 이
backend는 **OS 수준으로 격리된 sandbox가 아닙니다.** 신뢰할 수 없는
Python 코드나 host credential이 노출될 수 있는 환경에서는 사용하지
마세요.

## 1. 요구사항

- Codex CLI 0.145.0 또는 compatibility matrix를 다시 통과한 버전
- Node.js 22 이상과 npm
- `/usr/bin/python3`에 설치된 Python 3.11 이상
- worker parent-death 정리를 보장하려면 Linux

버전을 확인합니다.

```bash
codex --version
node --version
npm --version
/usr/bin/python3 --version
```

## 2. 빌드와 로컬 설치

저장소 루트에서 의존성을 재현 가능하게 설치하고 빌드합니다.

```bash
npm ci
npm run build
```

Codex에서 `$plugin-creator`를 사용해 현재 `codex-rlm` 폴더를 personal
marketplace에 등록한 다음 설치합니다.

```bash
codex plugin add codex-rlm@personal
codex plugin list
```

목록에 다음과 같이 나타나야 합니다.

```text
codex-rlm@personal  installed, enabled
```

Codex는 설치 시점의 cache snapshot을 실행합니다. 소스를 변경했다면
cachebuster를 갱신한 뒤 다시 설치해야 합니다.

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py .
codex plugin add codex-rlm@personal
```

업데이트한 skill과 MCP schema가 확실히 로드되도록 새 Codex thread를
시작하세요.

## 3. Hook 신뢰 설정

대화형 Codex에서 `/hooks`를 열고 `codex-rlm`이 제공하는 hook source를
검토한 뒤 신뢰하세요. Hook이 없거나 신뢰되지 않으면 RLM authority가
발급되지 않으며 RLM 호출은 fail closed 됩니다. 일반 Codex 도구에는
이 authority가 필요하지 않습니다.

검토가 끝난 비대화형 자동화에서만 다음 옵션을 사용할 수 있습니다.

```bash
codex exec --dangerously-bypass-hook-trust '$rlm ...'
```

이 옵션은 hook trust 확인만 우회합니다. 일반적인 실행에서 Codex
sandbox나 approval policy를 우회하지 마세요.

## 4. 첫 연구 실행

프로젝트 디렉터리에서 새 Codex 대화를 시작하고 `$rlm`을 명시적으로
호출합니다.

단일 연구 lane 예시:

```text
$rlm data/sales.csv의 월별 매출과 이상치를 조사하고, 모든 결론을
persisted cell evidence에 연결한 보고서를 작성해 주세요.
```

두 개의 독립 subagent lane을 사용하는 예시:

```text
$rlm 두 subagent를 병렬로 사용하세요. 첫 번째는 data/sales.csv의
추세를, 두 번째는 이상치를 독립적으로 분석하세요. 각 subagent는
자기 notebook cell을 근거로 findings를 제출하고, parent는 두 결과를
deterministic report로 완료하세요.
```

요청에는 다음 항목을 구체적으로 적는 것이 좋습니다.

- 연구할 파일과 질문
- 필요한 subagent 수와 역할
- 반드시 검증할 가설이나 지표
- 원하는 artifact 형식
- findings에 요구하는 confidence 또는 caveat

일반적으로 사용자가 `rlm_start`, `rlm_python` 같은 내부 MCP tool을
직접 호출할 필요는 없습니다. `$rlm` skill이 다음 lifecycle을
조정합니다.

1. parent가 연구 session을 시작합니다.
2. 각 lane은 자기 persistent Python worker와 notebook을 사용합니다.
3. Python 실행은 성공·실패·timeout·truncation 여부와 함께 기록됩니다.
4. 각 lane은 persisted cell 또는 artifact를 참조하는 findings를
   제출합니다.
5. parent만 전체 session을 완료하거나 취소할 수 있습니다.
6. 완료 시 master notebook과 report를 검증하고 모든 session worker를
   정리합니다.

## 5. Python lane에서 사용할 경로

각 Python worker에는 다음 두 `Path` 객체가 준비됩니다.

- `PROJECT_ROOT`: 프로젝트 입력을 읽는 canonical root
- `ARTIFACT_ROOT`: 현재 lane이 결과를 쓸 수 있는 디렉터리

예:

```python
import csv

source = PROJECT_ROOT / "data" / "sales.csv"
with source.open(newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))

summary = {"row_count": len(rows)}
(ARTIFACT_ROOT / "summary.json").write_text(
    __import__("json").dumps(summary, indent=2),
    encoding="utf-8",
)
summary
```

현재 local backend의 audit hook은 프로젝트 밖의 host 파일 읽기,
artifact root 밖의 쓰기, network, subprocess, `ctypes`를 거부합니다.
이는 defense in depth일 뿐, 악의적인 코드에 대한 OS security
boundary는 아닙니다.

## 6. 산출물 확인

완료된 session은 프로젝트 아래에 생성됩니다.

```text
.codex/rlm/<session-id>/
├── metadata.json
├── events.jsonl
├── master.ipynb
├── report.md
└── lanes/
    ├── parent/
    │   ├── notebook.ipynb
    │   ├── findings.json
    │   └── artifacts/
    ├── lane-1/
    │   ├── notebook.ipynb
    │   ├── findings.json
    │   └── artifacts/
    └── lane-2/
        └── ...
```

상태와 lane 결과를 빠르게 확인할 수 있습니다.

```bash
jq '{id,status,backend,lanes}' .codex/rlm/<session-id>/metadata.json
jq '.cells[] | .metadata.rlm' .codex/rlm/<session-id>/master.ipynb
sed -n '1,240p' .codex/rlm/<session-id>/report.md
```

검토할 때 다음을 확인하세요.

- `metadata.json`의 session 상태가 `completed`인지
- 모든 필수 subagent lane이 `submitted` 또는 `no_findings`인지
- report의 material claim마다 `lane-N:cell-M` 또는 artifact evidence가
  있는지
- master notebook의 lane 순서가 parent, lane creation order인지
- backend가 `NON-HARDENED DEVELOPMENT BACKEND`로 표시되는지

`.codex/rlm/`은 생성 데이터로 Git에서 ignore됩니다. Notebook과
report에는 프로젝트의 민감한 내용이 포함될 수 있으므로 외부 공유
전에 반드시 검토하세요.

## 7. 취소와 오류 복구

연구를 중단하려면 같은 parent 대화에서 다음처럼 요청합니다.

```text
현재 RLM 연구를 취소하고 생성된 evidence는 보존한 뒤 worker를 모두
정리해 주세요.
```

`rlm_cancel`은 destructive annotation이 있으므로 Codex가 approval을
요청할 수 있습니다. Subagent는 parent session을 취소할 수 없습니다.

정상 완료나 취소가 되지 않았을 때:

1. `rlm_status`로 session과 lane 상태를 확인하도록 요청합니다.
2. 실행 중인 subagent가 findings 또는 명시적인 `no_findings`를
   제출했는지 확인합니다.
3. `COMPLETION_BLOCKED`라면 누락된 terminal lane이나 실행 중인 cell을
   해결한 뒤 같은 idempotency key로 재시도합니다.
4. 안전한 완료가 불가능하면 parent에서 취소합니다.
5. 비정상 종료 후에는 worker가 남아 있는지 확인합니다.

```bash
ps -eo pid,ppid,args | rg '[/]rlm_worker.py|codex-rlm/.*/dist/src/server.js'
```

정상 완료·취소 뒤에는 결과가 없어야 합니다. Linux에서는 control
plane이 `SIGKILL`되더라도 worker가 parent-death signal로 종료되지만,
session metadata는 향후 recovery 기능이 구현되기 전까지 `active`로
남을 수 있습니다.

자주 접하는 오류:

| 오류 | 의미와 대응 |
| --- | --- |
| `AUTHORITY_MISSING` / `AUTHORITY_INVALID` | Hook 신뢰, 설치 snapshot, 현재 Codex 버전의 compatibility를 확인하고 새 thread에서 재시도합니다. |
| `ROLE_FORBIDDEN` | Subagent가 parent 전용 완료·취소 작업을 시도했습니다. Parent에서 수행합니다. |
| `LANE_BUSY` | 같은 lane에 실행 중인 cell이 있습니다. 완료 또는 timeout을 기다립니다. |
| Cell status `timed_out` | Cell이 wall-time 제한을 넘었습니다. Timeout cell은 notebook에 남으며 해당 worker는 정리됩니다. |
| `EVIDENCE_NOT_FOUND` | Finding이 성공한 자기 lane cell 또는 존재하는 자기 artifact를 참조하도록 수정합니다. |
| `COMPLETION_BLOCKED` | 필수 lane 수, terminal findings, 실행 중 cell을 확인합니다. |
| `PATH_OUTSIDE_ROOT` / `PATH_SYMLINK_ESCAPE` | `PROJECT_ROOT` 읽기와 `ARTIFACT_ROOT` 쓰기 경계를 지킵니다. |

## 8. 현재 지원하지 않는 기능

- hardened container sandbox와 CPU·memory quota
- control-plane restart 후 resume/evidence replay
- Python network와 remote search
- session-scoped package installation
- strict RLM-only host-tool profile
- nested code-mode authority compatibility 보장
- Codex App, IDE, Cloud
- 자동 secret detection/DLP
- public marketplace 배포

구현 상태와 검증 증거는 [validation.md](./validation.md), architecture
contract는 [DESIGN.md](../DESIGN.md), public tool contract는
[tool-contracts.md](./tool-contracts.md)를 참고하세요.
