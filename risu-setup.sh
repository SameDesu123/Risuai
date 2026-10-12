#!/usr/bin/env bash
# RisuAI Node server setup TUI for beginners.
# Pure bash, no extra dependencies. (Linux / macOS / WSL / Termux)
#
#   Usage: bash risu-setup.sh [--lang ko|en|ja]
#
# The UI language follows the system locale. Override it with --lang,
# the RISU_LANG environment variable, or the settings menu.
# Settings are saved to .risu-setup.env and the server log to risu-server.log.

set -u

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
UPSTREAM_URL="https://github.com/kwaroran/Risuai.git"
PNPM_VERSION="10.34.1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_FILE="$SCRIPT_DIR/.risu-setup.env"

RISU_DIR="$SCRIPT_DIR"
RISU_METHOD="node"        # node | docker
RISU_PORT="6001"
RISU_LEGAL="TRUE"         # TRUE for a personal self-hosted instance
RISU_LITE="FALSE"
RISU_TRUST_PROXY=""       # 1 when behind a reverse proxy
RISU_HTTPS="FALSE"
RISU_LANG=""              # empty = follow the system locale

# ---------------------------------------------------------------------------
# Language
# ---------------------------------------------------------------------------
SUPPORTED_LANGS="ko en ja"
UI_LANG=en
LOCALE_SOURCE=""

lang_name() {
    case "$1" in
        ko) echo "한국어" ;;
        ja) echo "日本語" ;;
        *)  echo "English" ;;
    esac
}

# Sets SYSTEM_LOCALE (e.g. ko_KR.UTF-8) and LOCALE_SOURCE.
SYSTEM_LOCALE=""
system_locale() {
    local l="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"
    # GNU gettext honors LANGUAGE (a priority list) unless the locale is C.
    case "$l" in
        ''|C|C.*|POSIX) ;;
        *)
            if [ -n "${LANGUAGE:-}" ]; then SYSTEM_LOCALE="${LANGUAGE%%:*}"; LOCALE_SOURCE=LANGUAGE
            else SYSTEM_LOCALE="$l"; LOCALE_SOURCE="env"; fi
            return ;;
    esac
    # The environment says nothing useful; ask the OS.
    if [ "$(uname -s)" = Darwin ]; then
        l="$(defaults read -g AppleLocale 2>/dev/null)"
        [ -n "$l" ] && { SYSTEM_LOCALE="$l"; LOCALE_SOURCE=macOS; return; }
    fi
    if command -v getprop >/dev/null 2>&1; then
        l="$(getprop persist.sys.locale 2>/dev/null)"
        [ -z "$l" ] && l="$(getprop ro.product.locale 2>/dev/null)"
        [ -n "$l" ] && { SYSTEM_LOCALE="$l"; LOCALE_SOURCE=Android; return; }
    fi
    if grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null 2>&1; then
        l="$(powershell.exe -NoProfile -NonInteractive -Command '(Get-UICulture).Name' 2>/dev/null | tr -d '\r')"
        [ -n "$l" ] && { SYSTEM_LOCALE="$l"; LOCALE_SOURCE=Windows; return; }
    fi
    SYSTEM_LOCALE="${l:-C}"; LOCALE_SOURCE=none
}

# Maps a locale string to a supported UI language.
locale_to_lang() {
    local l="$1"
    # Our messages are UTF-8. A locale with an explicit non-UTF-8 charset
    # (e.g. ko_KR.EUC-KR) would print garbage, so fall back to English.
    case "$l" in
        *.*)
            case "$(echo "${l#*.}" | tr '[:upper:]' '[:lower:]')" in
                utf-8*|utf8*) ;;
                *) echo en; return ;;
            esac ;;
    esac
    case "$l" in
        ko*) echo ko ;;
        ja*) echo ja ;;
        *)   echo en ;;
    esac
}

DETECTED_LANG=en
detect_lang() {
    system_locale
    DETECTED_LANG="$(locale_to_lang "$SYSTEM_LOCALE")"
}

apply_lang() {
    case "${RISU_LANG:-}" in
        ko|en|ja) UI_LANG="$RISU_LANG" ;;
        *) UI_LANG="$DETECTED_LANG" ;;
    esac
    "load_lang_$UI_LANG"
}

