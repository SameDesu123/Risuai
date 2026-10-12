#!/usr/bin/env bash
# RisuAI Node 서버 초보자용 TUI 셋업 스크립트
# 외부 의존성 없이 bash 만으로 동작합니다. (Linux / macOS / WSL / Termux)
#
#   사용법: bash risu-setup.sh
#
# 설정은 .risu-setup.env 에 저장되고, 실행 로그는 risu-server.log 에 남습니다.

set -u

# ---------------------------------------------------------------------------
# 기본값
# ---------------------------------------------------------------------------
UPSTREAM_URL="https://github.com/kwaroran/Risuai.git"
PNPM_VERSION="10.34.1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_FILE="$SCRIPT_DIR/.risu-setup.env"

RISU_DIR="$SCRIPT_DIR"
RISU_METHOD="node"        # node | docker
RISU_PORT="6001"
RISU_LEGAL="TRUE"         # 개인용 자가호스팅이면 TRUE
RISU_LITE="FALSE"
RISU_TRUST_PROXY=""       # 리버스 프록시 뒤라면 1
RISU_HTTPS="FALSE"

# ---------------------------------------------------------------------------
# 터미널 유틸
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
    printf '%s╔══════════════════════════════════════════╗%s\n' "$C_CYAN" "$C_RESET"
    printf '%s║        RisuAI 노드 서버 셋업 도우미      ║%s\n' "$C_CYAN" "$C_RESET"
    printf '%s╚══════════════════════════════════════════╝%s\n' "$C_CYAN" "$C_RESET"
    [ -n "${1:-}" ] && printf '%s%s%s\n' "$C_BOLD" "$1" "$C_RESET"
    echo
}

pause() { echo; read -r -p "엔터를 누르면 계속합니다..." _ || true; }

# 키 하나 읽기: up / down / enter / q / 숫자
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

# 방향키 메뉴. menu "제목" "항목1" "항목2" ... → MENU_RESULT 에 선택 인덱스(0부터), 취소 시 -1
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
        printf '\n%s ↑/↓ 이동 · 엔터 선택 · 숫자 바로가기 · q 뒤로%s\n' "$C_DIM" "$C_RESET"
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

# 예/아니오. confirm "질문" [기본값 y|n]
confirm() {
    local q="$1" def="${2:-y}" ans hint
    [ "$def" = y ] && hint="Y/n" || hint="y/N"
    read -r -p "$q [$hint] " ans || ans=''
    ans="${ans:-$def}"
    case "$ans" in y|Y|yes|YES|예|ㅇ) return 0 ;; *) return 1 ;; esac
}

# 값 입력. ask "질문" "기본값" → ASK_RESULT
ASK_RESULT=''
ask() {
    local ans
    read -r -p "$1 [기본: $2] " ans || ans=''
    ASK_RESULT="${ans:-$2}"
}

# ---------------------------------------------------------------------------
# 설정 저장/불러오기
# ---------------------------------------------------------------------------
load_conf() {
    # shellcheck disable=SC1090
    [ -f "$CONF_FILE" ] && . "$CONF_FILE"
}

save_conf() {
    cat > "$CONF_FILE" <<EOF
# risu-setup.sh 가 생성한 설정 파일입니다.
RISU_DIR='$RISU_DIR'
RISU_METHOD='$RISU_METHOD'
RISU_PORT='$RISU_PORT'
RISU_LEGAL='$RISU_LEGAL'
RISU_LITE='$RISU_LITE'
RISU_TRUST_PROXY='$RISU_TRUST_PROXY'
RISU_HTTPS='$RISU_HTTPS'
EOF
    ok "설정을 저장했습니다: $CONF_FILE"
}

PID_FILE() { echo "$RISU_DIR/.risu-server.pid"; }
LOG_FILE() { echo "$RISU_DIR/risu-server.log"; }

# ---------------------------------------------------------------------------
# 환경 점검
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

# Node 20.19+ 또는 22.12+ 인지
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
    if [ "$state" = ok ]; then printf '  %s✓%s %-10s %s\n' "$C_GREEN" "$C_RESET" "$label" "$detail"
    else printf '  %s✗%s %-10s %s\n' "$C_RED" "$C_RESET" "$label" "$detail"; fi
}

