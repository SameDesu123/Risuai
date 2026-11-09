// 저장소 이름이나 주소가 바뀌면 이 파일만 고치면 된다.
// 빌드할 때 환경 변수로 덮어쓸 수도 있다 (SITE_URL, BASE_PATH).

/** 이 위키 자체의 GitHub 저장소 (owner/name). '이 페이지 편집' 링크에 쓰인다. */
export const GITHUB_REPO = 'SameDesu123/risuai-wiki';

/** 사이트가 올라가는 origin. 사용자 이름은 소문자로 쓴다. */
export const SITE = process.env.SITE_URL ?? 'https://samedesu123.github.io';

/**
 * 사이트가 놓이는 하위 경로. 프로젝트 페이지(owner.github.io/<repo>/)라면 '/<repo>',
 * 사용자 페이지나 커스텀 도메인처럼 루트에 놓인다면 '/'로 둔다.
 */
export const BASE = process.env.BASE_PATH ?? '/risuai-wiki';