# --- Korean ----------------------------------------------------------------
load_lang_ko() {
    M_TITLE="RisuAI 노드 서버 셋업 도우미"
    M_PRESS_ENTER="엔터를 누르면 계속합니다..."
    M_MENU_HINT="↑/↓ 이동 · 엔터 선택 · 숫자 바로가기 · q 뒤로"
    M_ASK="%s [기본: %s] "
    M_CONF_SAVED="설정을 저장했습니다: %s"

    M_ENV_TITLE="환경 점검"
    M_ENV_OS="운영체제: %s"
    M_ENV_LANG="언어: %s  (시스템 로켈: %s, 출처: %s)"
    M_ENV_MISSING="없음"
    M_ENV_PRESENT="있음"
    M_ENV_GIT_MISSING="없음 (소스를 받으려면 필요)"
    M_ENV_NODE_OLD="%s — 20.19 이상 또는 22.12 이상이 필요"
    M_ENV_PNPM_MISSING="없음 (설치 시 자동으로 깔아드립니다)"
    M_ENV_DOCKER_MISSING="없음 (Docker 방식에만 필요)"
    M_ENV_OPENSSL_MISSING="없음 (HTTPS 인증서 생성에만 필요)"
    M_ENV_SOURCE="소스"
    M_ENV_SOURCE_MISSING="아직 받지 않음"

    M_GIT_MAC_RETRY="설치 창이 끝난 뒤 다시 실행해 주세요."
    M_NO_PKG_MANAGER="패키지 관리자를 찾지 못했습니다. git 을 직접 설치해 주세요."
    M_NODE_NVM1="nvm(Node 버전 관리자)으로 Node.js 22 LTS 를 설치합니다."
    M_NODE_NVM2="관리자 권한 없이 사용자 폴더(~/.nvm)에 설치됩니다."
    M_NEED_CURL="curl 이 필요합니다. 먼저 curl 을 설치해 주세요."
    M_PNPM_INSTALLING="pnpm 을 설치합니다..."
    M_PNPM_SUDO="전역 설치에 실패했습니다. 권한 문제라면 sudo 로 다시 시도합니다."

    M_SRC_TITLE="RisuAI 소스 준비"
    M_SRC_HERE="이 스크립트가 RisuAI 폴더 안에 있습니다: %s"
    M_GIT_MISSING="git 이 없습니다."
    M_GIT_INSTALL_Q="git 을 설치할까요?"
    M_SRC_WHERE="어디서 소스를 받을까요?"
    M_SRC_OFFICIAL="공식 저장소 (kwaroran/Risuai) — 추천"
    M_SRC_CUSTOM="다른 저장소 주소 직접 입력"
    M_SRC_URL_TITLE="저장소 주소 입력"
    M_SRC_URL="git 주소"
    M_SRC_DIR_TITLE="설치 위치"
    M_SRC_DIR="설치할 폴더"
    M_SRC_EXISTS="이미 받아 둔 소스가 있습니다. 그대로 사용합니다."
    M_SRC_NOT_EMPTY="%s 폴더가 비어 있지 않습니다. 다른 위치를 골라 주세요."
    M_SRC_CLONING="소스를 내려받는 중... (몇 분 걸릴 수 있습니다)"
    M_SRC_CLONE_FAIL="내려받기에 실패했습니다."
    M_SRC_DONE="소스를 받았습니다: %s"

    M_CERT_EXISTS="HTTPS 인증서가 이미 있습니다."
    M_CERT_NO_OPENSSL="openssl 이 없어 인증서를 만들 수 없습니다."
    M_CERT_GEN="자체 서명 인증서를 생성합니다. 질문이 나오면 엔터만 눌러도 됩니다."
    M_CERT_DONE="인증서 생성 완료. 브라우저에서 '안전하지 않음' 경고가 뜨는 것은 정상입니다."
    M_CERT_TRUST="경고를 없애려면 %s 를 기기에 신뢰 인증서로 등록하세요."

    M_DOCKER_BUILDING="Docker 이미지를 빌드합니다... (처음엔 10분 이상 걸릴 수 있습니다)"
    M_NODE_BAD="Node.js 버전이 맞지 않습니다. 환경 점검 메뉴를 확인하세요."
    M_PNPM_FAIL="pnpm 설치에 실패했습니다."
    M_INSTALLING_PKGS="패키지를 설치합니다... (처음엔 몇 분 걸립니다)"
    M_PNPM_INSTALL_FAIL="pnpm install 실패"
    M_BUILDING="프론트엔드를 빌드합니다..."
    M_BUILD_FAIL="빌드 실패"
    M_BUILD_DONE="빌드 완료!"

    M_URL="접속 주소: %s"
    M_URL_LAN="같은 와이파이의 폰/다른 PC: %s"
    M_FIRST_PW="처음 접속하면 비밀번호를 정하는 화면이 나옵니다. 잊지 마세요!"
    M_NO_SOURCE="소스가 없습니다. 먼저 설치 마법사를 진행하세요."
    M_ALREADY_RUNNING="이미 실행 중입니다."
    M_DOCKER_STARTED="Docker 컨테이너를 시작했습니다."
    M_NO_DIST="빌드 결과물이 없습니다. 먼저 빌드합니다."
    M_STARTED="서버를 백그라운드에서 시작했습니다. (PID %s)"
    M_STARTED_BG="터미널을 닫아도 계속 돌아갑니다. 로그: %s"
    M_START_FAIL="서버가 바로 종료되었습니다. 마지막 로그:"
    M_DOCKER_STOPPED="컨테이너를 중지했습니다."
    M_NOT_RUNNING="실행 중이 아닙니다."
    M_STOPPED="서버를 중지했습니다."

    M_STATUS_TITLE="서버 상태"
    M_ST_DIR="설치 위치 : %s"
    M_ST_METHOD="실행 방식 : %s"
    M_ST_PORT="포트      : %s"
    M_RUNNING_DOCKER="실행 중 (Docker)"
    M_RUNNING_PID="실행 중 (PID %s)"
    M_RECENT_LOG="최근 로그:"

    M_UPDATE_TITLE="업데이트"
    M_UPDATE_NOGIT="git 저장소가 아니라 자동 업데이트를 할 수 없습니다."
    M_UPDATE_BACKUP_TIP="업데이트 전에 save 폴더를 백업해 두는 것을 추천합니다."
    M_UPDATE_BACKUP_Q="먼저 백업할까요?"
    M_UPDATE_PULL_FAIL="git pull 실패. 소스를 직접 수정했다면 충돌이 났을 수 있습니다."
    M_UPDATE_DONE="업데이트 완료!"
    M_BACKUP_FAIL="백업 실패"
    M_BACKUP_NODATA="아직 저장된 데이터가 없습니다."
    M_BACKUP_DONE="백업 완료: %s"

    M_PW_TITLE="비밀번호 초기화"
    M_PW_WARN="비밀번호를 지우면 다음 접속 때 새 비밀번호를 정하게 됩니다. 데이터는 지워지지 않습니다."
    M_PROCEED_Q="진행할까요?"
    M_PW_DONE="초기화 완료"
    M_PW_FAIL_DOCKER="실패 (컨테이너가 실행 중인지 확인하세요)"

    M_W1_TITLE="1단계: 실행 방식을 고르세요"
    M_W1_NODE="Node.js 로 직접 실행 — 추천, 가장 간단"
    M_W1_DOCKER="Docker 로 실행 — Docker 를 이미 쓰고 있다면"
    M_W2_TITLE="2단계: 필수 프로그램 확인"
    M_NODE_FOUND="Node.js %s 확인"
    M_NODE_NEED="알맞은 Node.js 가 없습니다. (필요: 20.19 이상 또는 22.12 이상)"
    M_NODE_AUTO_Q="자동으로 설치할까요?"
    M_NODE_INSTALL_FAIL="Node.js 설치 실패. https://nodejs.org 에서 LTS 버전을 직접 설치해 주세요."
    M_NODE_INSTALLED="Node.js %s 설치 완료"
    M_NODE_MANUAL="https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."
    M_DOCKER_MISSING="Docker 가 없습니다. https://docs.docker.com/get-docker/ 에서 설치해 주세요."
    M_DOCKER_DOWN="Docker 가 꺼져 있거나 권한이 없습니다. Docker 를 켜고 다시 시도하세요."
    M_DOCKER_OK="Docker 확인"
    M_W3_TITLE="3단계: 기본 설정"
    M_PORT_Q="포트 번호 (모르면 엔터)"
    M_PORT_INVALID="숫자가 아니라 6001 을 씁니다."
    M_LEGAL_TIP="개인용으로만 쓰는 서버라면 '법적 고지 설정 완료'를 켜야 경고 화면이 뜨지 않습니다."
    M_LEGAL_Q="나 혼자/지인끼리만 쓰는 개인 서버인가요?"
    M_LITE_Q="실험적 라이트(모바일용 경량) 모드를 켤까요?"
    M_PROXY_TIP="Nginx, Caddy, Cloudflare Tunnel 같은 리버스 프록시 뒤에서 돌릴 때만 켜세요."
    M_PROXY_Q="리버스 프록시 뒤에서 실행하나요?"
    M_HTTPS_TIP="다른 기기에서 접속하면서 일부 브라우저 기능(마이크 등)이 필요하면 HTTPS 가 필요합니다."
    M_HTTPS_Q="자체 서명 HTTPS 인증서를 만들까요?"
    M_W4_TITLE="4단계: 빌드"
    M_RUN_NOW_Q="지금 서버를 실행할까요?"
    M_WIZARD_DONE="설치가 끝났습니다! 다음부터는 이 스크립트를 다시 실행해 메뉴에서 시작/중지할 수 있습니다."

    M_SET_TITLE="설정 변경 (변경 후 '다시 빌드'가 필요할 수 있습니다)"
    M_SET_LANG="언어 / Language: %s"
    M_SET_PORT="포트: %s"
    M_SET_LEGAL="개인 서버(법적 고지 설정 완료): %s  ※ 다시 빌드 필요"
    M_SET_LITE="라이트 모드: %s  ※ 다시 빌드 필요"
    M_SET_PROXY="리버스 프록시 신뢰: %s"
    M_OFF="끔"
    M_SET_HTTPS="HTTPS 인증서 만들기"
    M_SET_REBUILD="다시 빌드하기"
    M_BACK="뒤로"
    M_PORT_TITLE="포트"
    M_PORT_NUM="포트 번호"
    M_DIGITS_ONLY="숫자만 입력하세요."
    M_LANG_TITLE="언어 선택 / Language"
    M_LANG_AUTO="자동 — 시스템 로켈 따르기 (%s)"

    M_NEED_TTY="대화형 터미널에서 실행해 주세요:  bash risu-setup.sh"
    M_MAIN_TITLE="메인 메뉴   (서버: %s)"
    M_STATE_RUNNING="실행 중"
    M_STATE_STOPPED="중지됨"
    M_STATE_NOT_INSTALLED="미설치"
    M_MAIN_WIZARD="처음 설치 마법사  — 처음이면 여기부터!"
    M_MAIN_START="서버 시작"
    M_MAIN_STOP="서버 중지"
    M_MAIN_STATUS="상태 / 로그 보기"
    M_MAIN_UPDATE="업데이트 (최신 버전 받기 + 다시 빌드)"
    M_MAIN_BACKUP="데이터 백업 (save 폴더)"
    M_MAIN_PW="비밀번호 초기화"
    M_MAIN_SETTINGS="설정 변경"
    M_MAIN_ENV="환경 점검"
    M_MAIN_EXIT="종료"
    M_BYE="안녕히 가세요!"
}