check_env() {
    header "환경 점검"
    echo "  운영체제: $(detect_os)"
    echo
    if has git; then status_line git ok "$(git --version | awk '{print $3}')"
    else status_line git no "없음 (소스를 받으려면 필요)"; fi
    if node_ok; then status_line node ok "$(node -v)"
    elif has node; then status_line node no "$(node -v) — 20.19 이상 또는 22.12 이상이 필요"
    else status_line node no "없음"; fi
    if has pnpm; then status_line pnpm ok "$(pnpm -v 2>/dev/null)"
    else status_line pnpm no "없음 (설치 시 자동으로 깔아드립니다)"; fi
    if has docker; then status_line docker ok "$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"
    else status_line docker no "없음 (Docker 방식에만 필요)"; fi
    if has openssl; then status_line openssl ok "있음"
    else status_line openssl no "없음 (HTTPS 인증서 생성에만 필요)"; fi
    echo
    if is_risu_repo "$RISU_DIR"; then status_line 소스 ok "$RISU_DIR"
    else status_line 소스 no "아직 받지 않음"; fi
}

# ---------------------------------------------------------------------------
# 설치 보조
# ---------------------------------------------------------------------------
install_git() {
    case "$(detect_os)" in
        termux) pkg install -y git ;;
        mac) xcode-select --install || true; warn "설치 창이 끝난 뒤 다시 실행해 주세요." ;;
        *)
            if has apt-get; then sudo apt-get update && sudo apt-get install -y git
            elif has dnf; then sudo dnf install -y git
            elif has pacman; then sudo pacman -S --noconfirm git
            else err "패키지 관리자를 찾지 못했습니다. git 을 직접 설치해 주세요."; return 1; fi ;;
    esac
}

install_node() {
    if [ "$(detect_os)" = termux ]; then
        pkg install -y nodejs-lts && return 0
        return 1
    fi
    info "nvm(Node 버전 관리자)으로 Node.js 22 LTS 를 설치합니다."
    info "관리자 권한 없이 사용자 폴더(~/.nvm)에 설치됩니다."
    if ! has curl; then err "curl 이 필요합니다. 먼저 curl 을 설치해 주세요."; return 1; fi
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

# nvm 으로 깐 node 를 이번 세션에서도 쓸 수 있게
use_nvm_if_present() {
    if ! node_ok && [ -s "$HOME/.nvm/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
        nvm use default >/dev/null 2>&1 || true
    fi
}

ensure_pnpm() {
    if has pnpm; then return 0; fi
    info "pnpm 을 설치합니다..."
    if has corepack && corepack enable 2>/dev/null && corepack prepare "pnpm@$PNPM_VERSION" --activate 2>/dev/null; then
        hash -r; has pnpm && return 0
    fi
    npm install -g "pnpm@$PNPM_VERSION" || {
        warn "전역 설치에 실패했습니다. 권한 문제라면 sudo 로 다시 시도합니다."
        sudo npm install -g "pnpm@$PNPM_VERSION"
    }
    hash -r
    has pnpm
}

get_source() {
    header "RisuAI 소스 준비"
    if is_risu_repo "$SCRIPT_DIR"; then
        ok "이 스크립트가 RisuAI 폴더 안에 있습니다: $SCRIPT_DIR"
        RISU_DIR="$SCRIPT_DIR"
        return 0
    fi
    if ! has git; then
        warn "git 이 없습니다."
        confirm "git 을 설치할까요?" y && install_git || return 1
    fi
    menu "어디서 소스를 받을까요?" "공식 저장소 (kwaroran/Risuai) — 추천" "다른 저장소 주소 직접 입력"
    local url="$UPSTREAM_URL"
    case "$MENU_RESULT" in
        -1) return 1 ;;
        1) header "저장소 주소 입력"; ask "git 주소" "$UPSTREAM_URL"; url="$ASK_RESULT" ;;
    esac
    header "설치 위치"
    ask "설치할 폴더" "$HOME/risuai"
    RISU_DIR="$ASK_RESULT"
    if is_risu_repo "$RISU_DIR"; then
        ok "이미 받아 둔 소스가 있습니다. 그대로 사용합니다."
        return 0
    fi
    if [ -e "$RISU_DIR" ] && [ -n "$(ls -A "$RISU_DIR" 2>/dev/null)" ]; then
        err "$RISU_DIR 폴더가 비어 있지 않습니다. 다른 위치를 골라 주세요."
        return 1
    fi
    info "소스를 내려받는 중... (몇 분 걸릴 수 있습니다)"
    git clone --depth 1 "$url" "$RISU_DIR" || { err "내려받기에 실패했습니다."; return 1; }
    ok "소스를 받았습니다: $RISU_DIR"
}

