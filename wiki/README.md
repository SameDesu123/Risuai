# RisuAI 비공식 위키

[RisuAI](https://github.com/kwaroran/RisuAI) 사용자들이 함께 만드는 **비공식** 문서 사이트입니다. RisuAI 개발자와는 관계가 없으며, 내용이 틀릴 수 있습니다. 각 문서에는 어느 RisuAI 버전에서 확인했는지(`verifiedVersion`)가 적혀 있습니다.

[Astro Starlight](https://starlight.astro.build/)로 만들고 GitHub Pages로 배포합니다.

## 구성

| 경로 | 내용 |
| --- | --- |
| `src/content/docs/` | 문서 본문 (한국어가 기본, 영어는 `en/` 아래) |
| `scripts/generate-cbs.mjs` | RisuAI 소스의 `src/ts/cbs.ts`를 읽어 CBS 레퍼런스를 만드는 생성기 |
| `scripts/cbs-categories.mjs` | CBS 레퍼런스의 분류표 |
| `data/cbs-translations/ko.json` | CBS 설명의 한국어 번역 |
| `scripts/check-links.mjs` | 빌드 결과물의 내부 링크·앵커 검사 |
| `site.config.mjs` | 저장소 이름, 사이트 주소, base 경로 |

`src/content/docs/cbs/reference.md`와 `src/content/docs/en/cbs/reference.md`는 빌드할 때마다 새로 만들어지므로 저장소에 넣지 않습니다.

## 로컬에서 실행하기

Node.js 22.13 이상과 pnpm이 필요합니다.

```sh
pnpm install
pnpm dev                # CBS 레퍼런스를 만든 뒤 개발 서버 실행
pnpm build              # dist/에 정적 사이트 빌드
pnpm check:links        # 빌드 결과물의 깨진 내부 링크 검사
```

`pnpm generate`(`dev`와 `build`가 자동으로 실행함)는 기본적으로 RisuAI 저장소의 `main` 브랜치를 `.cache/risuai`에 얕게 클론합니다. 다음 환경 변수로 바꿀 수 있습니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `RISUAI_SOURCE_DIR` | (없음) | 로컬 RisuAI 체크아웃 경로. 지정하면 클론하지 않습니다. 예: `RISUAI_SOURCE_DIR=../RisuAI pnpm dev` |
| `RISUAI_REPO` | `https://github.com/kwaroran/RisuAI` | 클론할 저장소 |
| `RISUAI_REF` | `main` | 클론할 브랜치나 태그 |
| `SITE_URL` | `site.config.mjs`의 값 | 사이트 주소 |
| `BASE_PATH` | `site.config.mjs`의 값 | 사이트가 올라가는 하위 경로 |

## 배포

`main`에 푸시하면 `.github/workflows/deploy.yml`이 빌드하고 링크를 검사한 뒤 GitHub Pages에 배포합니다. RisuAI 원본의 변경을 따라가도록 매일 한 번 예약 빌드도 돌고, PR에서는 배포 없이 빌드와 링크 검사만 합니다.

처음 한 번은 저장소의 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿔야 합니다.

GitHub는 저장소에 60일 동안 활동이 없으면 예약 워크플로를 멈춥니다. 멈췄다면 Actions 탭에서 다시 켜거나 아무 커밋이나 올리면 됩니다.

### 저장소 이름이나 주소를 바꿀 때

`site.config.mjs`의 세 값을 고칩니다.

```js
export const GITHUB_REPO = 'SameDesu123/risuai-wiki'; // 편집 링크와 GitHub 아이콘이 가리키는 저장소
export const SITE = process.env.SITE_URL ?? 'https://samedesu123.github.io';
export const BASE = process.env.BASE_PATH ?? '/risuai-wiki'; // 저장소 이름과 같게
```

- 저장소 이름이 `risuai-wiki`가 아니라면 `GITHUB_REPO`와 `BASE`를 같이 바꿉니다.
- 사용자 페이지 저장소(`<계정>.github.io`)나 커스텀 도메인에 올린다면 `BASE`를 `''`로 둡니다.

## RisuAI 저장소에서 옮겨 오기

이 위키는 처음에 RisuAI 포크의 `wiki/` 폴더에서 만들어졌습니다. 독립 저장소로 옮기려면 다음과 같이 합니다.

1. GitHub에서 빈 저장소를 만듭니다. README, `.gitignore`, 라이선스를 자동으로 추가하지 않습니다.
2. RisuAI 포크에서 `wiki/` 폴더의 기록만 떼어 내 새 저장소로 올립니다.

   ```sh
   git subtree split --prefix=wiki -b wiki-export
   git push https://github.com/<계정>/<새-저장소>.git wiki-export:main
   git branch -D wiki-export
   ```

3. 새 저장소의 **Settings → Pages → Source**를 **GitHub Actions**로 바꿉니다.
4. 저장소 이름이 다르면 위의 `site.config.mjs`를 고쳐 푸시합니다. 이름이 같다면 Actions 탭에서 `Build & deploy`를 한 번 수동 실행하면 됩니다.

## 기여하기

문서 수정은 각 페이지 아래의 **이 페이지 편집** 링크로 바로 할 수 있습니다. 글쓰기 규칙, 링크 작성법, CBS 번역 방법은 사이트의 [위키 기여하기](src/content/docs/contributing.md) 문서를 보세요.

## 라이선스

[GPL-3.0](LICENSE). RisuAI와 같은 라이선스입니다. RisuAI 공식 문서(kwaroran/docs)는 라이선스가 명시되어 있지 않으므로 내용을 복사하지 않고 직접 확인해서 씁니다.