# --- English ---------------------------------------------------------------
load_lang_en() {
    M_TITLE="RisuAI Node Server Setup"
    M_PRESS_ENTER="Press Enter to continue..."
    M_MENU_HINT="↑/↓ move · Enter select · number jump · q back"
    M_ASK="%s [default: %s] "
    M_CONF_SAVED="Settings saved: %s"

    M_ENV_TITLE="Environment check"
    M_ENV_OS="OS: %s"
    M_ENV_LANG="Language: %s  (system locale: %s, from: %s)"
    M_ENV_MISSING="not found"
    M_ENV_PRESENT="found"
    M_ENV_GIT_MISSING="not found (needed to download the source)"
    M_ENV_NODE_OLD="%s — 20.19+ or 22.12+ is required"
    M_ENV_PNPM_MISSING="not found (will be installed automatically)"
    M_ENV_DOCKER_MISSING="not found (only needed for the Docker method)"
    M_ENV_OPENSSL_MISSING="not found (only needed for HTTPS certificates)"
    M_ENV_SOURCE="source"
    M_ENV_SOURCE_MISSING="not downloaded yet"

    M_GIT_MAC_RETRY="Run this script again after the installer window finishes."
    M_NO_PKG_MANAGER="No package manager found. Please install git manually."
    M_NODE_NVM1="Installing Node.js 22 LTS with nvm (Node Version Manager)."
    M_NODE_NVM2="It goes into your home folder (~/.nvm); no admin rights needed."
    M_NEED_CURL="curl is required. Please install curl first."
    M_PNPM_INSTALLING="Installing pnpm..."
    M_PNPM_SUDO="Global install failed. Retrying with sudo in case it is a permission issue."

    M_SRC_TITLE="Get the RisuAI source"
    M_SRC_HERE="This script is already inside a RisuAI folder: %s"
    M_GIT_MISSING="git is not installed."
    M_GIT_INSTALL_Q="Install git?"
    M_SRC_WHERE="Where should the source come from?"
    M_SRC_OFFICIAL="Official repository (kwaroran/Risuai) — recommended"
    M_SRC_CUSTOM="Enter another repository URL"
    M_SRC_URL_TITLE="Repository URL"
    M_SRC_URL="git URL"
    M_SRC_DIR_TITLE="Install location"
    M_SRC_DIR="Install folder"
    M_SRC_EXISTS="The source is already there. Using it as is."
    M_SRC_NOT_EMPTY="The folder %s is not empty. Please choose another location."
    M_SRC_CLONING="Downloading the source... (this can take a few minutes)"
    M_SRC_CLONE_FAIL="Download failed."
    M_SRC_DONE="Source downloaded: %s"

    M_CERT_EXISTS="An HTTPS certificate already exists."
    M_CERT_NO_OPENSSL="openssl is not installed, so a certificate cannot be created."
    M_CERT_GEN="Creating a self-signed certificate. Just press Enter at each question."
    M_CERT_DONE="Certificate created. A 'Not secure' warning in the browser is expected."
    M_CERT_TRUST="To remove the warning, install %s as a trusted certificate on your device."

    M_DOCKER_BUILDING="Building the Docker image... (the first build can take 10+ minutes)"
    M_NODE_BAD="Your Node.js version is not supported. See the environment check menu."
    M_PNPM_FAIL="Failed to install pnpm."
    M_INSTALLING_PKGS="Installing packages... (the first time takes a few minutes)"
    M_PNPM_INSTALL_FAIL="pnpm install failed"
    M_BUILDING="Building the frontend..."
    M_BUILD_FAIL="Build failed"
    M_BUILD_DONE="Build complete!"

    M_URL="Open: %s"
    M_URL_LAN="From a phone/PC on the same Wi-Fi: %s"
    M_FIRST_PW="On the first visit you will be asked to set a password. Don't forget it!"
    M_NO_SOURCE="No source found. Run the setup wizard first."
    M_ALREADY_RUNNING="Already running."
    M_DOCKER_STARTED="Docker container started."
    M_NO_DIST="No build output found. Building first."
    M_STARTED="Server started in the background. (PID %s)"
    M_STARTED_BG="It keeps running after you close the terminal. Log: %s"
    M_START_FAIL="The server exited right away. Last log lines:"
    M_DOCKER_STOPPED="Container stopped."
    M_NOT_RUNNING="Not running."
    M_STOPPED="Server stopped."

    M_STATUS_TITLE="Server status"
    M_ST_DIR="Location : %s"
    M_ST_METHOD="Method   : %s"
    M_ST_PORT="Port     : %s"
    M_RUNNING_DOCKER="Running (Docker)"
    M_RUNNING_PID="Running (PID %s)"
    M_RECENT_LOG="Recent log:"

    M_UPDATE_TITLE="Update"
    M_UPDATE_NOGIT="Not a git repository, so it cannot be updated automatically."
    M_UPDATE_BACKUP_TIP="Backing up the save folder before updating is recommended."
    M_UPDATE_BACKUP_Q="Back up first?"
    M_UPDATE_PULL_FAIL="git pull failed. If you edited the source yourself, there may be a conflict."
    M_UPDATE_DONE="Update complete!"
    M_BACKUP_FAIL="Backup failed"
    M_BACKUP_NODATA="There is no saved data yet."
    M_BACKUP_DONE="Backup saved: %s"

    M_PW_TITLE="Reset password"
    M_PW_WARN="After this you will set a new password on the next visit. Your data is not deleted."
    M_PROCEED_Q="Proceed?"
    M_PW_DONE="Password reset"
    M_PW_FAIL_DOCKER="Failed (check that the container is running)"

    M_W1_TITLE="Step 1: Choose how to run"
    M_W1_NODE="Run with Node.js — recommended, simplest"
    M_W1_DOCKER="Run with Docker — if you already use Docker"
    M_W2_TITLE="Step 2: Required software"
    M_NODE_FOUND="Node.js %s found"
    M_NODE_NEED="No suitable Node.js found. (Required: 20.19+ or 22.12+)"
    M_NODE_AUTO_Q="Install it automatically?"
    M_NODE_INSTALL_FAIL="Node.js install failed. Please install the LTS version from https://nodejs.org"
    M_NODE_INSTALLED="Node.js %s installed"
    M_NODE_MANUAL="Install the LTS version from https://nodejs.org and run this script again."
    M_DOCKER_MISSING="Docker is not installed. Get it from https://docs.docker.com/get-docker/"
    M_DOCKER_DOWN="Docker is not running or you lack permission. Start Docker and try again."
    M_DOCKER_OK="Docker found"
    M_W3_TITLE="Step 3: Basic settings"
    M_PORT_Q="Port number (press Enter if unsure)"
    M_PORT_INVALID="Not a number, using 6001."
    M_LEGAL_TIP="For a personal server, turn on 'legal configured' to skip the legal warning screen."
    M_LEGAL_Q="Is this a private server just for you or people you know?"
    M_LITE_Q="Enable the experimental Lite (lightweight mobile) mode?"
    M_PROXY_TIP="Only enable this behind a reverse proxy such as Nginx, Caddy or Cloudflare Tunnel."
    M_PROXY_Q="Are you running behind a reverse proxy?"
    M_HTTPS_TIP="Some browser features (e.g. microphone) need HTTPS when accessed from other devices."
    M_HTTPS_Q="Create a self-signed HTTPS certificate?"
    M_W4_TITLE="Step 4: Build"
    M_RUN_NOW_Q="Start the server now?"
    M_WIZARD_DONE="Setup complete! Run this script again any time to start/stop from the menu."

    M_SET_TITLE="Settings (some changes need a rebuild)"
    M_SET_LANG="Language / 언어: %s"
    M_SET_PORT="Port: %s"
    M_SET_LEGAL="Personal server (legal configured): %s  * rebuild needed"
    M_SET_LITE="Lite mode: %s  * rebuild needed"
    M_SET_PROXY="Trust reverse proxy: %s"
    M_OFF="off"
    M_SET_HTTPS="Create HTTPS certificate"
    M_SET_REBUILD="Rebuild"
    M_BACK="Back"
    M_PORT_TITLE="Port"
    M_PORT_NUM="Port number"
    M_DIGITS_ONLY="Please enter digits only."
    M_LANG_TITLE="Language / 언어 / 言語"
    M_LANG_AUTO="Auto — follow system locale (%s)"

    M_NEED_TTY="Please run this in an interactive terminal:  bash risu-setup.sh"
    M_MAIN_TITLE="Main menu   (server: %s)"
    M_STATE_RUNNING="running"
    M_STATE_STOPPED="stopped"
    M_STATE_NOT_INSTALLED="not installed"
    M_MAIN_WIZARD="Setup wizard  — start here!"
    M_MAIN_START="Start server"
    M_MAIN_STOP="Stop server"
    M_MAIN_STATUS="Status / logs"
    M_MAIN_UPDATE="Update (get latest + rebuild)"
    M_MAIN_BACKUP="Back up data (save folder)"
    M_MAIN_PW="Reset password"
    M_MAIN_SETTINGS="Settings"
    M_MAIN_ENV="Environment check"
    M_MAIN_EXIT="Exit"
    M_BYE="Goodbye!"
}