gen_cert() {
    local d="$RISU_DIR/server/node/ssl"
    if [ -f "$d/certificate/server.crt" ]; then ok "HTTPS 인증서가 이미 있습니다."; return 0; fi
    has openssl || { err "openssl 이 없어 인증서를 만들 수 없습니다."; return 1; }
    info "자체 서명 인증서를 생성합니다. 질문이 나오면 엔터만 눌러도 됩니다."
    (cd "$d" && bash "Generate Certificate.sh") || return 1
    ok "인증서 생성 완료. 브라우저에서 '안전하지 않음' 경고가 뜨는 것은 정상입니다."
    info "경고를 없애려면 $d/certificate/ca.crt 를 기기에 신뢰 인증서로 등록하세요."
}

# ---------------------------------------------------------------------------
# 빌드 / 실행
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
        info "Docker 이미지를 빌드합니다... (처음엔 10분 이상 걸릴 수 있습니다)"
        (cd "$RISU_DIR" && docker build -t risuai-local .)
        return
    fi
    use_nvm_if_present
    node_ok || { err "Node.js 버전이 맞지 않습니다. 환경 점검 메뉴를 확인하세요."; return 1; }
    ensure_pnpm || { err "pnpm 설치에 실패했습니다."; return 1; }
    build_env
    info "패키지를 설치합니다... (처음엔 몇 분 걸립니다)"
    (cd "$RISU_DIR" && pnpm install) || { err "pnpm install 실패"; return 1; }
    info "프론트엔드를 빌드합니다..."
    (cd "$RISU_DIR" && pnpm run build) || { err "빌드 실패"; return 1; }
    ok "빌드 완료!"
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
    ok "접속 주소: ${C_BOLD}$scheme://localhost:$RISU_PORT${C_RESET}"
    local ip=''
    if has hostname && hostname -I >/dev/null 2>&1; then ip="$(hostname -I | awk '{print $1}')"
    elif has ipconfig; then ip="$(ipconfig getifaddr en0 2>/dev/null || true)"; fi
    [ -n "$ip" ] && info "같은 와이파이의 폰/다른 PC: $scheme://$ip:$RISU_PORT"
    info "처음 접속하면 비밀번호를 정하는 화면이 나옵니다. 잊지 마세요!"
}

start_server() {
    is_risu_repo "$RISU_DIR" || { err "소스가 없습니다. 먼저 설치 마법사를 진행하세요."; return 1; }
    if [ "$RISU_METHOD" = docker ]; then
        if docker_running; then warn "이미 실행 중입니다."; print_urls; return 0; fi
        docker rm -f risuai >/dev/null 2>&1 || true
        local tp=()
        [ -n "$RISU_TRUST_PROXY" ] && tp=(-e "TRUST_PROXY=$RISU_TRUST_PROXY")
        docker run -d --name risuai --restart unless-stopped \
            -p "$RISU_PORT:6001" -v risuai-save:/app/save "${tp[@]+"${tp[@]}"}" risuai-local \
            && ok "Docker 컨테이너를 시작했습니다." && print_urls
        return
    fi
    if server_pid >/dev/null; then warn "이미 실행 중입니다. (PID $(server_pid))"; print_urls; return 0; fi
    if [ ! -d "$RISU_DIR/dist" ]; then
        warn "빌드 결과물이 없습니다. 먼저 빌드합니다."
        do_build || return 1
    fi
    use_nvm_if_present
    run_env
    (cd "$RISU_DIR" && nohup node server/node/server.cjs >>"$(LOG_FILE)" 2>&1 & echo $! >"$(PID_FILE)")
    sleep 2
    if server_pid >/dev/null; then
        ok "서버를 백그라운드에서 시작했습니다. (PID $(server_pid))"
        info "터미널을 닫아도 계속 돌아갑니다. 로그: $(LOG_FILE)"
        print_urls
    else
        err "서버가 바로 종료되었습니다. 마지막 로그:"
        tail -n 20 "$(LOG_FILE)" 2>/dev/null
        return 1
    fi
}

stop_server() {
    if [ "$RISU_METHOD" = docker ]; then
        docker stop risuai >/dev/null 2>&1 && ok "컨테이너를 중지했습니다." || warn "실행 중이 아닙니다."
        return
    fi
    local p
    if p="$(server_pid)"; then
        kill "$p" && rm -f "$(PID_FILE)" && ok "서버를 중지했습니다."
    else
        warn "실행 중인 서버가 없습니다."
    fi
}

