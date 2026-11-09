// CBS 레퍼런스의 분류표.
// 원본 cbs.ts의 주석 구획은 실제 분류와 맞지 않아서 여기서 사람이 직접 관리한다.
// 원본에 새 함수가 생기면 '미분류'로 들어가고 생성기가 경고를 띄우니, 그때 여기에 추가하면 된다.

/** @type {{ id: string, label: { ko: string, en: string }, names: string[] }[]} */
export const categories = [
    {
        id: 'blocks',
        label: { ko: '블록·제어 문법', en: 'Blocks & control flow' },
        names: ['#when', ':else', '#each', 'slot', '#escape', '#puredisplay', '//', '?', 'declare', 'position', '#if', '#if_pure', '#pure'],
    },
    {
        id: 'character',
        label: { ko: '캐릭터·유저 정보', en: 'Character & user' },
        names: ['char', 'user', 'personality', 'description', 'scenario', 'exampledialogue', 'persona'],
    },
    {
        id: 'prompt',
        label: { ko: '프롬프트·모델', en: 'Prompt & model' },
        names: ['mainprompt', 'jb', 'jbtoggled', 'globalnote', 'authornote', 'lorebook', 'hiddenkey', 'model', 'axmodel', 'maxcontext', 'prefillsupported'],
    },
    {
        id: 'chat',
        label: { ko: '채팅·메시지', en: 'Chat & messages' },
        names: [
            'chatindex', 'firstmsgindex', 'isfirstmsg', 'role', 'lastmessage', 'lastmessageid',
            'previouscharchat', 'previoususerchat', 'previouschatlog', 'history', 'userhistory', 'charhistory',
            'messagetime', 'messagedate', 'messageunixtimearray', 'messageidleduration', 'idleduration',
        ],
    },
    {
        id: 'time',
        label: { ko: '날짜·시간', en: 'Date & time' },
        names: ['date', 'time', 'unixtime', 'isotime', 'isodate'],
    },
    {
        id: 'variables',
        label: { ko: '변수', en: 'Variables' },
        names: ['getvar', 'setvar', 'addvar', 'setdefaultvar', 'getglobalvar', 'tempvar', 'settempvar', 'return'],
    },
    {
        id: 'logic',
        label: { ko: '비교·논리', en: 'Comparison & logic' },
        names: ['equal', 'notequal', 'greater', 'less', 'greaterequal', 'lessequal', 'and', 'or', 'not', 'all', 'any', 'iserror'],
    },
    {
        id: 'math',
        label: { ko: '숫자·수학', en: 'Numbers & math' },
        names: [
            'calc', 'round', 'floor', 'ceil', 'abs', 'remaind', 'pow', 'fixnum', 'tonumber',
            'min', 'max', 'sum', 'average', 'fromhex', 'tohex',
        ],
    },
    {
        id: 'random',
        label: { ko: '난수·주사위', en: 'Random & dice' },
        names: ['random', 'pick', 'randint', 'dice', 'roll', 'rollp', 'hash'],
    },
    {
        id: 'string',
        label: { ko: '문자열', en: 'Strings' },
        names: [
            'length', 'lower', 'upper', 'capitalize', 'trim', 'replace', 'reverse',
            'startswith', 'endswith', 'contains', 'split', 'join', 'spread',
            'unicodeencode', 'unicodedecode', 'u', 'ue', 'xor', 'xordecrypt', 'crypt',
        ],
    },
    {
        id: 'array',
        label: { ko: '배열·객체', en: 'Arrays & objects' },
        names: [
            'makearray', 'makedict', 'range', 'arraylength', 'arrayelement', 'dictelement', 'element',
            'arraypush', 'arraypop', 'arrayshift', 'arraysplice', 'arrayassert', 'objectassert', 'filter',
        ],
    },
    {
        id: 'display',
        label: { ko: '표시·서식', en: 'Display & formatting' },
        names: [
            'br', 'cbr', 'blank', 'comment', 'button', 'risu', 'tex', 'ruby', 'codeblock', 'file', 'bkspc', 'erase',
            'bo', 'bc', 'decbo', 'decbc',
            'displayescapedbracketopen', 'displayescapedbracketclose',
            'displayescapedanglebracketopen', 'displayescapedanglebracketclose',
            'displayescapedcolon', 'displayescapedsemicolon',
        ],
    },
    {
        id: 'assets',
        label: { ko: '에셋', en: 'Assets' },
        names: [
            'asset', 'emotion', 'image', 'img', 'audio', 'bgm', 'bg', 'video', 'video-img',
            'inlay', 'inlayed', 'inlayeddata', 'path', 'source',
            'assetlist', 'emotionlist', 'chardisplayasset', 'moduleassetlist',
        ],
    },
    {
        id: 'system',
        label: { ko: '시스템·환경', en: 'System & environment' },
        names: ['metadata', 'moduleenabled', 'screenwidth', 'screenheight', 'trigger_id'],
    },
];

export const uncategorized = {
    id: 'uncategorized',
    label: { ko: '미분류 (새로 추가됨)', en: 'Uncategorized (newly added)' },
};