# --- Japanese --------------------------------------------------------------
load_lang_ja() {
    M_TITLE="RisuAI ノードサーバー セットアップ"
    M_PRESS_ENTER="Enter キーで続行します..."
    M_MENU_HINT="↑/↓ 移動 · Enter 決定 · 数字で直接選択 · q 戻る"
    M_ASK="%s [既定: %s] "
    M_CONF_SAVED="設定を保存しました: %s"

    M_ENV_TITLE="環境チェック"
    M_ENV_OS="OS: %s"
    M_ENV_LANG="言語: %s  (システムロケール: %s, 取得元: %s)"
    M_ENV_MISSING="なし"
    M_ENV_PRESENT="あり"
    M_ENV_GIT_MISSING="なし (ソース取得に必要)"
    M_ENV_NODE_OLD="%s — 20.19 以上または 22.12 以上が必要"
    M_ENV_PNPM_MISSING="なし (インストール時に自動で入れます)"
    M_ENV_DOCKER_MISSING="なし (Docker 方式のみ必要)"
    M_ENV_OPENSSL_MISSING="なし (HTTPS 証明書の作成のみ必要)"
    M_ENV_SOURCE="ソース"
    M_ENV_SOURCE_MISSING="未取得"

    M_GIT_MAC_RETRY="インストーラーが終わったら、もう一度実行してください。"
    M_NO_PKG_MANAGER="パッケージマネージャーが見つかりません。git を手動でインストールしてください。"
    M_NODE_NVM1="nvm (Node バージョンマネージャー) で Node.js 22 LTS をインストールします。"
    M_NODE_NVM2="管理者権限なしでホームフォルダ (~/.nvm) に入ります。"
    M_NEED_CURL="curl が必要です。先に curl をインストールしてください。"
    M_PNPM_INSTALLING="pnpm をインストールしています..."
    M_PNPM_SUDO="グローバルインストールに失敗しました。権限の問題かもしれないので sudo で再試行します。"

    M_SRC_TITLE="RisuAI ソースの準備"
    M_SRC_HERE="このスクリプトは RisuAI フォルダ内にあります: %s"
    M_GIT_MISSING="git がありません。"
    M_GIT_INSTALL_Q="git をインストールしますか?"
    M_SRC_WHERE="ソースの取得元を選んでください"
    M_SRC_OFFICIAL="公式リポジトリ (kwaroran/Risuai) — おすすめ"
    M_SRC_CUSTOM="別のリポジトリ URL を入力"
    M_SRC_URL_TITLE="リポジトリ URL"
    M_SRC_URL="git URL"
    M_SRC_DIR_TITLE="インストール先"
    M_SRC_DIR="インストールするフォルダ"
    M_SRC_EXISTS="ソースはすでにあります。そのまま使います。"
    M_SRC_NOT_EMPTY="フォルダ %s は空ではありません。別の場所を選んでください。"
    M_SRC_CLONING="ソースをダウンロードしています... (数分かかることがあります)"
    M_SRC_CLONE_FAIL="ダウンロードに失敗しました。"
    M_SRC_DONE="ソースを取得しました: %s"

    M_CERT_EXISTS="HTTPS 証明書はすでにあります。"
    M_CERT_NO_OPENSSL="openssl がないため証明書を作成できません。"
    M_CERT_GEN="自己署名証明書を作成します。質問には Enter だけで大丈夫です。"
    M_CERT_DONE="証明書を作成しました。ブラウザの「保護されていない通信」警告は正常です。"
    M_CERT_TRUST="警告を消すには %s を端末に信頼済み証明書として登録してください。"

    M_DOCKER_BUILDING="Docker イメージをビルドしています... (初回は 10 分以上かかることがあります)"
    M_NODE_BAD="Node.js のバージョンが合いません。環境チェックを確認してください。"
    M_PNPM_FAIL="pnpm のインストールに失敗しました。"
    M_INSTALLING_PKGS="パッケージをインストールしています... (初回は数分かかります)"
    M_PNPM_INSTALL_FAIL="pnpm install に失敗しました"
    M_BUILDING="フロントエンドをビルドしています..."
    M_BUILD_FAIL="ビルドに失敗しました"
    M_BUILD_DONE="ビルド完了!"

    M_URL="アクセス先: %s"
    M_URL_LAN="同じ Wi-Fi のスマホ/他の PC から: %s"
    M_FIRST_PW="初回アクセス時にパスワード設定画面が出ます。忘れないでください!"
    M_NO_SOURCE="ソースがありません。先にセットアップウィザードを実行してください。"
    M_ALREADY_RUNNING="すでに起動しています。"
    M_DOCKER_STARTED="Docker コンテナを起動しました。"
    M_NO_DIST="ビルド結果がありません。先にビルドします。"
    M_STARTED="サーバーをバックグラウンドで起動しました。(PID %s)"
    M_STARTED_BG="ターミナルを閉じても動き続けます。ログ: %s"
    M_START_FAIL="サーバーがすぐに終了しました。最後のログ:"
    M_DOCKER_STOPPED="コンテナを停止しました。"
    M_NOT_RUNNING="起動していません。"
    M_STOPPED="サーバーを停止しました。"

    M_STATUS_TITLE="サーバーの状態"
    M_ST_DIR="場所     : %s"
    M_ST_METHOD="実行方式 : %s"
    M_ST_PORT="ポート   : %s"
    M_RUNNING_DOCKER="起動中 (Docker)"
    M_RUNNING_PID="起動中 (PID %s)"
    M_RECENT_LOG="最近のログ:"

    M_UPDATE_TITLE="アップデート"
    M_UPDATE_NOGIT="git リポジトリではないため自動アップデートできません。"
    M_UPDATE_BACKUP_TIP="アップデート前に save フォルダのバックアップをおすすめします。"
    M_UPDATE_BACKUP_Q="先にバックアップしますか?"
    M_UPDATE_PULL_FAIL="git pull に失敗しました。ソースを直接編集した場合は競合しているかもしれません。"
    M_UPDATE_DONE="アップデート完了!"
    M_BACKUP_FAIL="バックアップに失敗しました"
    M_BACKUP_NODATA="まだ保存データがありません。"
    M_BACKUP_DONE="バックアップしました: %s"

    M_PW_TITLE="パスワードのリセット"
    M_PW_WARN="次回アクセス時に新しいパスワードを設定します。データは消えません。"
    M_PROCEED_Q="続行しますか?"
    M_PW_DONE="リセット完了"
    M_PW_FAIL_DOCKER="失敗 (コンテナが起動しているか確認してください)"

    M_W1_TITLE="ステップ 1: 実行方式を選んでください"
    M_W1_NODE="Node.js で直接実行 — おすすめ、いちばん簡単"
    M_W1_DOCKER="Docker で実行 — すでに Docker を使っているなら"
    M_W2_TITLE="ステップ 2: 必要なソフトの確認"
    M_NODE_FOUND="Node.js %s を確認"
    M_NODE_NEED="適切な Node.js がありません。(必要: 20.19 以上または 22.12 以上)"
    M_NODE_AUTO_Q="自動でインストールしますか?"
    M_NODE_INSTALL_FAIL="Node.js のインストールに失敗しました。https://nodejs.org から LTS 版を入れてください。"
    M_NODE_INSTALLED="Node.js %s をインストールしました"
    M_NODE_MANUAL="https://nodejs.org から LTS 版を入れてから、もう一度実行してください。"
    M_DOCKER_MISSING="Docker がありません。https://docs.docker.com/get-docker/ から入れてください。"
    M_DOCKER_DOWN="Docker が起動していないか権限がありません。Docker を起動して再試行してください。"
    M_DOCKER_OK="Docker を確認"
    M_W3_TITLE="ステップ 3: 基本設定"
    M_PORT_Q="ポート番号 (わからなければ Enter)"
    M_PORT_INVALID="数字ではないので 6001 を使います。"
    M_LEGAL_TIP="個人用サーバーなら「法的設定済み」をオンにすると警告画面が出ません。"
    M_LEGAL_Q="自分や知り合いだけで使う個人サーバーですか?"
    M_LITE_Q="実験的なライト (モバイル向け軽量) モードを有効にしますか?"
    M_PROXY_TIP="Nginx、Caddy、Cloudflare Tunnel などのリバースプロキシの後ろで動かす場合のみオンにしてください。"
    M_PROXY_Q="リバースプロキシの後ろで動かしますか?"
    M_HTTPS_TIP="他の端末から一部のブラウザ機能 (マイクなど) を使うには HTTPS が必要です。"
    M_HTTPS_Q="自己署名 HTTPS 証明書を作成しますか?"
    M_W4_TITLE="ステップ 4: ビルド"
    M_RUN_NOW_Q="今すぐサーバーを起動しますか?"
    M_WIZARD_DONE="セットアップ完了! 次回からはこのスクリプトのメニューで起動/停止できます。"

    M_SET_TITLE="設定 (変更後に再ビルドが必要な項目があります)"
    M_SET_LANG="言語 / Language: %s"
    M_SET_PORT="ポート: %s"
    M_SET_LEGAL="個人サーバー (法的設定済み): %s  ※ 再ビルドが必要"
    M_SET_LITE="ライトモード: %s  ※ 再ビルドが必要"
    M_SET_PROXY="リバースプロキシを信頼: %s"
    M_OFF="オフ"
    M_SET_HTTPS="HTTPS 証明書を作成"
    M_SET_REBUILD="再ビルド"
    M_BACK="戻る"
    M_PORT_TITLE="ポート"
    M_PORT_NUM="ポート番号"
    M_DIGITS_ONLY="数字だけを入力してください。"
    M_LANG_TITLE="言語 / Language"
    M_LANG_AUTO="自動 — システムロケールに従う (%s)"

    M_NEED_TTY="対話型ターミナルで実行してください:  bash risu-setup.sh"
    M_MAIN_TITLE="メインメニュー   (サーバー: %s)"
    M_STATE_RUNNING="起動中"
    M_STATE_STOPPED="停止中"
    M_STATE_NOT_INSTALLED="未インストール"
    M_MAIN_WIZARD="セットアップウィザード  — 初めてならここから!"
    M_MAIN_START="サーバー起動"
    M_MAIN_STOP="サーバー停止"
    M_MAIN_STATUS="状態 / ログ"
    M_MAIN_UPDATE="アップデート (最新版を取得 + 再ビルド)"
    M_MAIN_BACKUP="データのバックアップ (save フォルダ)"
    M_MAIN_PW="パスワードのリセット"
    M_MAIN_SETTINGS="設定"
    M_MAIN_ENV="環境チェック"
    M_MAIN_EXIT="終了"
    M_BYE="さようなら!"
}