show_status() {
    header "서버 상태"
    echo "  설치 위치 : $RISU_DIR"
    echo "  실행 방식 : $RISU_METHOD"
    echo "  포트      : $RISU_PORT"
    echo
    if [ "$RISU_METHOD" = docker ]; then
        docker_running && ok "실행 중 (Docker)" || warn "중지됨"
    else
        server_pid >/dev/null && ok "실행 중 (PID $(server_pid))" || warn "중지됨"
        if [ -f "$(LOG_FILE)" ]; then
            echo; info "최근 로그:"; tail -n 15 "$(LOG_FILE)"
        fi
    fi
}

update_server() {
    header "업데이트"
    has git && [ -d "$RISU_DIR/.git" ] || { err "git 저장소가 아니라 자동 업데이트를 할 수 없습니다."; return 1; }
    info "업데이트 전에 save 폴더를 백업해 두는 것을 추천합니다."
    confirm "먼저 백업할까요?" y && backup_save
    local was_running=0
    { server_pid >/dev/null || docker_running; } && was_running=1
    [ "$was_running" = 1 ] && stop_server
    (cd "$RISU_DIR" && git pull --ff-only) || {
        err "git pull 실패. 소스를 직접 수정했다면 충돌이 났을 수 있습니다."; return 1; }
    do_build || return 1
    [ "$was_running" = 1 ] && start_server
    ok "업데이트 완료!"
}

backup_save() {
    local ts out; ts="$(date +%Y%m%d-%H%M%S)"; out="$RISU_DIR/backup-save-$ts.tar.gz"
    if [ "$RISU_METHOD" = docker ]; then
        docker run --rm -v risuai-save:/save -v "$RISU_DIR":/out alpine \
            tar czf "/out/backup-save-$ts.tar.gz" -C / save || { err "백업 실패"; return 1; }
    else
        [ -d "$RISU_DIR/save" ] || { warn "아직 저장된 데이터가 없습니다."; return 0; }
        tar czf "$out" -C "$RISU_DIR" save || { err "백업 실패"; return 1; }
    fi
    ok "백업 완료: $out"
}

reset_password() {
    header "비밀번호 초기화"
    warn "비밀번호를 지우면 다음 접속 때 새 비밀번호를 정하게 됩니다. 데이터는 지워지지 않습니다."
    confirm "진행할까요?" n || return 0
    if [ "$RISU_METHOD" = docker ]; then
        docker exec risuai rm -f /app/save/__password && docker restart risuai >/dev/null \
            && ok "초기화 완료" || err "실패 (컨테이너가 실행 중인지 확인하세요)"
        return
    fi
    rm -f "$RISU_DIR/save/__password"
    if server_pid >/dev/null; then stop_server; start_server; fi
    ok "초기화 완료"
}

# ---------------------------------------------------------------------------
# 설치 마법사
# ---------------------------------------------------------------------------
wizard() {
    # 1. 실행 방식
    menu "1단계: 실행 방식을 고르세요" \
        "Node.js 로 직접 실행 — 추천, 가장 간단" \
        "Docker 로 실행 — Docker 를 이미 쓰고 있다면"
    case "$MENU_RESULT" in -1) return ;; 0) RISU_METHOD=node ;; 1) RISU_METHOD=docker ;; esac

    # 2. 필수 프로그램
    header "2단계: 필수 프로그램 확인"
    if [ "$RISU_METHOD" = node ]; then
        use_nvm_if_present
        if node_ok; then ok "Node.js $(node -v) 확인"
        else
            warn "알맞은 Node.js 가 없습니다. (필요: 20.19 이상 또는 22.12 이상)"
            if confirm "자동으로 설치할까요?" y; then
                install_node || { err "Node.js 설치 실패. https://nodejs.org 에서 LTS 버전을 직접 설치해 주세요."; pause; return; }
                ok "Node.js $(node -v) 설치 완료"
            else
                info "https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."; pause; return
            fi
        fi
    else
        has docker || { err "Docker 가 없습니다. https://docs.docker.com/get-docker/ 에서 설치해 주세요."; pause; return; }
        docker info >/dev/null 2>&1 || { err "Docker 가 꺼져 있거나 권한이 없습니다. Docker 를 켜고 다시 시도하세요."; pause; return; }
        ok "Docker 확인"
    fi
    sleep 1

    # 3. 소스
    get_source || { pause; return; }
    sleep 1

    # 4. 옵션
    header "3단계: 기본 설정"
    ask "포트 번호 (모르면 엔터)" "$RISU_PORT"
    case "$ASK_RESULT" in *[!0-9]*|'') warn "숫자가 아니라 6001 을 씁니다."; RISU_PORT=6001 ;; *) RISU_PORT="$ASK_RESULT" ;; esac
    echo
    info "개인용으로만 쓰는 서버라면 '법적 고지 설정 완료'를 켜야 경고 화면이 뜨지 않습니다."
    if confirm "나 혼자/지인끼리만 쓰는 개인 서버인가요?" y; then RISU_LEGAL=TRUE; else RISU_LEGAL=FALSE; fi
    echo
    if confirm "실험적 라이트(모바일용 경량) 모드를 켤까요?" n; then RISU_LITE=TRUE; else RISU_LITE=FALSE; fi
    echo
    info "Nginx, Caddy, Cloudflare Tunnel 같은 리버스 프록시 뒤에서 돌릴 때만 켜세요."
    if confirm "리버스 프록시 뒤에서 실행하나요?" n; then RISU_TRUST_PROXY=1; else RISU_TRUST_PROXY=''; fi
    if [ "$RISU_METHOD" = node ]; then
        echo
        info "다른 기기에서 접속하면서 일부 브라우저 기능(마이크 등)이 필요하면 HTTPS 가 필요합니다."
        if confirm "자체 서명 HTTPS 인증서를 만들까요?" n; then RISU_HTTPS=TRUE; gen_cert; else RISU_HTTPS=FALSE; fi
    fi
    echo
    save_conf
    sleep 1

    # 5. 빌드
    header "4단계: 빌드"
    do_build || { pause; return; }

    # 6. 실행
    echo
    if confirm "지금 서버를 실행할까요?" y; then start_server; fi
    echo
    ok "설치가 끝났습니다! 다음부터는 이 스크립트를 다시 실행해 메뉴에서 시작/중지할 수 있습니다."
    pause
}

