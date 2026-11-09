---
title: 위키 기여하기
description: 이 위키의 문서를 고치거나 새로 쓰는 방법, CBS 레퍼런스를 번역하는 방법을 안내합니다.
---

이 위키는 누구나 고칠 수 있습니다. 오타 하나를 고치는 것도 큰 도움이 됩니다.

## 간단히 고치기

각 페이지 아래에 있는 **페이지 편집** 링크를 누르면 GitHub 편집 화면이 열립니다. 내용을 고친 뒤 **Propose changes**를 누르면 풀 리퀘스트가 만들어지고, 검토를 거쳐 반영됩니다. GitHub 계정만 있으면 됩니다.

## 문서 쓰는 규칙

- 문서는 `src/content/docs/` 아래에 Markdown(`.md`) 파일로 둡니다. 파일 경로가 곧 주소입니다. 예를 들어 `src/content/docs/cbs/basics.md`는 `/cbs/basics/`가 됩니다.
- 영어 문서는 `src/content/docs/en/` 아래에 같은 경로로 둡니다. 영어 문서가 없으면 한국어 문서가 대신 보입니다.
- 새 페이지를 사이드바에 넣으려면 `astro.config.mjs`의 `sidebar`에 추가합니다.
- 문장은 '~합니다' 체로 씁니다.

### 다른 페이지로 링크하기

위키 안의 다른 페이지는 `/`로 시작하는 경로로 링크합니다.

```md
[CBS 기초](/cbs/basics/)
[getvar](/cbs/reference/#cbs-getvar)
```

사이트가 하위 경로(예: `/risuai-wiki/`)에 올라가더라도 빌드할 때 자동으로 앞에 붙으니, 문서에는 신경 쓰지 않고 위처럼 쓰면 됩니다. 단, `.mdx` 파일 안의 컴포넌트(`<LinkCard href="...">` 같은 것)나 frontmatter 안의 링크에는 자동으로 붙지 않으므로 상대 경로(`cbs/basics/`)를 씁니다.

CBS 레퍼런스의 각 함수는 `#cbs-이름` 형태의 주소를 가집니다. 기호가 들어간 이름은 `#when` → `#cbs-block-when`, `:else` → `#cbs-colon-else`처럼 바뀌니, 레퍼런스 페이지에서 함수 이름을 눌러 주소를 확인하세요.

### 확인한 버전 적기

RisuAI는 자주 바뀝니다. 앱의 동작을 설명하는 문서라면 frontmatter에 직접 확인한 RisuAI 버전을 적어 주세요. 제목 아래에 "RisuAI ○○ 기준으로 확인한 문서입니다"라고 표시됩니다.

```md
---
title: 설치하기
description: 한 줄 요약
verifiedVersion: "2026.10.295"
---
```

최신 버전은 RisuAI 저장소의 [`version.json`](https://github.com/kwaroran/RisuAI/blob/main/version.json)에서 확인할 수 있습니다. 오래된 버전이 적힌 문서를 다시 확인했다면 버전도 함께 올려 주세요.

## CBS 레퍼런스

[CBS 레퍼런스](/cbs/reference/)는 RisuAI 소스 코드의 `src/ts/cbs.ts`에서 **자동으로 만들어지므로 직접 고치지 않습니다.** 빌드할 때마다 새로 만들어지고, 사이트는 매일 한 번 다시 빌드되어 RisuAI의 변경을 따라갑니다.

- **설명이 틀렸다면**: 영어 원문은 RisuAI 저장소의 `src/ts/cbs.ts`에 있으니 그쪽에 고쳐 달라고 제안해야 합니다. 이 위키에서 바로 보완하고 싶다면 한국어 번역에 '참고:' 문단을 덧붙이고, 자세한 설명은 [CBS 기초](/cbs/basics/) 같은 일반 문서에 씁니다.
- **분류를 바꾸려면**: `scripts/cbs-categories.mjs`를 고칩니다. RisuAI에 새 함수가 생기면 '미분류' 분류에 들어가고 빌드 로그에 경고가 뜹니다. 그때 알맞은 분류에 이름을 추가하면 됩니다.

### 레퍼런스 번역하기

한국어 설명은 `data/cbs-translations/ko.json`에 있습니다. 함수 이름마다 번역문(`description`)과 번역할 때의 원문 해시(`source`)를 적습니다.

```json
{
    "getvar": {
        "source": "9d38b886b1",
        "description": "이름으로 채팅 변수의 값을 가져옵니다. ..."
    }
}
```

- `description`에는 원문의 `Usage::` 앞부분만 옮깁니다. 사용 예시는 원문의 것을 그대로 씁니다.
- `{{`로 시작하는 줄은 목록 항목이 되고, 문장 안의 `{{...}}`는 자동으로 코드 모양이 됩니다. Markdown 문법은 쓸 수 없습니다.
- `source`는 비워 둔 채 `pnpm generate`를 실행하면, 경고 메시지에 지금 원문의 해시가 나옵니다. 그 값을 넣으면 됩니다.

나중에 영어 원문이 바뀌면 해시가 달라져, 레퍼런스 페이지에 "원문이 바뀌었습니다" 경고와 함께 새 원문이 표시됩니다. 번역을 고친 뒤 `source`를 새 해시로 바꿔 주세요.

## 내 컴퓨터에서 미리 보기

Node.js 22.13 이상과 pnpm이 필요합니다.

```sh
pnpm install
pnpm dev
```

`pnpm dev`는 RisuAI 저장소를 받아 레퍼런스를 만든 뒤 개발 서버를 엽니다. 인터넷 없이 작업하려면 RisuAI를 미리 클론해 두고 `RISUAI_SOURCE_DIR=../RisuAI pnpm dev`처럼 경로를 지정합니다.

풀 리퀘스트를 올리기 전에 `pnpm build && pnpm check:links`로 빌드와 깨진 링크를 확인해 주세요. 풀 리퀘스트를 올리면 같은 검사가 자동으로 실행됩니다.

## 라이선스

이 위키의 문서와 코드는 GPL-3.0 라이선스(저장소의 `LICENSE` 파일)로 공개됩니다. 기여한 내용도 같은 라이선스로 공개되는 것에 동의한 것으로 봅니다.

다른 사이트의 글을 옮겨 올 때는 그 글의 라이선스가 GPL-3.0과 함께 쓸 수 있는지 먼저 확인해 주세요. 특히 공식 RisuAI 문서 사이트의 글은 별도의 라이선스가 없으므로 그대로 옮겨 오면 안 됩니다.