# Formats a message: f "$M_X" arg...
# shellcheck disable=SC2059
f() { local fmt="$1"; shift; printf "$fmt" "$@"; }

# ---------------------------------------------------------------------------
# Terminal helpers
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'
    C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_CYAN=$'\e[36m'
    C_INV=$'\e[7m'
else
    C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_INV=''
fi

cleanup_term() { printf '\e[?25h'; stty echo 2>/dev/null; }
trap cleanup_term EXIT
trap 'cleanup_term; echo; exit 130' INT

info()  { printf '%s[i]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()    { printf '%s[✓]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s[!]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
err()   { printf '%s[✗]%s %s\n' "$C_RED" "$C_RESET" "$*"; }

header() {
    clear 2>/dev/null || printf '\e[2J\e[H'
    printf '%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$C_CYAN" "$C_RESET"
    printf '%s  %s%s\n' "$C_CYAN$C_BOLD" "$M_TITLE" "$C_RESET"
    printf '%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$C_CYAN" "$C_RESET"
    [ -n "${1:-}" ] && printf '%s%s%s\n' "$C_BOLD" "$1" "$C_RESET"
    echo
}

pause() { echo; read -r -p "$M_PRESS_ENTER" _ || true; }

# Reads one key: up / down / enter / esc / the character itself
read_key() {
    local k rest
    IFS= read -rsn1 k || { echo q; return; }
    if [ "$k" = $'\e' ]; then
        IFS= read -rsn2 -t 1 rest || rest=''
        case "$rest" in
            '[A'|'OA') echo up ;;
            '[B'|'OB') echo down ;;
            *) echo esc ;;
        esac
    elif [ -z "$k" ]; then
        echo enter
    else
        case "$k" in
            k|K) echo up ;;
            j|J) echo down ;;
            *) echo "$k" ;;
        esac
    fi
}

# Arrow-key menu. menu "title" "item1" "item2" ... → MENU_RESULT (0-based), -1 on cancel
MENU_RESULT=-1
menu() {
    local title="$1"; shift
    local items=("$@") n=$# sel=0 i key
    printf '\e[?25l'
    while true; do
        header "$title"
        for ((i = 0; i < n; i++)); do
            if [ "$i" -eq "$sel" ]; then
                printf '  %s ▶ %d. %s %s\n' "$C_INV" $((i + 1)) "${items[$i]}" "$C_RESET"
            else
                printf '    %d. %s\n' $((i + 1)) "${items[$i]}"
            fi
        done
        printf '\n%s %s%s\n' "$C_DIM" "$M_MENU_HINT" "$C_RESET"
        key="$(read_key)"
        case "$key" in
            up)    sel=$(( (sel - 1 + n) % n )) ;;
            down)  sel=$(( (sel + 1) % n )) ;;
            enter) MENU_RESULT=$sel; break ;;
            q|Q|esc) MENU_RESULT=-1; break ;;
            [1-9])
                if [ "$key" -le "$n" ]; then MENU_RESULT=$((key - 1)); break; fi ;;
        esac
    done
    printf '\e[?25h'
}