settings_menu() {
    while true; do
        menu "설정 변경 (변경 후 '다시 빌드'가 필요할 수 있습니다)" \
            "포트: $RISU_PORT" \
            "개인 서버(법적 고지 설정 완료): $RISU_LEGAL  ※ 다시 빌드 필요" \
            "라이트 모드: $RISU_LITE  ※ 다시 빌드 필요" \
            "리버스 프록시 신뢰: ${RISU_TRUST_PROXY:-끔}" \
            "HTTPS 인증서 만들기" \
            "다시 빌드하기" \
            "뒤로"
        case "$MENU_RESULT" in
            0) header "포트"; ask "포트 번호" "$RISU_PORT"
               case "$ASK_RESULT" in *[!0-9]*|'') warn "숫자만 입력하세요."; pause ;; *) RISU_PORT="$ASK_RESULT"; save_conf ;; esac ;;
            1) [ "$RISU_LEGAL" = TRUE ] && RISU_LEGAL=FALSE || RISU_LEGAL=TRUE; save_conf ;;
            2) [ "$RISU_LITE" = TRUE ] && RISU_LITE=FALSE || RISU_LITE=TRUE; save_conf ;;
            3) [ -n "$RISU_TRUST_PROXY" ] && RISU_TRUST_PROXY='' || RISU_TRUST_PROXY=1; save_conf ;;
            4) header "HTTPS"; gen_cert; RISU_HTTPS=TRUE; save_conf; pause ;;
            5) header "다시 빌드"; do_build; pause ;;
            *) return ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# 메인
# ---------------------------------------------------------------------------
main() {
    if [ ! -t 0 ]; then
        err "대화형 터미널에서 실행해 주세요:  bash risu-setup.sh"
        exit 1
    fi
    load_conf
    while true; do
        local state="중지됨"
        if [ "$RISU_METHOD" = docker ]; then docker_running && state="실행 중"
        else server_pid >/dev/null && state="실행 중"; fi
        is_risu_repo "$RISU_DIR" || state="미설치"
        menu "메인 메뉴   (서버: $state)" \
            "처음 설치 마법사  — 처음이면 여기부터!" \
            "서버 시작" \
            "서버 중지" \
            "상태 / 로그 보기" \
            "업데이트 (최신 버전 받기 + 다시 빌드)" \
            "데이터 백업 (save 폴더)" \
            "비밀번호 초기화" \
            "설정 변경" \
            "환경 점검" \
            "종료"
        case "$MENU_RESULT" in
            0) wizard ;;
            1) header "서버 시작"; start_server; pause ;;
            2) header "서버 중지"; stop_server; pause ;;
            3) show_status; pause ;;
            4) update_server; pause ;;
            5) header "백업"; backup_save; pause ;;
            6) reset_password; pause ;;
            7) settings_menu ;;
            8) check_env; pause ;;
            *) clear 2>/dev/null; echo "안녕히 가세요!"; exit 0 ;;
        esac
    done
}

main "$@"