# Yes/no. confirm "question" [default y|n]
confirm() {
    local q="$1" def="${2:-y}" ans hint
    [ "$def" = y ] && hint="Y/n" || hint="y/N"
    read -r -p "$q [$hint] " ans || ans=''
    ans="${ans:-$def}"
    case "$ans" in y|Y|yes|YES|Yes|예|네|ㅇ|はい|うん) return 0 ;; *) return 1 ;; esac
}

# Value prompt. ask "question" "default" → ASK_RESULT
ASK_RESULT=''
ask() {
    local ans
    read -r -p "$(f "$M_ASK" "$1" "$2")" ans || ans=''
    ASK_RESULT="${ans:-$2}"
}

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_conf() {
    # shellcheck disable=SC1090
    [ -f "$CONF_FILE" ] && . "$CONF_FILE"
}

save_conf() {
    cat > "$CONF_FILE" <<EOF
# Generated by risu-setup.sh
RISU_DIR='$RISU_DIR'
RISU_METHOD='$RISU_METHOD'
RISU_PORT='$RISU_PORT'
RISU_LEGAL='$RISU_LEGAL'
RISU_LITE='$RISU_LITE'
RISU_TRUST_PROXY='$RISU_TRUST_PROXY'
RISU_HTTPS='$RISU_HTTPS'
RISU_LANG='$RISU_LANG'
EOF
    ok "$(f "$M_CONF_SAVED" "$CONF_FILE")"
}

PID_FILE() { echo "$RISU_DIR/.risu-server.pid"; }
LOG_FILE() { echo "$RISU_DIR/risu-server.log"; }

# ---------------------------------------------------------------------------
# Environment checks
# ---------------------------------------------------------------------------
has() { command -v "$1" >/dev/null 2>&1; }

detect_os() {
    if [ -n "${PREFIX:-}" ] && echo "$PREFIX" | grep -q com.termux; then echo termux
    elif grep -qi microsoft /proc/version 2>/dev/null; then echo wsl
    else
        case "$(uname -s)" in
            Darwin) echo mac ;;
            Linux) echo linux ;;
            *) echo other ;;
        esac
    fi
}

# Node 20.19+ or 22.12+
node_ok() {
    has node || return 1
    local v major minor
    v="$(node -v 2>/dev/null | sed 's/^v//')"
    major="${v%%.*}"; minor="$(echo "$v" | cut -d. -f2)"
    [ "$major" -gt 22 ] && return 0
    [ "$major" -eq 22 ] && [ "$minor" -ge 12 ] && return 0
    [ "$major" -eq 21 ] && return 1
    [ "$major" -eq 20 ] && [ "$minor" -ge 19 ] && return 0
    return 1
}

is_risu_repo() {
    [ -f "$1/package.json" ] && [ -f "$1/server/node/server.cjs" ]
}

status_line() {
    local label="$1" state="$2" detail="$3"
    if [ "$state" = ok ]; then printf '  %s✓%s %-8s %s\n' "$C_GREEN" "$C_RESET" "$label" "$detail"
    else printf '  %s✗%s %-8s %s\n' "$C_RED" "$C_RESET" "$label" "$detail"; fi
}

check_env() {
    header "$M_ENV_TITLE"
    echo "  $(f "$M_ENV_OS" "$(detect_os)")"
    echo "  $(f "$M_ENV_LANG" "$(lang_name "$UI_LANG")" "$SYSTEM_LOCALE" "$LOCALE_SOURCE")"
    echo
    if has git; then status_line git ok "$(git --version | awk '{print $3}')"
    else status_line git no "$M_ENV_GIT_MISSING"; fi
    if node_ok; then status_line node ok "$(node -v)"
    elif has node; then status_line node no "$(f "$M_ENV_NODE_OLD" "$(node -v)")"
    else status_line node no "$M_ENV_MISSING"; fi
    if has pnpm; then status_line pnpm ok "$(pnpm -v 2>/dev/null)"
    else status_line pnpm no "$M_ENV_PNPM_MISSING"; fi
    if has docker; then status_line docker ok "$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"
    else status_line docker no "$M_ENV_DOCKER_MISSING"; fi
    if has openssl; then status_line openssl ok "$M_ENV_PRESENT"
    else status_line openssl no "$M_ENV_OPENSSL_MISSING"; fi
    echo
    if is_risu_repo "$RISU_DIR"; then status_line "$M_ENV_SOURCE" ok "$RISU_DIR"
    else status_line "$M_ENV_SOURCE" no "$M_ENV_SOURCE_MISSING"; fi
}

# ---------------------------------------------------------------------------
# Installers
# ---------------------------------------------------------------------------
install_git() {
    case "$(detect_os)" in
        termux) pkg install -y git ;;
        mac) xcode-select --install || true; warn "$M_GIT_MAC_RETRY" ;;
        *)
            if has apt-get; then sudo apt-get update && sudo apt-get install -y git
            elif has dnf; then sudo dnf install -y git
            elif has pacman; then sudo pacman -S --noconfirm git
            else err "$M_NO_PKG_MANAGER"; return 1; fi ;;
    esac
}

install_node() {
    if [ "$(detect_os)" = termux ]; then
        pkg install -y nodejs-lts && return 0
        return 1
    fi
    info "$M_NODE_NVM1"
    info "$M_NODE_NVM2"
    if ! has curl; then err "$M_NEED_CURL"; return 1; fi
    export NVM_DIR="$HOME/.nvm"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash || return 1
    fi
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install 22 && nvm alias default 22 && nvm use 22
    hash -r
    node_ok
}

# Makes an nvm-installed node usable in this session too
use_nvm_if_present() {
    if ! node_ok && [ -s "$HOME/.nvm/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
        nvm use default >/dev/null 2>&1 || true
    fi
}

ensure_pnpm() {
    if has pnpm; then return 0; fi
    info "$M_PNPM_INSTALLING"
    if has corepack && corepack enable 2>/dev/null && corepack prepare "pnpm@$PNPM_VERSION" --activate 2>/dev/null; then
        hash -r; has pnpm && return 0
    fi
    npm install -g "pnpm@$PNPM_VERSION" || {
        warn "$M_PNPM_SUDO"
        sudo npm install -g "pnpm@$PNPM_VERSION"
    }
    hash -r
    has pnpm
}

get_source() {
    header "$M_SRC_TITLE"
    if is_risu_repo "$SCRIPT_DIR"; then
        ok "$(f "$M_SRC_HERE" "$SCRIPT_DIR")"
        RISU_DIR="$SCRIPT_DIR"
        return 0
    fi
    if ! has git; then
        warn "$M_GIT_MISSING"
        confirm "$M_GIT_INSTALL_Q" y && install_git || return 1
    fi
    menu "$M_SRC_WHERE" "$M_SRC_OFFICIAL" "$M_SRC_CUSTOM"
    local url="$UPSTREAM_URL"
    case "$MENU_RESULT" in
        -1) return 1 ;;
        1) header "$M_SRC_URL_TITLE"; ask "$M_SRC_URL" "$UPSTREAM_URL"; url="$ASK_RESULT" ;;
    esac
    header "$M_SRC_DIR_TITLE"
    ask "$M_SRC_DIR" "$HOME/risuai"
    RISU_DIR="$ASK_RESULT"
    if is_risu_repo "$RISU_DIR"; then
        ok "$M_SRC_EXISTS"
        return 0
    fi
    if [ -e "$RISU_DIR" ] && [ -n "$(ls -A "$RISU_DIR" 2>/dev/null)" ]; then
        err "$(f "$M_SRC_NOT_EMPTY" "$RISU_DIR")"
        return 1
    fi
    info "$M_SRC_CLONING"
    git clone --depth 1 "$url" "$RISU_DIR" || { err "$M_SRC_CLONE_FAIL"; return 1; }
    ok "$(f "$M_SRC_DONE" "$RISU_DIR")"
}

gen_cert() {
    local d="$RISU_DIR/server/node/ssl"
    if [ -f "$d/certificate/server.crt" ]; then ok "$M_CERT_EXISTS"; return 0; fi
    has openssl || { err "$M_CERT_NO_OPENSSL"; return 1; }
    info "$M_CERT_GEN"
    (cd "$d" && bash "Generate Certificate.sh") || return 1
    ok "$M_CERT_DONE"
    info "$(f "$M_CERT_TRUST" "$d/certificate/ca.crt")"
}

# ---------------------------------------------------------------------------
# Build / run
# ---------------------------------------------------------------------------
build_env() {
    export VITE_RISU_LEGAL_CONFIGURED="$RISU_LEGAL"
    if [ "$RISU_LITE" = TRUE ]; then export VITE_RISU_LITE=TRUE; else unset VITE_RISU_LITE; fi
}

run_env() {
    export NODE_ENV=production PORT="$RISU_PORT"
    if [ -n "$RISU_TRUST_PROXY" ]; then export TRUST_PROXY="$RISU_TRUST_PROXY"; else unset TRUST_PROXY; fi
}

do_build() {
    if [ "$RISU_METHOD" = docker ]; then
        info "$M_DOCKER_BUILDING"
        (cd "$RISU_DIR" && docker build -t risuai-local .)
        return
    fi
    use_nvm_if_present
    node_ok || { err "$M_NODE_BAD"; return 1; }
    ensure_pnpm || { err "$M_PNPM_FAIL"; return 1; }
    build_env
    info "$M_INSTALLING_PKGS"
    (cd "$RISU_DIR" && pnpm install) || { err "$M_PNPM_INSTALL_FAIL"; return 1; }
    info "$M_BUILDING"
    (cd "$RISU_DIR" && pnpm run build) || { err "$M_BUILD_FAIL"; return 1; }
    ok "$M_BUILD_DONE"
}

server_pid() {
    local f; f="$(PID_FILE)"
    [ -f "$f" ] || return 1
    local p; p="$(cat "$f")"
    kill -0 "$p" 2>/dev/null && { echo "$p"; return 0; }
    rm -f "$f"; return 1
}

docker_running() {
    has docker && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx risuai
}

print_urls() {
    local scheme=http
    [ -f "$RISU_DIR/server/node/ssl/certificate/server.crt" ] && [ "$RISU_METHOD" = node ] && scheme=https
    echo
    ok "$(f "$M_URL" "${C_BOLD}$scheme://localhost:$RISU_PORT${C_RESET}")"
    local ip=''
    if has hostname && hostname -I >/dev/null 2>&1; then ip="$(hostname -I | awk '{print $1}')"
    elif has ipconfig; then ip="$(ipconfig getifaddr en0 2>/dev/null || true)"; fi
    [ -n "$ip" ] && info "$(f "$M_URL_LAN" "$scheme://$ip:$RISU_PORT")"
    info "$M_FIRST_PW"
}

start_server() {
    is_risu_repo "$RISU_DIR" || { err "$M_NO_SOURCE"; return 1; }
    if [ "$RISU_METHOD" = docker ]; then
        if docker_running; then warn "$M_ALREADY_RUNNING"; print_urls; return 0; fi
        docker rm -f risuai >/dev/null 2>&1 || true
        local tp=()
        [ -n "$RISU_TRUST_PROXY" ] && tp=(-e "TRUST_PROXY=$RISU_TRUST_PROXY")
        docker run -d --name risuai --restart unless-stopped \
            -p "$RISU_PORT:6001" -v risuai-save:/app/save "${tp[@]+"${tp[@]}"}" risuai-local \
            && ok "$M_DOCKER_STARTED" && print_urls
        return
    fi
    if server_pid >/dev/null; then warn "$M_ALREADY_RUNNING (PID $(server_pid))"; print_urls; return 0; fi
    if [ ! -d "$RISU_DIR/dist" ]; then
        warn "$M_NO_DIST"
        do_build || return 1
    fi
    use_nvm_if_present
    run_env
    (cd "$RISU_DIR" && nohup node server/node/server.cjs >>"$(LOG_FILE)" 2>&1 & echo $! >"$(PID_FILE)")
    sleep 2
    if server_pid >/dev/null; then
        ok "$(f "$M_STARTED" "$(server_pid)")"
        info "$(f "$M_STARTED_BG" "$(LOG_FILE)")"
        print_urls
    else
        err "$M_START_FAIL"
        tail -n 20 "$(LOG_FILE)" 2>/dev/null
        return 1
    fi
}

stop_server() {
    if [ "$RISU_METHOD" = docker ]; then
        docker stop risuai >/dev/null 2>&1 && ok "$M_DOCKER_STOPPED" || warn "$M_NOT_RUNNING"
        return
    fi
    local p
    if p="$(server_pid)"; then
        kill "$p" && rm -f "$(PID_FILE)" && ok "$M_STOPPED"
    else
        warn "$M_NOT_RUNNING"
    fi
}

show_status() {
    header "$M_STATUS_TITLE"
    echo "  $(f "$M_ST_DIR" "$RISU_DIR")"
    echo "  $(f "$M_ST_METHOD" "$RISU_METHOD")"
    echo "  $(f "$M_ST_PORT" "$RISU_PORT")"
    echo
    if [ "$RISU_METHOD" = docker ]; then
        docker_running && ok "$M_RUNNING_DOCKER" || warn "$M_STATE_STOPPED"
    else
        server_pid >/dev/null && ok "$(f "$M_RUNNING_PID" "$(server_pid)")" || warn "$M_STATE_STOPPED"
        if [ -f "$(LOG_FILE)" ]; then
            echo; info "$M_RECENT_LOG"; tail -n 15 "$(LOG_FILE)"
        fi
    fi
}

update_server() {
    header "$M_UPDATE_TITLE"
    has git && [ -d "$RISU_DIR/.git" ] || { err "$M_UPDATE_NOGIT"; return 1; }
    info "$M_UPDATE_BACKUP_TIP"
    confirm "$M_UPDATE_BACKUP_Q" y && backup_save
    local was_running=0
    { server_pid >/dev/null || docker_running; } && was_running=1
    [ "$was_running" = 1 ] && stop_server
    (cd "$RISU_DIR" && git pull --ff-only) || { err "$M_UPDATE_PULL_FAIL"; return 1; }
    do_build || return 1
    [ "$was_running" = 1 ] && start_server
    ok "$M_UPDATE_DONE"
}

backup_save() {
    local ts out; ts="$(date +%Y%m%d-%H%M%S)"; out="$RISU_DIR/backup-save-$ts.tar.gz"
    if [ "$RISU_METHOD" = docker ]; then
        docker run --rm -v risuai-save:/save -v "$RISU_DIR":/out alpine \
            tar czf "/out/backup-save-$ts.tar.gz" -C / save || { err "$M_BACKUP_FAIL"; return 1; }
    else
        [ -d "$RISU_DIR/save" ] || { warn "$M_BACKUP_NODATA"; return 0; }
        tar czf "$out" -C "$RISU_DIR" save || { err "$M_BACKUP_FAIL"; return 1; }
    fi
    ok "$(f "$M_BACKUP_DONE" "$out")"
}

reset_password() {
    header "$M_PW_TITLE"
    warn "$M_PW_WARN"
    confirm "$M_PROCEED_Q" n || return 0
    if [ "$RISU_METHOD" = docker ]; then
        docker exec risuai rm -f /app/save/__password && docker restart risuai >/dev/null \
            && ok "$M_PW_DONE" || err "$M_PW_FAIL_DOCKER"
        return
    fi
    rm -f "$RISU_DIR/save/__password"
    if server_pid >/dev/null; then stop_server; start_server; fi
    ok "$M_PW_DONE"
}

# ---------------------------------------------------------------------------
# Setup wizard
# ---------------------------------------------------------------------------
wizard() {
    # 1. Method
    menu "$M_W1_TITLE" "$M_W1_NODE" "$M_W1_DOCKER"
    case "$MENU_RESULT" in -1) return ;; 0) RISU_METHOD=node ;; 1) RISU_METHOD=docker ;; esac

    # 2. Prerequisites
    header "$M_W2_TITLE"
    if [ "$RISU_METHOD" = node ]; then
        use_nvm_if_present
        if node_ok; then ok "$(f "$M_NODE_FOUND" "$(node -v)")"
        else
            warn "$M_NODE_NEED"
            if confirm "$M_NODE_AUTO_Q" y; then
                install_node || { err "$M_NODE_INSTALL_FAIL"; pause; return; }
                ok "$(f "$M_NODE_INSTALLED" "$(node -v)")"
            else
                info "$M_NODE_MANUAL"; pause; return
            fi
        fi
    else
        has docker || { err "$M_DOCKER_MISSING"; pause; return; }
        docker info >/dev/null 2>&1 || { err "$M_DOCKER_DOWN"; pause; return; }
        ok "$M_DOCKER_OK"
    fi
    sleep 1

    # 3. Source
    get_source || { pause; return; }
    sleep 1

    # 4. Options
    header "$M_W3_TITLE"
    ask "$M_PORT_Q" "$RISU_PORT"
    case "$ASK_RESULT" in *[!0-9]*|'') warn "$M_PORT_INVALID"; RISU_PORT=6001 ;; *) RISU_PORT="$ASK_RESULT" ;; esac
    echo
    info "$M_LEGAL_TIP"
    if confirm "$M_LEGAL_Q" y; then RISU_LEGAL=TRUE; else RISU_LEGAL=FALSE; fi
    echo
    if confirm "$M_LITE_Q" n; then RISU_LITE=TRUE; else RISU_LITE=FALSE; fi
    echo
    info "$M_PROXY_TIP"
    if confirm "$M_PROXY_Q" n; then RISU_TRUST_PROXY=1; else RISU_TRUST_PROXY=''; fi
    if [ "$RISU_METHOD" = node ]; then
        echo
        info "$M_HTTPS_TIP"
        if confirm "$M_HTTPS_Q" n; then RISU_HTTPS=TRUE; gen_cert; else RISU_HTTPS=FALSE; fi
    fi
    echo
    save_conf
    sleep 1

    # 5. Build
    header "$M_W4_TITLE"
    do_build || { pause; return; }

    # 6. Run
    echo
    if confirm "$M_RUN_NOW_Q" y; then start_server; fi
    echo
    ok "$M_WIZARD_DONE"
    pause
}

lang_menu() {
    local opts=("$(f "$M_LANG_AUTO" "$(lang_name "$DETECTED_LANG")")") l
    for l in $SUPPORTED_LANGS; do opts+=("$(lang_name "$l")"); done
    menu "$M_LANG_TITLE" "${opts[@]}"
    case "$MENU_RESULT" in
        -1) return ;;
        0) RISU_LANG='' ;;
        *) set -- $SUPPORTED_LANGS; shift $((MENU_RESULT - 1)); RISU_LANG="$1" ;;
    esac
    apply_lang
    save_conf
}

settings_menu() {
    local cur_lang
    while true; do
        if [ -n "$RISU_LANG" ]; then cur_lang="$(lang_name "$RISU_LANG")"
        else cur_lang="$(f "$M_LANG_AUTO" "$(lang_name "$DETECTED_LANG")")"; fi
        menu "$M_SET_TITLE" \
            "$(f "$M_SET_LANG" "$cur_lang")" \
            "$(f "$M_SET_PORT" "$RISU_PORT")" \
            "$(f "$M_SET_LEGAL" "$RISU_LEGAL")" \
            "$(f "$M_SET_LITE" "$RISU_LITE")" \
            "$(f "$M_SET_PROXY" "${RISU_TRUST_PROXY:-$M_OFF}")" \
            "$M_SET_HTTPS" \
            "$M_SET_REBUILD" \
            "$M_BACK"
        case "$MENU_RESULT" in
            0) lang_menu ;;
            1) header "$M_PORT_TITLE"; ask "$M_PORT_NUM" "$RISU_PORT"
               case "$ASK_RESULT" in *[!0-9]*|'') warn "$M_DIGITS_ONLY"; pause ;; *) RISU_PORT="$ASK_RESULT"; save_conf ;; esac ;;
            2) [ "$RISU_LEGAL" = TRUE ] && RISU_LEGAL=FALSE || RISU_LEGAL=TRUE; save_conf ;;
            3) [ "$RISU_LITE" = TRUE ] && RISU_LITE=FALSE || RISU_LITE=TRUE; save_conf ;;
            4) [ -n "$RISU_TRUST_PROXY" ] && RISU_TRUST_PROXY='' || RISU_TRUST_PROXY=1; save_conf ;;
            5) header "HTTPS"; gen_cert; RISU_HTTPS=TRUE; save_conf; pause ;;
            6) header "$M_SET_REBUILD"; do_build; pause ;;
            *) return ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    local cli_lang="" env_lang="${RISU_LANG:-}"
    while [ $# -gt 0 ]; do
        case "$1" in
            --lang) cli_lang="${2:-}"; shift 2 || shift ;;
            --lang=*) cli_lang="${1#--lang=}"; shift ;;
            *) shift ;;
        esac
    done
    load_conf
    # Priority: --lang > RISU_LANG env > saved setting > system locale
    [ -n "$env_lang" ] && RISU_LANG="$env_lang"
    [ -n "$cli_lang" ] && RISU_LANG="$cli_lang"
    case "$RISU_LANG" in ko|en|ja|'') ;; *) RISU_LANG='' ;; esac
    detect_lang
    apply_lang

    if [ ! -t 0 ]; then
        err "$M_NEED_TTY"
        exit 1
    fi
    while true; do
        local state="$M_STATE_STOPPED"
        if [ "$RISU_METHOD" = docker ]; then docker_running && state="$M_STATE_RUNNING"
        else server_pid >/dev/null && state="$M_STATE_RUNNING"; fi
        is_risu_repo "$RISU_DIR" || state="$M_STATE_NOT_INSTALLED"
        menu "$(f "$M_MAIN_TITLE" "$state")" \
            "$M_MAIN_WIZARD" \
            "$M_MAIN_START" \
            "$M_MAIN_STOP" \
            "$M_MAIN_STATUS" \
            "$M_MAIN_UPDATE" \
            "$M_MAIN_BACKUP" \
            "$M_MAIN_PW" \
            "$M_MAIN_SETTINGS" \
            "$M_MAIN_ENV" \
            "$M_MAIN_EXIT"
        case "$MENU_RESULT" in
            0) wizard ;;
            1) header "$M_MAIN_START"; start_server; pause ;;
            2) header "$M_MAIN_STOP"; stop_server; pause ;;
            3) show_status; pause ;;
            4) update_server; pause ;;
            5) header "$M_MAIN_BACKUP"; backup_save; pause ;;
            6) reset_password; pause ;;
            7) settings_menu ;;
            8) check_env; pause ;;
            *) clear 2>/dev/null; echo "$M_BYE"; exit 0 ;;
        esac
    done
}

main "$@"
